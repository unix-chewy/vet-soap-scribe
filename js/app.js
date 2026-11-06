import { CreateWebWorkerMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
import { parseSOAP, preclassify, renderPlainText, NOT_MENTIONED } from "./soapParser.js";
import { runPipeline } from "./pipeline.js";

// ---- Model choice ---------------------------------------------------------
// Total download is what matters on a phone, not parameter count:
//   Qwen2.5-0.5B q4f16_1 -> ~290 MB on disk, 32k native context
//   SmolLM2-360M q4f16_1 -> ~207 MB on disk, 4k context
//   Gemma3-1B-it q4f16_1 -> ~290 MB on disk, 8k context, instruction-tuned
// The fallback is only used after an explicit load failure (OOM / device loss).
const MODELS = {
  primary: 'gemma3-1b-it-q4f16_1-MLC',
  fallback: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
};

// ---- DOM references -------------------------------------------------------
const $ = (id) => document.getElementById(id);

const rawNotes = $('rawNotes');
const generateBtn = $('generateBtn');
const stopBtn = $('stopBtn');
const statusEl = $('status');
const progressWrap = $('progressWrap');
const progressBar = $('progressBar');
const inputSection = $('inputSection');
const outputSection = $('outputSection');
const nextBtn = $('nextBtn');
const finalActions = $('finalActions');
const noticeEl = $('notice');
const metaEl = $('meta');

// ---- State ----------------------------------------------------------------
let engine = null;
let initPromise = null;
let busy = false;
let currentStep = 1;
let soapData = { S: [], O: [], A: [], P: [] };
let soapMeta = null;
let abortController = null;

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setProgress(ratio) {
  if (ratio > 0 && ratio < 1 && progressWrap) {
    progressWrap.classList.remove('hidden');
    progressBar.style.width = `${Math.round(ratio * 100)}%`;
  } else if (progressWrap) {
    progressWrap.classList.add('hidden');
    progressBar.style.width = '0%';
  }
}

function showNotice(msg) {
  if (!noticeEl) return;
  noticeEl.textContent = msg;
  noticeEl.classList.toggle('hidden', !msg);
}

/** Keep the model text intact (never innerHTML with model output). */
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- Engine bootstrap -----------------------------------------------------
async function initEngine() {
  if (engine) return engine;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported on this device. Use Chrome on Android or iOS 26+.");
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Could not request WebGPU adapter.");
    }

    const maxBuffer = adapter.limits?.maxStorageBufferBindingSize ?? 0;
    console.log(`GPU: ${adapter.info?.vendor ?? 'unknown'}, maxBuffer: ${maxBuffer}`);

    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

    const load = (modelId) =>
      CreateWebWorkerMLCEngine(worker, modelId, {
        initProgressCallback: (report) => {
          setStatus(report.text);
          // report.progress is 0..1 for downloads and shard loading
          if (typeof report.progress === 'number') setProgress(report.progress);
        },
      });

    try {
      return await load(MODELS.primary);
    } catch (err) {
      console.warn(`Primary model failed to load, trying fallback.`, err);
      setStatus('Primary model failed, loading smaller model...');
      return await load(MODELS.fallback);
    }
  })();

  try {
    engine = await initPromise;
    setProgress(0);
    return engine;
  } catch (err) {
    initPromise = null;
    setProgress(0);
    throw err;
  }
}

// ---- Main flow ------------------------------------------------------------
async function generate() {
  if (busy) return;

  const notes = rawNotes.value.trim();
  if (!notes) return;

  busy = true;
  abortController = new AbortController();
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="spinner"></span> Processing...';
  setProgress(0);
  if (stopBtn) {
    stopBtn.classList.remove('hidden');
    stopBtn.onclick = () => abortController?.abort();
  }
  showNotice('');

  try {
    if (!engine) {
      setStatus("Loading Model...");
      await initEngine();
    }
    if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    // Deterministic fallback computed before the model runs. Used only if the
    // model never produced a usable draft.
    const prefill = preclassify(notes);

    setStatus("Drafting SOAP sections...");
    const result = await runPipeline(engine, {
      notes,
      prefill,
      signal: abortController.signal,
      onToken: (text) => {
        const lines = (text.match(/\n/g) || []).length + 1;
        setStatus(`Drafting... ${lines} line${lines === 1 ? '' : 's'}`);
      },
      onProgress: (phase, state) => {
        if (phase === 2) setStatus(`${state} (constrained decode)...`);
      },
    });

    soapData = { S: result.S, O: result.O, A: result.A, P: result.P };
    soapMeta = result.meta;

    for (const key of ['S', 'O', 'A', 'P']) {
      $(`list-${key}`).innerHTML = soapData[key].map(renderItem).join('');
    }

    renderMeta(soapMeta);
    inputSection.classList.add('hidden');
    outputSection.classList.remove('hidden');
    showStep(1);
    setStatus(`Done in ${(soapMeta.ms / 1000).toFixed(1)}s.`);
  } catch (err) {
    if (err?.name === 'AbortError') {
      setStatus('Stopped.');
      showNotice('');
    } else {
      console.error("Full Error Object:", err);
      const msg = String(err?.message || err || 'Unknown error');
      if (/ContextWindowSizeExceeded|context window/i.test(msg)) {
        showNotice('Note trimmed: it was longer than the model\'s context window. Split it into smaller notes.');
        setStatus('Note too long for this model.');
      } else {
        setStatus(`Error: ${msg}`);
      }
    }
  } finally {
    busy = false;
    abortController = null;
    if (stopBtn) stopBtn.classList.add('hidden');
    generateBtn.textContent = "Generate SOAP Note";
    generateBtn.disabled = !rawNotes.value.trim();
  }
}

