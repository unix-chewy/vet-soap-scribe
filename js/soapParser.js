/**
 * SOAP parsing, normalisation, deduplication, and safety-net enforcement.
 *
 * Pure functions only — no WebLLM, no DOM. Safe to unit-test in isolation.
 */

export const NOT_MENTIONED = '[NOT MENTIONED]';

const SECTION_KEYS = ['S', 'O', 'A', 'P'];

const LABEL_MAP = {
  s: 'S', subjective: 'S', subj: 'S',
  o: 'O', objective: 'O', obj: 'O',
  a: 'A', assessment: 'A',
  p: 'P', plan: 'P',
};

/** Lowercase, collapse all punctuation/whitespace into single spaces. */
export function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** 
 * Strip bullets and labels, capitalize the first letter, and add a period.
 */
export function cleanItem(s) {
  let text = String(s ?? '')
    .replace(/^[-\u2022*\s]+/, '') // Strip bullets
    .replace(/^(plan|assessment|subjective|objective|s|o|a|p)\s*:\s*/i, '') // Strip labels like "plan:"
    .replace(/\s+/g, ' ')
    .trim();

  // Don't alter the placeholder
  if (!text || text === NOT_MENTIONED) return text;

  // Capitalize first letter
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // Ensure it ends with a period (unless it already has punctuation)
  if (!/[.!?]$/.test(text)) {
    text += '.';
  }

  return text;
}

/**
 * Order-independent comparison key, ignoring articles.
 * "Bilateral tartar buildup." and "Tartar buildup bilateral." collide.
 */
export function wordKey(s) {
  return [...new Set(normalize(s).split(' ').filter(Boolean))]
    .filter((w) => !['the', 'a', 'an'].includes(w))
    .sort()
    .join(' ');
}

/** Drop exact duplicates (after normalisation), preserving first occurrence. */
export function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalize(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Convert raw model output into exactly four non-empty arrays of strings.
 * Never throws. A bad answer degrades to [NOT MENTIONED], never a broken page.
 *
 * @param {string} text
 * @returns {{ S: string[], O: string[], A: string[], P: string[] }}
 */
export function parseSOAP(text) {
  const out = { S: [], O: [], A: [], P: [] };
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();

  const parsed = tryExtractJSON(raw);

  if (parsed) {
    // Preferred path: the model honoured the JSON contract.
    for (const [k, v] of Object.entries(parsed)) {
      const target = LABEL_MAP[String(k).toLowerCase()];
      if (!target) continue;
      const items = Array.isArray(v) ? v : String(v ?? '').split(/\n+/);
      out[target] = items.map(cleanItem).filter((i) => i && i !== NOT_MENTIONED);
    }
  } else {
    // Fallback 1: plain "S:\n- ...\nO:\n- ..." text, as described in the spec.
    const labelled = parseLabelledText(raw);
    if (labelled) {
      for (const key of SECTION_KEYS) out[key] = labelled[key];
    } else if (raw) {
      // Fallback 2: unrecognised prose. Keep it visible in S rather than drop it.
      out.S = raw.split(/\n+/).map(cleanItem).filter(Boolean);
    }
  }

  // The model's favourite failure: promoting an Objective finding
  // ("Bilateral tartar buildup.") into the Assessment. Strip those.
  const objectiveKeys = new Set(out.O.map(wordKey));
  out.A = out.A.filter((item) => !objectiveKeys.has(wordKey(item)));

  for (const key of SECTION_KEYS) {
    out[key] = dedupe(out[key]);
    if (!out[key].length) out[key] = [NOT_MENTIONED];
  }

  // Apply safety net before returning
  return enforceRules(out);
}

/**
 * Safety net: moves obvious misclassifications to the right section.
 */
export function enforceRules(soap) {
  // 1. Move Vitals from S or P to O
  const vitalsRegex = /^(temp|hr|rr|weight|bpm|heart rate)\b/i;
  const vitalsInS = soap.S.filter(item => item !== NOT_MENTIONED && vitalsRegex.test(item));
  const vitalsInP = soap.P.filter(item => item !== NOT_MENTIONED && vitalsRegex.test(item));
  
  if (vitalsInS.length || vitalsInP.length) {
    soap.S = soap.S.filter(item => !vitalsRegex.test(item));
    soap.P = soap.P.filter(item => !vitalsRegex.test(item));
    soap.O.push(...vitalsInS, ...vitalsInP);
  }

  // 2. Move treatments/plans from A to P
  const planRegex = /^(needs|start|give|apply|administer|prescribe|plan|do|bloodwork|fluids)\b/i;
  const plansInA = soap.A.filter(item => item !== NOT_MENTIONED && planRegex.test(item));
  
  if (plansInA.length) {
    soap.A = soap.A.filter(item => !planRegex.test(item));
    soap.P.push(...plansInA);
  }

  // 3. Move Diagnoses from P to A
  const diagnosisRegex = /(suspect|diagnosed|consistent with|rule out|otitis|gastroenteritis|uri|ccl)/i;
  const diagInP = soap.P.filter(item => item !== NOT_MENTIONED && diagnosisRegex.test(item));
  
  if (diagInP.length) {
    soap.P = soap.P.filter(item => !diagnosisRegex.test(item));
    if (soap.A[0] === NOT_MENTIONED) soap.A = []; // Clear the placeholder
    soap.A.push(...diagInP);
  }

  // 4. Clean up and dedupe again just in case the moves created duplicates
  for (const key of SECTION_KEYS) {
    soap[key] = dedupe(soap[key]);
    if (!soap[key].length) soap[key] = [NOT_MENTIONED];
  }
  
  return soap;
}

/** Pull the outermost JSON object out of a possibly-annotated string. */
function tryExtractJSON(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const LABEL_LINE = /^\s*(S|O|A|P|Subjective|Objective|Assessment|Plan)\s*[:\-]\s*(.*)$/i;

/** Parse "S:\n- item\n- item\nO:\n..." style plain-text output. */
function parseLabelledText(raw) {
  const out = { S: [], O: [], A: [], P: [] };
  let current = null;
  let found = false;

  for (const line of raw.split(/\r?\n/)) {
    const m = LABEL_LINE.exec(line);
    if (m) {
      const key = LABEL_MAP[m[1].toLowerCase()];
      if (key) {
        found = true;
        current = key;
        const rest = cleanItem(m[2]);
        if (rest && rest !== NOT_MENTIONED) out[key].push(rest);
        continue;
      }
    }
    if (current && line.trim()) {
      const item = cleanItem(line);
      if (item && item !== NOT_MENTIONED) out[current].push(item);
    }
  }

  return found ? out : null;
}