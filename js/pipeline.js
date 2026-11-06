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
import { parseSOAP, rescueMissingSections } from './soapParser.js';

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
  onProgress?.(1, 'Drafting');
  const stream = await engine.chat.completions.create({
    ...PHASE1_PARAMS,
    messages: buildDraftMessages(notes),
    // WebLLM streams as an async iterable when `stream: true`.
  });

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

  return { text, finishReason, grammarInitS };
}

/**
 * The constrained Phase-2 call. The grammar only permits
 * "S|O|A|P: <item>." lines, so this can never emit JSON, prose, or a partial
 * object. The model's only job is to copy lines it already wrote.
 */
export async function runConstrained(engine, { notes, draft, onProgress }) {
  onProgress?.(2, 'Formatting');
  const reply = await engine.chat.completions.create({
    ...PHASE2_PARAMS,
    messages: buildCopyMessages(notes, draft),
  });
  return {
    text: messageText(reply.choices?.[0]),
    grammarInitS: reply.usage?.extra?.grammar_init_s ?? null,
  };
}

/**
 * Full Draft-Then-Decode flow.
 *
 * @returns {Promise<{S:string[],O:string[],A:string[],P:string[], meta: object}>}
 */
export async function runPipeline(engine, { notes, onToken, onProgress, signal, prefill }) {
  const started = performance.now();

  const phase1 = await runDraft(engine, { notes, onToken, signal, onProgress });
  const repaired1 = repairDraft(phase1.text);

  let finalText = repaired1.text;
  let phase2Used = false;
  let grammarInitS = phase1.grammarInitS ?? null;

  if (needsPhase2(repaired1)) {
    onProgress?.(1, 'Formatting');
    try {
      const out = await runConstrained(engine, {
        notes,
        draft: repaired1.text || phase1.text,
        onProgress,
      });
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
      // A grammar failure must never lose the Phase-1 result.
      console.warn('Phase 2 failed, falling back to repaired draft:', err);
    }
  }

  const parsed = parseSOAP(finalText, { prefill });
  parsed.meta.rescued = [];

  // Recover sections the model dropped entirely (a truncated draft or a model
  // that simply omitted the Plan), using the deterministic pre-pass.
  const rescued = rescueMissingSections(parsed, prefill, parsed.meta);

  return {
    ...rescued,
    meta: {
      ...parsed.meta,
      phase2Used,
      grammarInitS,
      cutShort: repaired1.cutShort || phase1.finishReason === 'length',
      draftLines: repaired1.lines.length,
      ms: Math.round(performance.now() - started),
    },
  };
}
