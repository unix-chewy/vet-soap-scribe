export const NOT_MENTIONED = '[NOT MENTIONED]';

const SECTION_KEYS = ['S', 'O', 'A', 'P'];

const LABEL_MAP = {
  s: 'S', subjective: 'S', subj: 'S',
  o: 'O', objective: 'O', obj: 'O',
  a: 'A', assessment: 'A', assess: 'A',
  p: 'P', plan: 'P', planning: 'P',
};

const LABEL_STRIP = /^(plan|assessment|assess|subjective|objective|s|o|a|p)\s*:\s*/i;
const SPECIAL_TOKEN = /<\|[^|>]{1,40}\|>/g;
const EOS_TOKEN = /<\|im_end\|>|<\|eot_id\|>|<\|end▁of▁sentence\|>|<\|endoftext\|>|<end_of_turn>|<eos>/g;
export function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function stripSpecialTokens(s) {
  const text = String(s ?? '');
  const stop = text.search(EOS_TOKEN);
  const cut = stop === -1 ? text : text.slice(0, stop);
  return cut.replace(SPECIAL_TOKEN, ' ');
}

export function cleanItem(s) {
  let text = stripSpecialTokens(s)
    .replace(/^[-\u2022*\s]+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(LABEL_STRIP, '')
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || normalize(text) === normalize(NOT_MENTIONED)) return '';

  text = text.charAt(0).toUpperCase() + text.slice(1);

  if (/[,;\s]$/.test(text) || !/[.!?]$/.test(text)) {
    text = text.replace(/[,;\s]+$/, '');
    text += '.';
  }
  return text;
}

export function dedupe(items) {
  const seen = new Set();
  const normalizedItems = items.map(i => normalize(i));
  
  return items.filter((item, index) => {
    const key = normalizedItems[index];
    if (!key || seen.has(key)) return false;
    
    // NEW: Check if this exact item is just a substring of an adjacent item (prevents double-listing)
    for (let i = 0; i < items.length; i++) {
        if (i !== index && normalizedItems[i].includes(key) && normalizedItems[i].length > key.length) {
            return false; // Drop the shorter substring
        }
    }

    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// EXPANDED CLINICAL DICTIONARY RULES
// ---------------------------------------------------------------------------

const RULES = [
  // 1. S: owner-reported / history / symptoms
  {
    id: 'owner-reported',
    section: 'S',
    re: /\b(owner|client|o\/r|reports?|reported|states?|history of|hx of|according to)\b|\b(vomit\w*|letharg\w*|diarrhea|appetite|eating|drinking|gave|at home|not eating|refusing|scratching|limping|sneez\w*|cough\w*|itch\w*|seizure\w*|shaking|tremor\w*|worse|better|night|morning|yellow fluid|partially digested food|episodes?)\b/i,
  },

  // 2. O: vitals (numeric)
  {
    id: 'vitals',
    section: 'O',
    re: /\b(temp|temperature|fever|t)\b\s*[:=]?\s*\d|\b(hr|heart rate|pulse|rr|resp(iratory)? rate|respiration)\b\s*[:=]?\s*\d|\b(weight|bw|body weight|bcs)\b\s*[:=]?\s*\d|\b\d{2}(\.\d)?\s*(°\s*)?c\b|\b\d+\s*(kg|lbs?|pounds?)\b/i,
  },

  // 3. A: Diagnosis / Problem List
  {
    id: 'diagnosis',
    section: 'A',
    re: /^(suspect(ed)?|dx|diagnosis|r\/o|rule out|consistent with|presumptive|likely|most likely|ddx|problems?)\b|\b(diagnosed with|diagnosis of|gastroenteritis|pancreatitis|otitis|uri|uti|dermatitis|infection|fracture|allergy|ccl|parvo|heartworm|lyme|kennel cough|arthritis|tumor|cancer|neoplasia)\b/i,
  },

  // 4. P: Plan / Treatment / Procedures
  {
    id: 'plan',
    section: 'P',
    re: /\b(plan|tx|treat(ment)?|therapy|administer|prescrib\w*|dispense\w*|inject\w*|bloodwork|blood work|cbc|chem(istry)?|c\/s|urinalysis|faecal|fecal|x-?rays?|radiograph\w*|ultrasound|ecg|recheck|follow[ -]?up|monitor\w*|hospitali[sz]\w*|admit(ted)?|euthanasi[sz]\w*|give|giving|gave|start|begin|continue|fluid\w*|surgery|dental|cleaning|neuter|spay|medication|meds|antibiotic\w*|nsaid\w*|iv|sq|po|im|fast\w*)\b/i,
  },

  // 5. O: Exam findings (vitals + physical exam)
  {
    id: 'exam-finding',
    section: 'O',
    re: /\b(abdomen|abdominal|lungs?|gums?|mm|mucous membranes?|crt|lymph nodes?|ears?|eyes?|throat|oral exam|auscult\w*|palpat\w*|dehydrat\w*|pain\w*|murmurs?|heart sounds|tartar|halitosis|masses?|nodules?|tegument|skin|ocular|nose|nasal|gingiv\w*|plaque|calculus|icterus|jaundice|cyanotic|thin|rectal|gait|hoof|limb|joint|mobility|lameness|shaking|tremor|tense|swelling|redness|erythema|obese|overweight|pale)\b/i,
  },
];

const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r.re]));
const ABBREVIATION = /(?:^|\s)(?:dr|mr|mrs|ms|prof|vs|e\.g|i\.e|approx|incl|dx|tx|hx|fx|sx)\.$/i;
const SIGNALMENT_CUE = /^\d+\s*(yo|yr|yrs?|y|mo|wk)\b/;

