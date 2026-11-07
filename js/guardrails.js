import { classifyItem, cleanItem, NOT_MENTIONED, splitFragments, splitCompoundItem } from './soapParser.js';
import { buildDraftMessages } from './prompts.js';

export const LIMITS = Object.freeze({
  maxNoteChars: 1500,
  contextWindow: 1024,
  maxOutputTokens: 256,
  maxOutputChars: 2048,
  maxOutputLines: 32,
});

export class GuardrailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GuardrailError';
  }
}

// Deliberately conservative English clinical-note heuristics, not a semantic classifier.
const INSTRUCTION = /\b(ignore|disregard|override|forget)\b.{0,40}\b(instructions?|rules?|prompts?|above|previous|system)\b|\b(system prompt|act as|you are now|instead output|jailbreak)\b|\b(write|generate|compose|tell me|explain|translate|summarize|answer)\b.{0,60}\b(poem|story|joke|code|python|javascript|essay|recipe|politic|song|instructions?|prompt)\b|\b(capital of|stock market|bitcoin|football scores?)\b|<\|[^>]*\|>|\[INST\]/i;
const CHAT_REQUEST = /^(?:please\s+)?(?:give me|tell me|can you|could you|write|compose|generate|what is|what are|who is|how do|how can|why is)\b/i;
const ANIMAL = /\b(dog|cat|canine|feline|puppy|kitten|pug|retriever|labrador|shepherd|terrier|poodle|bulldog|beagle|husky|chihuahua|dachshund|shorthair|longhair|siamese|persian|rabbit|bunny|horse|equine|pony|foal|cow|bovine|calf|goat|sheep|porcine|pig|bird|avian|parrot|chicken|hamster|guinea pig|ferret|reptile|turtle|snake|lizard)\b|\b\d+\s*(yo|y\/o|years? old|yrs?|months? old|mo|weeks? old|wk)\b/i;
const CLINICAL = /\b(bar|qar|nad|wnl|dsh|dlh|mn|fs|m\/n|f\/s|healthy|vaccin\w*|eats?|poop|stool|urine|urina\w*|defecat\w*|normal|abnormal|bleed\w*|wound\w*|trauma|injur\w*|discharge|respirat\w*|dyspn\w*|anorex\w*|emesis|v\/?d|polydips\w*|polyuri\w*|tachy\w*|brady\w*|capillary|refill|spo2|bp|sbp|dbp|bpm|mg|ml|bid|tid|sid|qid|prn|q\d+h|negative|positive|test|result|oral|fracture|pregnan\w*|gestat\w*|behavio\w*|medication|dose|dosage|prognosis)\b/i;
const METADATA = /^(patient|name|species|breed|age|sex|date|visit|chief complaint|cc|history|hx|signalment|s|o|a|p)\s*:/i;

export function prepareNotes(value) {
  if (typeof value !== 'string' || !value.trim()) throw new GuardrailError('Enter veterinary clinical notes first.');
  if (value.length > LIMITS.maxNoteChars) throw new GuardrailError(`Shorten the note to ${LIMITS.maxNoteChars} characters or split it into separate cases. Nothing was trimmed.`);
  const kept = [];
  const excluded = [];
  for (const fragment of splitFragments(value)) {
    if (!INSTRUCTION.test(fragment) && !CHAT_REQUEST.test(fragment) && (ANIMAL.test(fragment) || CLINICAL.test(fragment) || METADATA.test(fragment) || classifyItem(fragment).section)) {
      kept.push(fragment);
    } else {
      excluded.push(fragment);
    }
  }
  if (!kept.length || (excluded.length && !kept.some(fragment => CLINICAL.test(fragment) || classifyItem(fragment).section))) throw new GuardrailError('Enter veterinary clinical case notes. Unrelated requests and model instructions are not supported.');
  return { notes: kept.join('\n'), excluded };
}

/** UTF-8 bytes are a conservative content-token estimate for these byte-fallback
 * tokenizers. Reserve extra tokens for the chat template and tokenizer boundaries.
 * This is not an exact tokenizer count; the engine remains the final authority. */
export function budgetRequest(messages, maxTokens = LIMITS.maxOutputTokens) {
  const encoder = new TextEncoder();
  const estimatedPromptTokens = 96 + messages.reduce((total, message) => total + 16 + encoder.encode(message.content).length, 0);
  if (estimatedPromptTokens + maxTokens > LIMITS.contextWindow) {
    throw new GuardrailError('This fact is too long for the model context. Shorten it or split it into smaller sentences. Nothing was trimmed.');
  }
  return { max_tokens: maxTokens, estimatedPromptTokens };
}

export function batchNotes(notes) {
  const batches = [];
  let current = '';
  for (const fragment of splitFragments(notes)) {
    const candidate = current ? `${current}\n${fragment}` : fragment;
    try {
      budgetRequest(buildDraftMessages(candidate));
      current = candidate;
    } catch (error) {
      if (!(error instanceof GuardrailError)) throw error;
      if (current) batches.push(current);
      budgetRequest(buildDraftMessages(fragment));
      current = fragment;
    }
  }
  if (current) batches.push(current);
  return batches;
}

// Compare complete source facts, preserving decimals, negation, and word order.
// Rejecting a paraphrase is preferable to accepting an invented clinical fact;
// the deterministic recovery pass will retain the original source text.
function factKey(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .replace(/^(subjective|objective|assessment|plan|s|o|a|p)\s*:\s*/i, '')
    .replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
}

export function groundSOAP(soap, notes) {
  const source = new Set(splitFragments(notes).flatMap(fragment => splitCompoundItem(fragment.replace(/^(plan|assessment|subjective|objective|s|o|a|p)\s*:\s*/i, ''))).map(cleanItem).map(factKey));
  let removed = 0;
  const grounded = {};
  for (const key of ['S', 'O', 'A', 'P']) {
    grounded[key] = (soap[key] || []).filter(item => {
      if (item === NOT_MENTIONED) return false;
      if (source.has(factKey(item))) return true;
      removed++;
      return false;
    });
    if (!grounded[key].length) grounded[key] = [NOT_MENTIONED];
  }
  return { soap: grounded, removed };
}
