/**
 * Draft-Then-Decode orchestration.
 *
 *   Phase 1  unconstrained draft        "S: ...\nO: ...\nA: ...\nP: ..."
 *   Repair   deterministic line cleanup  (no model call)
 *   Phase 2  constrained re-decode       only when Phase 1 failed
 *   Merge    parseSOAP() -> {S,O,A,P}
 *
 * This module owns the WebLLM calls but not the DOM: `runPipeline` takes an
 * engine object with the same shape as WebLLM's MLCEngine, so the flow can be
 * exercised with a fake engine in tests and a real one in the browser.
 */

import { buildDraftMessages, buildCopyMessages, PHASE1_PARAMS, PHASE2_PARAMS } from './prompts.js';
import { parseSOAP, preclassify, rescueMissingSections, dedupe, NOT_MENTIONED } from './soapParser.js';
import { prepareNotes, batchNotes, budgetRequest, groundSOAP, LIMITS } from './guardrails.js';

/**
 * The only shape a draft line may take. Accepts both the single-letter form we
 * ask for AND the full-word form models habitually emit ("Plan: bloodwork").
 * The single-letter pattern used to silently DROP every "Plan:" line, which
 * deleted the entire Plan section.
 */
const DRAFT_LINE = /^\s*(S|O|A|P|subjective|objective|assessment|plan)\s*:\s*(.+)$/i;

const LABEL_TO_LETTER = {
  s: 'S', subjective: 'S',
  o: 'O', objective: 'O',
  a: 'A', assessment: 'A',
  p: 'P', plan: 'P',
};

const REASONING_MARKERS = /^(notes|input|example|output|draft|reasoning|explanation|analysis|thoughts?)\s*:/i;

/**
 * Deterministic repair of a Phase-1 draft. Never invents content:
 *   - keeps only well-formed "S:/O:/A:/P:" lines
 *   - drops headings, bullets without a letter, and commentary
 *   - cuts at the next "Notes:" / fence / special token (model looping)
 *   - folds a bare "S:" heading line (no fact) into "skip"
 *
 * @param {string} raw
 * @returns {{ lines: string[], ok: boolean, cutShort: boolean }}
 */