// ---- Rendering ------------------------------------------------------------
function renderItem(item) {
  if (item === NOT_MENTIONED) {
    return `<li class="not-mentioned">${NOT_MENTIONED}</li>`;
  }
  return `<li>${escapeHtml(item)}</li>`;
}

function renderMeta(meta) {
  if (!metaEl) return;

  const bits = [];
  bits.push(soapMeta.phase2Used ? 'formatted by constrained decode' : 'draft accepted as-is');

  const moves = meta.moved || [];
  if (moves.length) {
    bits.push(`${moves.length} item${moves.length === 1 ? '' : 's'} auto-corrected`);
  }

  // Sections the model dropped entirely and the deterministic pass recovered.
  const rescued = meta.rescued || [];
  if (rescued.length) {
    bits.push(`${rescued.join('/')} recovered from notes — review`);
  }

  if (meta.source === 'loose' || meta.source === 'prefill') {
    bits.push('classified heuristically — review before saving');
  }
  if (meta.cutShort) bits.push('output was cut short');
  if (meta.grammarInitS != null) bits.push(`grammar init ${meta.grammarInitS.toFixed(2)}s`);

  metaEl.textContent = bits.join(' · ');
  const details = moves.map((m) => `${m.from} → ${m.to}: ${m.item}`);
  if (rescued.length) details.push(`recovered section(s): ${rescued.join(', ')}`);
  metaEl.title = details.join('\n');
  metaEl.classList.toggle('hidden', !bits.length);
}

function showStep(step) {
  currentStep = step;
  const keys = ['S', 'O', 'A', 'P'];

  keys.forEach((key, i) => {
    if (i < step) $(`card-${key}`).classList.remove('hidden');
    else $(`card-${key}`).classList.add('hidden');
  });

  const colorMap = { 1: 'bg-teal-600', 2: 'bg-blue-600', 3: 'bg-purple-600', 4: 'bg-orange-600' };
  for (let i = 1; i <= step; i++) {
    const key = i === 1 ? 'S' : i === 2 ? 'O' : i === 3 ? 'A' : 'P';
    $(`dot-${key}`).classList.add(colorMap[i]);
  }

  if (step === 1) nextBtn.textContent = 'Next: Generate Objective';
  else if (step === 2) nextBtn.textContent = 'Next: Generate Assessment';
  else if (step === 3) nextBtn.textContent = 'Next: Generate Plan';
  else {
    nextBtn.classList.add('hidden');
    finalActions.classList.remove('hidden');
  }

  $('stepText').textContent = `${step} of 4`;

  if (step > 1) {
    const cardId = step === 2 ? 'card-O' : step === 3 ? 'card-A' : 'card-P';
    $(cardId).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---- Clipboard ------------------------------------------------------------
function copySection(key) {
  const text = (soapData[key] || [])
    .filter((i) => i !== NOT_MENTIONED)
    .map((i) => `- ${i}`)
    .join('\n');
  if (!text) return setStatus('Nothing to copy — section is empty.');

  navigator.clipboard.writeText(text).catch((err) => {
    console.error('Clipboard write failed:', err);
    setStatus('Could not copy — clipboard permission denied.');
  });
}

function copyAll() {
  // Placeholders are skipped so a real section is never exported as "empty".
  const body = renderPlainText(soapData, { skipEmpty: true });

  navigator.clipboard
    .writeText(body)
    .then(() => alert('Full SOAP Note copied to clipboard!'))
    .catch((err) => {
      console.error('Clipboard write failed:', err);
      setStatus('Could not copy — clipboard permission denied.');
    });
}

window.copySection = copySection;
window.copyAll = copyAll;

// ---- Event wiring ---------------------------------------------------------
rawNotes.addEventListener('input', () => {
  generateBtn.disabled = busy || !rawNotes.value.trim();
});

generateBtn.addEventListener('click', generate);

nextBtn.addEventListener('click', () => {
  if (currentStep < 4) showStep(currentStep + 1);
});

// Do NOT download weights on focus: a ~290 MB fetch while the user is typing
// can get the tab killed on low-RAM phones. Load on first Generate instead.
generateBtn.disabled = !rawNotes.value.trim();
