import { CreateWebWorkerMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
import { parseSOAP, preclassify, renderPlainText, NOT_MENTIONED } from "./soapParser.js";
import { runPipeline } from "./pipeline.js";

// ---- Model choice ---------------------------------------------------------
const MODELS = {
  primary: 'gemma3-1b-it-q4f16_1-MLC',
  fallback: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
};

// ---- DOM references -------------------------------------------------------
const $ = (id) => document.getElementById(id);

// App UI
const appContainer = $('appContainer');
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

// Loading Screen UI
const loadingOverlay = $('loadingOverlay');
const loadingStatus = $('loadingStatus');
const loadingProgressWrap = $('loadingProgressWrap');
const loadingProgressBar = $('loadingProgressBar');
const loadingError = $('loadingError');
const loadingErrorText = $('loadingErrorText');
const loadingSpinner = $('loadingSpinner');

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
          // Update the loading screen text and progress bar
          loadingStatus.textContent = report.text;
          if (typeof report.progress === 'number') {
            loadingProgressWrap.classList.remove('hidden');
            loadingProgressBar.style.width = `${Math.round(report.progress * 100)}%`;
          }
        },
      });

    try {
      return await load(MODELS.primary);
    } catch (err) {
      console.warn(`Primary model failed to load, trying fallback.`, err);
      loadingStatus.textContent = 'Primary model failed. Loading smaller model...';
      return await load(MODELS.fallback);
    }
  })();

  try {
    engine = await initPromise;
    return engine;
  } catch (err) {
    initPromise = null;
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
  
  // NEW: Automatically reset the UI for the new generation
  outputSection.classList.add('hidden');
  setProgress(0);
  showNotice('');
  ['S', 'O', 'A', 'P'].forEach(key => {
    $(`dot-${key}`).className = 'w-2.5 h-2.5 rounded-full bg-slate-300 transition';
  });

  if (stopBtn) {
    stopBtn.classList.remove('hidden');
    stopBtn.onclick = () => abortController?.abort();
  }

  try {
    if (!engine) {
      setStatus("Loading Model...");
      await initEngine();
    }
    if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError');

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
    
    outputSection.classList.remove('hidden');
    showStep(1);
    setStatus(`Done in ${(soapMeta.ms / 1000).toFixed(1)}s.`);

    // Smoothly scroll down to the generated output
    setTimeout(() => {
      outputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

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
  const colorMap = { 1: 'bg-teal-600', 2: 'bg-blue-600', 3: 'bg-purple-600', 4: 'bg-orange-600' };

  // 1. Reset ALL dots back to gray first
  keys.forEach(key => {
    const dot = $(`dot-${key}`);
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-300 transition';
  });

  // 2. Show/hide cards based on step
  keys.forEach((key, i) => {
    if (i < step) $(`card-${key}`).classList.remove('hidden');
    else $(`card-${key}`).classList.add('hidden');
  });

  // 3. Color the active dots
  for (let i = 1; i <= step; i++) {
    const key = i === 1 ? 'S' : i === 2 ? 'O' : i === 3 ? 'A' : 'P';
    $(`dot-${key}`).classList.add(colorMap[i]);
  }

  // 4. FIX: Explicitly show/hide the buttons
  if (step < 4) {
    nextBtn.classList.remove('hidden');
    finalActions.classList.add('hidden');
    
    if (step === 1) nextBtn.textContent = 'Next: Generate Objective';
    else if (step === 2) nextBtn.textContent = 'Next: Generate Assessment';
    else if (step === 3) nextBtn.textContent = 'Next: Generate Plan';
  } else {
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

generateBtn.disabled = !rawNotes.value.trim();

// ---- Reset App Function ---------------------------------------------------
function resetApp() {
  // 1. Clear the text area and UI
  rawNotes.value = '';
  outputSection.classList.add('hidden');
  soapData = { S: [], O: [], A: [], P: [] };
  currentStep = 1;
  
  // 2. Reset status
  setStatus('Ready.');
  showNotice('');
  generateBtn.disabled = true;
  
  // 3. Scroll back to top and focus textarea
  window.scrollTo({ top: 0, behavior: 'smooth' });
  rawNotes.focus();
}
window.resetApp = resetApp;

// ---- IMAGE / CAMERA UI LOGIC ----------------------------------------------
const tabText = $('tabText');
const tabImage = $('tabImage');
const inputTextContainer = $('inputTextContainer');
const inputImageContainer = $('inputImageContainer');
const imageInput = $('imageInput');
const dropZoneDefault = $('dropZoneDefault');
const imagePreview = $('imagePreview');
const ocrStatus = $('ocrStatus');

function switchToTextTab() {
  tabText.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition bg-white shadow-sm text-teal-700';
  tabImage.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition text-slate-500 hover:text-slate-700';
  inputTextContainer.classList.remove('hidden');
  inputImageContainer.classList.add('hidden');
}

function switchToImageTab() {
  tabImage.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition bg-white shadow-sm text-teal-700';
  tabText.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition text-slate-500 hover:text-slate-700';
  inputImageContainer.classList.remove('hidden');
  inputTextContainer.classList.add('hidden');
}

tabText.addEventListener('click', switchToTextTab);
tabImage.addEventListener('click', switchToImageTab);

// Handle Image Upload & Simulate Extraction
imageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // 1. Show Preview
  const reader = new FileReader();
  reader.onload = (e) => {
    imagePreview.src = e.target.result;
    imagePreview.classList.remove('hidden');
    dropZoneDefault.classList.add('hidden');
    
    // 2. Show loading state
    ocrStatus.classList.remove('hidden');
    tabImage.disabled = true;
    tabText.disabled = true;

    // 3. Simulate the AI extracting text (Wait 2 seconds)
    setTimeout(() => {
      // For now, we inject a placeholder text so the user sees how it works
      rawNotes.value = "8yo MN domestic shorthair. Sneezing/nasal discharge x 1 week. Eyes watery. Owner reports mild appetite decrease. Temp 38.9. Lungs clear on auscultation. Mild dehydration. Suspect feline upper respiratory infection. Start L-lysine and supportive care.";
      
      // 4. Reset Image UI
      imageInput.value = ''; // clear input
      imagePreview.classList.add('hidden');
      imagePreview.src = '';
      dropZoneDefault.classList.remove('hidden');
      ocrStatus.classList.add('hidden');
      tabImage.disabled = false;
      tabText.disabled = false;

      // 5. Switch back to Text Tab so the user can review and edit
      switchToTextTab();
      generateBtn.disabled = false;
      setStatus('Image text extracted. Review before generating.');
      
    }, 2000);
  };
  reader.readAsDataURL(file);
});

// ---- BOOTSTRAP ON PAGE LOAD -----------------------------------------------
// Automatically download/load the model before showing the app.
window.addEventListener('DOMContentLoaded', async () => {
  try {
    await initEngine();
    
    // Model is ready! Hide loading screen and show app.
    loadingOverlay.classList.add('opacity-0');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
      appContainer.classList.remove('hidden');
      generateBtn.disabled = false; 
    }, 500); // Wait for fade transition to finish

  } catch (err) {
    console.error(err);
    
    // Show error state on the loading screen
    loadingSpinner.classList.add('hidden');
    loadingProgressWrap.classList.add('hidden');
    loadingStatus.classList.add('hidden');
    loadingError.classList.remove('hidden');
    loadingErrorText.textContent = err.message || "An unknown error occurred while loading the model.";
  }
});