export function repairDraft(raw) {
  const text = String(raw ?? '')
    .replace(/<\|[^|>]{1,40}\|>/g, '\n')
    .replace(/```[a-z]*/gi, '\n');

  const lines = [];
  let cutShort = false;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Model started a new example or restarted the task: stop here.
    if (REASONING_MARKERS.test(trimmed)) {
      cutShort = true;
      break;
    }

    // A leading "- " may wrap the line: "- S: foo." or "S: - foo."
    const candidate = trimmed.replace(/^[-*•]\s+/, '');
    const m = DRAFT_LINE.exec(candidate);
    if (!m) continue; // heading / bullet without a letter / prose: drop

    // Strip ONLY a bullet/quote marker. Never digits: "1yo F rabbit" must
    // survive intact (an earlier regex ate the leading "1").
    const content = m[2].trim().replace(/^[-*•"'\s]+/, '');
    if (!content) continue; // bare "S:" heading

    const letter = LABEL_TO_LETTER[m[1].toLowerCase()];
    lines.push(`${letter}: ${content}`);
  }

  // "Usable" means the draft demonstrates the format AND covers more than one
  // section. A short note legitimately has fewer than four lines (e.g. no O
  // or A data), so a line-count threshold would trigger needless Phase 2
  // calls. Mirrors parseSOAP's draftIsUsable().
  const present = draftSections(lines.join('\n'));
  return { lines, text: lines.join('\n'), ok: present.size >= 2, cutShort };
}

/** Sections present in a repaired draft, used to decide if Phase 2 is needed. */
export function draftSections(draftText) {
  const present = new Set();
  for (const line of String(draftText || '').split(/\r?\n/)) {
    const m = DRAFT_LINE.exec(line);
    if (m) present.add(LABEL_TO_LETTER[m[1].toLowerCase()]);
  }
  return present;
}

/**
 * Should we spend a second model call on constrained re-decoding?
 * Only when Phase 1 produced a draft that cannot be trusted as-is.
 */
export function needsPhase2(repaired) {
  return !repaired.ok;
}

/** Normalise engine output to a string regardless of streaming mode. */
function messageText(choice) {
  const message = choice?.message ?? {};
  return message.content ?? message.reasoning_content ?? '';
}

/**
 * One unconstrained generation. Streams when `onToken` is provided so the UI
 * can show progress and the abort controller can stop runaway repetition.
 *
 * @param {object} engine WebLLM engine (or test double)
 * @param {object} opts
 * @param {string} opts.notes
 * @param {(text: string) => void} [opts.onToken]
 * @param {AbortSignal} [opts.signal]
 * @param {(phase: 1|2, state: string) => void} [opts.onProgress]
 */
export async function runDraft(engine, { notes, onToken, signal, onProgress }) {
  signal?.throwIfAborted();
  onProgress?.(1, 'Drafting');
  const messages = buildDraftMessages(notes);
  const { max_tokens } = budgetRequest(messages, PHASE1_PARAMS.max_tokens);
  const stream = await engine.chat.completions.create({
    ...PHASE1_PARAMS,
    messages,
    max_tokens,
    // WebLLM streams as an async iterable when `stream: true`.
  });
  signal?.throwIfAborted();

  let text = '';
  let finishReason = null;
  let grammarInitS = null;

  for await (const chunk of stream) {
    if (signal?.aborted) {
      engine.interruptGenerate?.();
      throw new DOMException('Aborted', 'AbortError');
    }
    const choice = chunk?.choices?.[0];
    if (choice) {
      const delta = choice.delta?.content ?? '';
      if (delta) {
        text += delta;
        const lines = text.trim().split('\n');
        const repeated = lines.length >= 3 && lines.slice(-3).every(line => line === lines.at(-1));
        if (text.length > LIMITS.maxOutputChars || lines.length > LIMITS.maxOutputLines || repeated) {
          engine.interruptGenerate?.();
          text = text.slice(0, LIMITS.maxOutputChars).split('\n').slice(0, LIMITS.maxOutputLines).join('\n');
          finishReason = 'length';
          break;
        }
        onToken?.(text);
      }
      // The trailing chunk carries finish_reason ("stop" | "length").
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    // Usage-only chunks arrive with an empty choices array at the end.
    if (chunk?.usage?.extra?.grammar_init_s != null) {
      grammarInitS = chunk.usage.extra.grammar_init_s;
    }
  }
  signal?.throwIfAborted();
  // Never interpret an unfinished clinical fact as a complete one.
  if (finishReason === 'length') text = text.slice(0, text.lastIndexOf('\n') + 1);
  return { text, finishReason, grammarInitS };
}

/**
 * The constrained Phase-2 call. The grammar only permits
 * "S|O|A|P: <item>." lines, so this can never emit JSON, prose, or a partial
 * object. The model's only job is to copy lines it already wrote.
 */
export async function runConstrained(engine, { notes, draft, onProgress, signal }) {
  signal?.throwIfAborted();
  onProgress?.(2, 'Formatting');
  const messages = buildCopyMessages(notes, draft);
  const { max_tokens } = budgetRequest(messages, PHASE2_PARAMS.max_tokens);
  const reply = await engine.chat.completions.create({
    ...PHASE2_PARAMS,
    messages,
    max_tokens,
  });
  signal?.throwIfAborted();
  let text = messageText(reply.choices?.[0]);
  const cutShort = reply.choices?.[0]?.finish_reason === 'length' || text.length > LIMITS.maxOutputChars;
  text = text.slice(0, LIMITS.maxOutputChars);
  if (cutShort) text = text.slice(0, text.lastIndexOf('\n') + 1);
  return {
    text,
    cutShort,
    grammarInitS: reply.usage?.extra?.grammar_init_s ?? null,
  };
}

/**
 * Full Draft-Then-Decode flow.
 *
 * @returns {Promise<{S:string[],O:string[],A:string[],P:string[], meta: object}>}
 */
async function runBatch(engine, { notes, onToken, onProgress, signal }) {
  const started = performance.now();
  const prefill = preclassify(notes);

  const phase1 = await runDraft(engine, { notes, onToken, signal, onProgress });
  const repaired1 = repairDraft(phase1.text);

  let finalText = repaired1.text;
  let phase2Used = false;
  let grammarInitS = phase1.grammarInitS ?? null;
  let phase2CutShort = false;

  if (needsPhase2(repaired1) && phase1.finishReason !== 'length') {
    onProgress?.(1, 'Formatting');
    try {
      const out = await runConstrained(engine, {
        notes,
        draft: repaired1.text || phase1.text,
        onProgress,
        signal,
      });
      phase2CutShort = out.cutShort;
      if (out.grammarInitS != null) grammarInitS = out.grammarInitS;
      const repaired2 = repairDraft(out.text);
      // Only accept a Phase-2 draft that is at least as complete as what we
      // already had; a one-line constrained reply must not replace a fuller
      // Phase-1 draft.
      if (repaired2.lines.length >= repaired1.lines.length && repaired2.lines.length > 0) {
        finalText = repaired2.text;
        phase2Used = true;
      }
    } catch (err) {
      signal?.throwIfAborted();
      if (err?.name === 'AbortError') throw err;
      // A grammar failure must never lose the Phase-1 result.
      console.warn('Phase 2 failed, falling back to repaired draft:', err);
    }
  }

  const parsed = parseSOAP(finalText, { prefill });
  parsed.meta.rescued = [];
  const grounded = groundSOAP(parsed, notes);

  // Recover sections the model dropped entirely (a truncated draft or a model
  // that simply omitted the Plan), using the deterministic pre-pass.
  const rescued = rescueMissingSections(grounded.soap, prefill, parsed.meta);

  return {
    ...rescued,
    meta: {
      ...parsed.meta,
      phase2Used,
      grammarInitS,
      cutShort: repaired1.cutShort || phase1.finishReason === 'length' || phase2CutShort,
      filteredItems: grounded.removed,
      draftLines: repaired1.lines.length,
      ms: Math.round(performance.now() - started),
    },
  };
}

/** Validate at the model boundary as well as in the UI. Only filtered source
 * notes may seed recovery; callers cannot inject their own unvalidated prefill. */
export async function runPipeline(engine, { notes, onToken, onProgress, signal }) {
  signal?.throwIfAborted();
  const started = performance.now();
  const prepared = prepareNotes(notes);
  const batches = batchNotes(prepared.notes);
  const interrupt = () => engine.interruptGenerate?.();
  signal?.addEventListener('abort', interrupt, { once: true });
  const merged = { S: [], O: [], A: [], P: [] };
  const meta = { moved: [], rescued: [], phase2Used: false, cutShort: false, filteredItems: 0, draftLines: 0, batches: batches.length, excludedFragments: prepared.excluded.length };
  try {
    for (let i = 0; i < batches.length; i++) {
      signal?.throwIfAborted();
      onProgress?.(1, `Drafting batch ${i + 1} of ${batches.length}`);
      const result = await runBatch(engine, { notes: batches[i], onToken, onProgress, signal });
      for (const key of ['S', 'O', 'A', 'P']) merged[key].push(...result[key].filter(item => item !== NOT_MENTIONED));
      meta.moved.push(...result.meta.moved);
      meta.rescued.push(...result.meta.rescued);
      meta.phase2Used ||= result.meta.phase2Used;
      meta.cutShort ||= result.meta.cutShort;
      meta.filteredItems += result.meta.filteredItems;
      meta.draftLines += result.meta.draftLines;
      meta.source = result.meta.source;
      meta.grammarInitS = result.meta.grammarInitS;
    }
    signal?.throwIfAborted();
    for (const key of ['S', 'O', 'A', 'P']) {
      merged[key] = dedupe(merged[key]);
      if (!merged[key].length) merged[key] = [NOT_MENTIONED];
    }
    meta.rescued = [...new Set(meta.rescued)];
    meta.ms = Math.round(performance.now() - started);
    return { ...merged, meta };
  } finally {
    signal?.removeEventListener('abort', interrupt);
  }
}
