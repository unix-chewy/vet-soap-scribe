/**
 * Prompt and grammar definitions for the Draft-Then-Decode pipeline.
 *
 * Rules of the house:
 *   - Phase 1 is UNCONSTRAINED. Extraction demand is not competing with formatting.
 *   - Phase 2 is CONSTRAINED to a tiny line grammar, so a sub-1B model is only
 *     ever asked to copy lines it just produced, never to compose JSON.
 *   - Short, rule-based prompts beat verbose ones on SLMs. Keep the system
 *     prompt well under 1,000 characters.
 *
 * Pure data + tiny builders only, so this module is importable in Node tests.
 */

export const SECTION_KEYS = /** @type {const} */ (['S', 'O', 'A', 'P']);

/**
 * Phase-1 system prompt. 419 characters on its own; 637 with the one-shot
 * below appended. Deliberately terse: every token spent on instructions is a
 * token a 360M model cannot spend on the note itself.
 */
export const SYSTEM_DRAFT = `Extract SOAP. Copy facts; do not add or change them.
S: signalment, history, signs the owner reports.
O: vitals and exam findings found by the vet.
A: diagnosis or problem list only.
P: tests, drugs, treatments, monitoring, recheck.
One fact per line: letter + colon + one fact. Split separate facts onto separate lines.
Rules: no JSON, no headings, no bullets. no comments or reasoning. end each line with a period. If a section has no facts, write nothing for it.`;

/**
 * One-shot, appended to the Phase-1 system message. The example input is
 * purpose-built (not a copy of sample.txt) so it never teaches the model to
 * regurgitate a fixture. It demonstrates: multi-fact splitting, the
 * "Plan:" prefix disappearing, and one fact per line.
 */
export const ONESHOT = `
Notes:
5yo F golden retriever. Vomiting 3 days, not eating since yesterday. Lethargic. Temp 39.5. Abdomen tense, pain on palpation. Owner gave human omeprazole but didn't help. No diarrhea. Heart rate 120. Suspect gastroenteritis. Plan: bloodwork, subcutaneous fluids, anti-nausea injection.
Draft:
S: 5yo F golden retriever.
S: Vomiting 3 days, not eating since yesterday.
S: Lethargic.
S: Owner gave human omeprazole but didn't help.
S: No diarrhea.
O: Temp 39.5.
O: Abdomen tense, pain on palpation.
O: Heart rate 120.
A: Suspect gastroenteritis.
P: Bloodwork.
P: Subcutaneous fluids.
P: Anti-nausea injection.`;

/** Phase-2 system prompt: copy verbatim, never re-derive. */
export const SYSTEM_COPY = `Copy the draft lines exactly. Keep each line's letter. Change nothing else. No new lines. Stop when the draft ends.`;

/**
 * Phase-2 constrained decoding grammar (EBNF as accepted by WebLLM's
 * response_format: { type: 'grammar' }). Every token the model is allowed to
 * emit starts a draft line, so partial JSON or prose is unreachable.
 *
 *   root ::= line+
 *   line ::= tag ":" item "\n"?
 *   tag  ::= "S" | "O" | "A" | "P"
 *   item ::= [^ "\n\r:#]+ ((" " | ":" | "#") [^ "\n\r:#]+)* "."
 *
 * These initial tokens all exist as single tokens in the SmolLM2 and Qwen2.5
 * BPE vocabularies, so the grammar never starts on an unreachable token.
 */
export const DRAFT_LINE_GRAMMAR = `root ::= line+
line ::= tag ":" item "\\n"?
tag ::= "S" | "O" | "A" | "P"
item ::= [^ "\\n\\r:#]+ ((" " | ":" | "#") [^ "\\n\\r:#]+)* "."`;

/** Message builders. Keeping them here means the tests can snapshot them. */

export function buildDraftMessages(notes) {
  return [
    { role: 'system', content: `${SYSTEM_DRAFT}\n${ONESHOT}` },
    { role: 'user', content: `Notes:\n${notes}\n\nDraft:` },
  ];
}

export function buildCopyMessages(notes, draft) {
  return [
    { role: 'system', content: SYSTEM_COPY },
    { role: 'user', content: `Notes:\n${notes}\n\nDraft:\n${draft}` },
  ];
}

/** Sampling knobs shared by both phases. */
export const PHASE1_PARAMS = {
  temperature: 0,
  top_p: 1,
  max_tokens: 512,
  stop: ['\nNotes:'],
  stream: true,
};

export const PHASE2_PARAMS = {
  temperature: 0,
  top_p: 1,
  max_tokens: 512,
  response_format: { type: 'grammar', grammar: DRAFT_LINE_GRAMMAR },
};