export function classifyItem(item) {
  const text = normalize(item.replace(/^["'`]+|["'`]+$/g, ''));
  if (!text) return { section: null, rule: null };

  for (const rule of RULES) {
    if (!rule.re.test(text)) continue;

    if (rule.section === 'P' && (RULES_BY_ID.get('owner-reported').test(text) || SIGNALMENT_CUE.test(text))) {
      continue;
    }

    return { section: rule.section, rule: rule.id };
  }
  return { section: null, rule: null };
}

export function enforceRules(soap, meta) {
  const out = { S: [], O: [], A: [], P: [] };

  for (const from of SECTION_KEYS) {
    for (const item of soap[from] || []) {
      if (item === NOT_MENTIONED) continue;
      const { section, rule } = classifyItem(item);

      if (!section || section === from) {
        out[from].push(item);
        continue;
      }
      out[section].push(item);
      if (meta) meta.moved.push({ from, to: section, item, rule });
    }
  }

  for (const key of SECTION_KEYS) {
    out[key] = dedupe(out[key]);
    if (!out[key].length) out[key] = [NOT_MENTIONED];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing Logic
// ---------------------------------------------------------------------------

function tryExtractJSON(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function repairTruncatedJSON(raw) {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let text = raw.slice(start).replace(/[,\s]*$/, '');
  if (!text) return null;

  const stack = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (inString) text += '"';
  text = text.replace(/[,\s]*$/, '');
  while (stack.length) text += stack.pop();

  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function coerceValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(coerceValue).join(' ');
  try { return Object.values(v).map(coerceValue).join(' '); } catch { return ''; }
}

const LABEL_LINE = /^\s*(S|O|A|P|Subjective|Objective|Assessment|Plan)\s*[:\-]\s*(.*)$/i;

export function parseDraftLines(raw) {
  const out = { S: [], O: [], A: [], P: [] };
  let found = false;

  for (const line of stripSpecialTokens(raw).split(/\r?\n/)) {
    const m = LABEL_LINE.exec(line);
    if (m) {
      const key = LABEL_MAP[m[1].toLowerCase()];
      const rest = cleanItem(m[2]);
      if (rest) {
        found = true;
        out[key].push(rest);
      }
    }
  }
  return found ? out : null;
}

export function splitFragments(raw) {
  return stripSpecialTokens(raw)
    .split(/\r?\n|;/)
    .flatMap((chunk) => chunk.split(/(?<=[.!?])\s+(?=[A-Z])/))
    .map((f) => f.trim())
    .filter((f) => f && /[a-z]/i.test(f));
}

export function splitCompoundItem(item) {
  const text = String(item ?? '').trim();
  if (!text) return [];

  let pieces = text.split(/(?<=[.!?])\s+(?=[A-Z("'])/).map((p) => p.trim()).filter(Boolean);
  
  if (pieces.length === 1 && text.split(',').length > 1 && text.length < 300) {
      pieces = text.split(/,\s*/).map(p => p.trim()).filter(Boolean);
  }

  if (pieces.length < 2) return [text];
  if (pieces.length > 20) return [text];

  const merged = [pieces[0]];
  for (let i = 1; i < pieces.length; i += 1) {
    const prev = merged[merged.length - 1];
    if (ABBREVIATION.test(prev)) merged[merged.length - 1] = `${prev} ${pieces[i]}`;
    else merged.push(pieces[i]);
  }
  return merged;
}

function expandCompoundItems(soap) {
  const out = { S: [], O: [], A: [], P: [] };
  for (const key of SECTION_KEYS) {
    for (const item of soap[key] || []) out[key].push(...splitCompoundItem(item));
  }
  return out;
}

export function preclassify(notes) {
  const out = { S: [], O: [], A: [], P: [] };
  for (const frag of splitFragments(notes)) {
    const text = frag.replace(/^(plan|assessment|subjective|objective)\s*:\s*/i, '');
    for (const piece of splitCompoundItem(text)) {
      const cleaned = cleanItem(piece);
      if (!cleaned) continue;
      const { section } = classifyItem(cleaned);
      out[section || 'S'].push(cleaned);
    }
  }
  for (const key of SECTION_KEYS) out[key] = dedupe(out[key]);
  return out;
}

function classifyLooseText(raw) {
  return preclassify(raw);
}

function draftIsUsable(draft) {
  const nonEmpty = SECTION_KEYS.filter((k) => draft[k].length > 0);
  return nonEmpty.length >= 2;
}

export function parseSOAP(text, opts = {}) {
  const raw = String(text || '');
  const out = { S: [], O: [], A: [], P: [] };
  const meta = { source: 'empty', moved: [], draftOk: false };

  const stripped = stripSpecialTokens(raw).replace(/```(?:json)?/gi, '').trim();

  const json = tryExtractJSON(stripped) || repairTruncatedJSON(stripped);
  if (json) {
    meta.source = 'json';
    for (const [k, v] of Object.entries(json)) {
      const target = LABEL_MAP[String(k).toLowerCase()];
      if (!target) continue;
      const items = Array.isArray(v) ? v : String(coerceValue(v) ?? '').split(/\n+/);
      out[target] = items.map(coerceValue).map(cleanItem).filter(Boolean);
    }
  } else {
    const labelled = parseDraftLines(stripped);
    if (labelled) {
      meta.source = 'lines';
      Object.assign(out, labelled);
    } else if (stripped) {
      meta.source = 'loose';
      Object.assign(out, classifyLooseText(stripped));
    } else if (opts.prefill) {
      meta.source = 'prefill';
      Object.assign(out, opts.prefill);
    }
  }

  meta.draftOk = draftIsUsable(out);
  
  // Apply enforceRules, then format every single item one last time
  const enforced = enforceRules(expandCompoundItems(out), meta);
  for (const key of SECTION_KEYS) {
      enforced[key] = enforced[key].map(cleanItem).filter(Boolean);
      if (!enforced[key].length) enforced[key] = [NOT_MENTIONED];
  }
  
  return { ...enforced, meta };
}

export function rescueMissingSections(soap, prefill, meta) {
  if (!prefill) return soap;

  const out = { S: [...soap.S], O: [...soap.O], A: [...soap.A], P: [...soap.P] };
  const present = new Set(
    SECTION_KEYS.flatMap((k) => out[k].filter((i) => i !== NOT_MENTIONED).map((i) => normalize(i))),
  );

  for (const key of SECTION_KEYS) {
    // Find items in the deterministic prefill that are completely missing from the model's output
    const candidates = (prefill[key] || []).filter((i) => i && i !== NOT_MENTIONED && !present.has(normalize(i)));
    if (!candidates.length) continue;

    // If the section is currently just [NOT MENTIONED], clear it first
    if (out[key].length === 1 && out[key][0] === NOT_MENTIONED) {
      out[key] = [];
    }

    // Add the missing items back in
    out[key].push(...candidates);
    for (const c of candidates) present.add(normalize(c));
    if (meta) meta.rescued.push(key);
  }

  for (const key of SECTION_KEYS) {
    out[key] = dedupe(out[key]);
    if (!out[key].length) out[key] = [NOT_MENTIONED];
  }
  return out;
}

export function renderPlainText(soap, opts = {}) {
  return SECTION_KEYS
    .map((key) => {
      const items = (soap[key] || []).filter((i) => i !== NOT_MENTIONED || !opts.skipEmpty);
      return `${key}:\n${items.map((i) => `- ${i}`).join('\n')}`;
    })
    .join('\n\n');
}