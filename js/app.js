import { CreateWebWorkerMLCEngine, prebuiltAppConfig } from "https://esm.run/@mlc-ai/web-llm@0.2.87";
import { renderPlainText, NOT_MENTIONED } from "./soapParser.js";
import { runPipeline } from "./pipeline.js";
import { LIMITS, prepareNotes, batchNotes } from './guardrails.js';
import { createOcrReader, validateImage } from './ocr.js';
import { renderPhoto, canvasBlob, sourceLineImage } from './imagePreparation.js';
import { canUseOcrText } from './ocrReview.js';

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
const charCountEl = $('charCount');

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
const MAX_CHARS = LIMITS.maxNoteChars;
let ocrBusy = false;
let ocrController = null;
let previewUrl = null;
let sourcePhoto = null;
let photoCanvas = null;
let photoOptions = { rotation: 0, margins: {}, enhance: false };
let previewRevision = 0;
let photoPreparing = false;
let photoReady = false;

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

    const load = (modelId) => {
      // Retain the prebuilt download URLs and pass context options separately.
      return CreateWebWorkerMLCEngine(
        worker, 
        modelId,
        {
          appConfig: prebuiltAppConfig,
          initProgressCallback: (report) => {
            loadingStatus.textContent = report.text;
            if (typeof report.progress === 'number') {
              loadingProgressWrap.classList.remove('hidden');
              loadingProgressBar.style.width = `${Math.round(report.progress * 100)}%`;
            }
          }
        },
        {
          // Chat options are the FOURTH argument, shared with request budgeting.
          context_window_size: LIMITS.contextWindow,
        }
      );
    };

    try {
      const loadedEngine = await load(MODELS.primary);
      
      // Add device lost handler for iOS crashes
      if (loadedEngine.setDeviceLostCallback) {
        loadedEngine.setDeviceLostCallback(() => {
          alert('Your browser ran out of memory and had to restart the AI engine. Please try again with a shorter note.');
          window.location.reload();
        });
      }
      return loadedEngine;
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
  if (busy || ocrBusy || inputTextContainer.classList.contains('hidden')) return;

  const notes = rawNotes.value.trim();
  if (!notes) return;
  try {
    const prepared = prepareNotes(rawNotes.value);
    batchNotes(prepared.notes);
  } catch (error) {
    showNotice(error.message);
    setStatus('Review your case notes before generating.');
    rawNotes.focus();
    return;
  }

  busy = true;
  rawNotes.disabled = true;
  tabImage.disabled = true;
  abortController = new AbortController();
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="spinner"></span> Processing...';
  
  // Automatically reset the UI for the new generation
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

    setStatus("Drafting SOAP sections...");
    const result = await runPipeline(engine, {
      notes,
      signal: abortController.signal,
      onToken: (text) => {
        const lines = (text.match(/\n/g) || []).length + 1;
        setStatus(`Drafting... ${lines} line${lines === 1 ? '' : 's'}`);
      },
      onProgress: (phase, state) => {
        setStatus(phase === 2 ? `${state} (constrained decode)...` : state);
      },
    });

    soapData = { S: result.S, O: result.O, A: result.A, P: result.P };
    soapMeta = result.meta;

    for (const key of ['S', 'O', 'A', 'P']) {
      $(`list-${key}`).innerHTML = soapData[key].map(renderItem).join('');
    }

    renderMeta(soapMeta);
    const notices = [];
    if (soapMeta.excludedFragments) notices.push(`${soapMeta.excludedFragments} unrelated or unrecognized note fragment(s) were excluded. Review your input for missing clinical details.`);
    if (soapMeta.filteredItems) notices.push('Unsupported model text was removed; original note facts were retained.');
    if (soapMeta.cutShort) notices.push('Generation reached a safety limit. Source facts were recovered; review all sections.');
    showNotice(notices.join(' '));
    
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
        showNotice('This request exceeded the model context. Nothing was trimmed. Split the note into shorter sentences and try again.');
        setStatus('Note too long for this model.');
      } else if (err?.name === 'GuardrailError') {
        showNotice(msg);
        setStatus('Review your case notes before generating.');
      } else {
        setStatus(`Error: ${msg}`);
      }
    }
  } finally {
    busy = false;
    rawNotes.disabled = false;
    tabImage.disabled = false;
    abortController = null;
    if (stopBtn) stopBtn.classList.add('hidden');
    generateBtn.textContent = "Generate SOAP Note";
    updateInputState(); // Re-evaluate button state
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
  if (meta.batches > 1) bits.push(`${meta.batches} bounded batches`);
  if (meta.filteredItems) bits.push(`${meta.filteredItems} unsupported item(s) removed`);
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

  keys.forEach(key => {
    const dot = $(`dot-${key}`);
    if (dot) dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-300 transition';
  });

  keys.forEach((key, i) => {
    if (i < step) $(`card-${key}`).classList.remove('hidden');
    else $(`card-${key}`).classList.add('hidden');
  });

  for (let i = 1; i <= step; i++) {
    const key = i === 1 ? 'S' : i === 2 ? 'O' : i === 3 ? 'A' : 'P';
    $(`dot-${key}`).classList.add(colorMap[i]);
  }

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

// ---- Input State (Combines Button logic + Character Count) ----------------
function updateInputState() {
  const count = rawNotes.value.length;
  charCountEl.textContent = count;
  
  const tooLong = count > MAX_CHARS;
  rawNotes.setAttribute('aria-invalid', String(tooLong));
  $('inputLimit').textContent = tooLong ? `Shorten to ${MAX_CHARS} characters. Nothing will be trimmed.` : 'Long notes are processed in smaller batches. Use complete, short sentences.';
  generateBtn.disabled = busy || ocrBusy || photoPreparing || tooLong || !rawNotes.value.trim() || inputTextContainer.classList.contains('hidden');
}

rawNotes.addEventListener('input', () => {
  invalidateOutput();
  updateInputState();
  showNotice('');
  if (!busy && !ocrBusy) setStatus(rawNotes.value.length > MAX_CHARS ? 'Note too long. Shorten or split it before generating.' : 'Ready.');
});

function invalidateOutput() {
  outputSection.classList.add('hidden');
  soapData = { S: [], O: [], A: [], P: [] };
  soapMeta = null;
}

// ---- Reset App Function ---------------------------------------------------
function resetApp() {
  if (busy) return;
  ocrController?.abort();
  clearImage();
  rawNotes.value = '';
  outputSection.classList.add('hidden');
  soapData = { S: [], O: [], A: [], P: [] };
  currentStep = 1;
  
  updateInputState(); // Reset char count and button
  showNotice('');
  
  window.scrollTo({ top: 0, behavior: 'smooth' });
  rawNotes.focus();
}
window.resetApp = resetApp;

// ---- Image / Camera UI Logic ----------------------------------------------
const tabText = $('tabText');
const tabImage = $('tabImage');
const inputTextContainer = $('inputTextContainer');
const inputImageContainer = $('inputImageContainer');
const imageInput = $('imageInput');
const cameraInput = $('cameraInput');
const dropZoneDefault = $('dropZoneDefault');
const imagePreview = $('imagePreview');
const ocrStatus = $('ocrStatus');
const ocrProgress = $('ocrProgress');
const ocrReview = $('ocrReview');
const ocrText = $('ocrText');
const ocrReader = createOcrReader();

function switchToTextTab() {
  tabText.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition bg-white shadow-sm text-teal-700';
  tabImage.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition text-slate-500 hover:text-slate-700';
  inputTextContainer.classList.remove('hidden');
  inputImageContainer.classList.add('hidden');
  tabText.setAttribute('aria-pressed', 'true');
  tabImage.setAttribute('aria-pressed', 'false');
  updateInputState();
}

function switchToImageTab() {
  tabImage.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition bg-white shadow-sm text-teal-700';
  tabText.className = 'flex-1 py-2 rounded-lg text-sm font-bold transition text-slate-500 hover:text-slate-700';
  inputImageContainer.classList.remove('hidden');
  inputTextContainer.classList.add('hidden');
  tabText.setAttribute('aria-pressed', 'false');
  tabImage.setAttribute('aria-pressed', 'true');
  updateInputState();
}

tabText.addEventListener('click', switchToTextTab);
tabImage.addEventListener('click', switchToImageTab);

const cropEdges = ['Left', 'Right', 'Top', 'Bottom'];

function clearOcrReview() {
  ocrReview.classList.add('hidden');
  ocrText.value = '';
  $('ocrLines').replaceChildren();
  $('ocrReviewed').checked = false;
  updateOcrReview();
}

function clearImage() {
  previewRevision++;
  photoPreparing = false;
  photoReady = false;
  sourcePhoto = null;
  if (photoCanvas) { photoCanvas.width = 0; photoCanvas.height = 0; }
  photoCanvas = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imagePreview.removeAttribute('src');
  imagePreview.classList.add('hidden');
  dropZoneDefault.classList.remove('hidden');
  $('photoEditor').classList.add('hidden');
  clearOcrReview();
  imageInput.value = '';
  cameraInput.value = '';
  updateInputState();
}

function resetPhotoOptions() {
  photoOptions = { rotation: 0, margins: {}, enhance: false };
  for (const edge of cropEdges) $(`crop${edge}`).value = '0';
  $('enhancePhoto').checked = false;
}

async function updatePhotoPreview() {
  if (!sourcePhoto || ocrBusy) return;
  const revision = ++previewRevision;
  photoPreparing = true;
  photoReady = false;
  $('readImageBtn').disabled = true;
  clearOcrReview();
  updateInputState();
  const options = { ...photoOptions, margins: { ...photoOptions.margins } };
  try {
    const prepared = await renderPhoto(sourcePhoto, options);
    const blob = await canvasBlob(prepared.canvas);
    if (revision !== previewRevision) { prepared.canvas.width = 0; return; }
    if (photoCanvas) { photoCanvas.width = 0; photoCanvas.height = 0; }
    photoCanvas = prepared.canvas;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    imagePreview.src = previewUrl;
    imagePreview.classList.remove('hidden');
    dropZoneDefault.classList.add('hidden');
    $('photoQuality').textContent = prepared.quality.warnings.join(' ');
    photoReady = true;
    showNotice('');
    setStatus('Check the photo orientation and crop, then select Read text.');
  } catch (error) {
    if (revision === previewRevision) {
      showNotice(error.message);
      setStatus('Adjust the photo before reading.');
    }
  } finally {
    if (revision === previewRevision) {
      photoPreparing = false;
      $('readImageBtn').disabled = !photoReady;
      updateInputState();
    }
  }
}

async function selectImage(file) {
  if (!file || busy || ocrBusy) return;
  try {
    validateImage(file);
  } catch (error) {
    showNotice(error.message);
    imageInput.value = '';
    cameraInput.value = '';
    return;
  }
  clearImage();
  resetPhotoOptions();
  sourcePhoto = file;
  $('photoEditor').classList.remove('hidden');
  await updatePhotoPreview();
  imageInput.value = '';
  cameraInput.value = '';
}

function updateOcrReview() {
  const reviewed = $('ocrReviewed').checked;
  const text = ocrText.value;
  $('useOcrBtn').disabled = ocrBusy || !canUseOcrText(text, reviewed);
  $('ocrReviewHint').textContent = text.length > MAX_CHARS
    ? `Shorten or split this text to ${MAX_CHARS} characters. Nothing was trimmed.`
    : /\[\s*(unclear|unreadable|illegible)\s*\]/i.test(text)
      ? 'Resolve unreadable text against the photo or retake the image before using it.'
      : !reviewed ? 'Correct any mistakes, then confirm that you checked the photo.' : '';
}

function renderOcrLines(result) {
  const container = $('ocrLines');
  container.replaceChildren();
  for (const [index, line] of result.lines.entries()) {
    const card = document.createElement('div');
    card.className = `p-3 rounded-lg border ${line.lowConfidence ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-slate-50'}`;
    const heading = document.createElement('p');
    heading.className = 'text-xs font-semibold text-slate-600 mb-2';
    heading.textContent = `Line ${index + 1} · Reader score ${Math.round(line.score * 100)}% · ${line.lowConfidence ? 'Uncertain reading' : 'Check against photo'}`;
    const source = document.createElement('img');
    source.src = sourceLineImage(photoCanvas, line.bounds);
    source.alt = `Original image region for line ${index + 1}`;
    source.className = 'w-full max-h-28 object-contain bg-white border rounded mb-2';
    const reading = document.createElement('p');
    reading.className = 'text-sm text-slate-700 break-words';
    reading.textContent = `Original reading: ${line.text}`;
    card.append(heading, source, reading);
    if (line.criticalValues.length) {
      const reminder = document.createElement('p');
      reminder.className = 'text-xs font-semibold text-amber-800 mt-2';
      reminder.textContent = `Check these numbers: ${line.criticalValues.join(', ')}`;
      card.append(reminder);
    }
    container.append(card);
  }
}

function lockPhotoControls(locked) {
  imageInput.disabled = locked;
  cameraInput.disabled = locked;
  $('cameraBtn').disabled = locked;
  $('clearImageBtn').disabled = locked;
  $('photoEditor').querySelectorAll('input, button').forEach(control => { control.disabled = locked; });
  if (!locked) $('readImageBtn').disabled = !photoReady;
}

async function readImage() {
  if (!sourcePhoto || !photoCanvas || !photoReady || photoPreparing || busy || ocrBusy) return;
  ocrBusy = true;
  ocrController = new AbortController();
  lockPhotoControls(true);
  clearOcrReview();
  ocrStatus.classList.remove('hidden');
  ocrProgress.value = 0;
  showNotice('');
  setStatus('Reading handwriting locally...');
  updateInputState();
  try {
    const image = await canvasBlob(photoCanvas);
    const result = await ocrReader.recognize(sourcePhoto, {
      image,
      signal: ocrController.signal,
      onProgress: report => {
        $('ocrStatusText').textContent = report.status || 'Reading image';
        ocrProgress.value = Math.round((report.progress || 0) * 100);
      },
    });
    ocrText.value = result.text;
    renderOcrLines(result);
    $('ocrConfidence').textContent = `${result.model}. Reader scores are not accuracy guarantees. Compare every line, especially names, numbers, doses, and negation.`;
    ocrReview.classList.remove('hidden');
    setStatus('Text extracted. Compare it with the photo and correct mistakes.');
    const weak = result.lines.filter(line => line.lowConfidence).length;
    showNotice(weak ? `${weak} line(s) have uncertain readings. Correct them using the image before confirming.` : 'Handwriting can be wrong even with a high reader score. Confirm every line before using the text.');
    ocrText.focus();
  } catch (error) {
    if (error?.name === 'AbortError') {
      setStatus('Image reading cancelled. Your case notes were preserved.');
    } else {
      showNotice(error.message || 'Could not read this image. Adjust the photo, try again, or type the notes.');
      setStatus('Image reading failed. Your case notes were preserved.');
    }
  } finally {
    ocrBusy = false;
    ocrController = null;
    lockPhotoControls(false);
    ocrStatus.classList.add('hidden');
    updateOcrReview();
    updateInputState();
  }
}

imageInput.addEventListener('change', event => selectImage(event.target.files[0]));
cameraInput.addEventListener('change', event => selectImage(event.target.files[0]));
$('cameraBtn').addEventListener('click', () => cameraInput.click());
$('cancelOcrBtn').addEventListener('click', () => ocrController?.abort());
$('clearImageBtn').addEventListener('click', clearImage);
$('readImageBtn').addEventListener('click', readImage);
$('rotateLeftBtn').addEventListener('click', () => { photoOptions.rotation -= 90; updatePhotoPreview(); });
$('rotateRightBtn').addEventListener('click', () => { photoOptions.rotation += 90; updatePhotoPreview(); });
$('resetPhotoBtn').addEventListener('click', () => { resetPhotoOptions(); updatePhotoPreview(); });
for (const edge of cropEdges) {
  $(`crop${edge}`).addEventListener('change', event => {
    photoOptions.margins[edge.toLowerCase()] = Number(event.target.value);
    updatePhotoPreview();
  });
}
$('enhancePhoto').addEventListener('change', event => { photoOptions.enhance = event.target.checked; updatePhotoPreview(); });
ocrText.addEventListener('input', () => {
  $('ocrReviewed').checked = false;
  updateOcrReview();
});
$('ocrReviewed').addEventListener('change', updateOcrReview);
$('useOcrBtn').addEventListener('click', () => {
  if (ocrBusy || !canUseOcrText(ocrText.value, $('ocrReviewed').checked)) return updateOcrReview();
  invalidateOutput();
  rawNotes.value = ocrText.value;
  switchToTextTab();
  showNotice('Reviewed text copied to Case Note. Check it once more before generating.');
  setStatus('Reviewed case notes are ready.');
  rawNotes.focus();
});
$('dropZone').addEventListener('dragover', event => event.preventDefault());
$('dropZone').addEventListener('drop', event => {
  event.preventDefault();
  selectImage(event.dataTransfer.files[0]);
});
window.addEventListener('pagehide', () => {
  ocrController?.abort();
  if (previewUrl) URL.revokeObjectURL(previewUrl);
});

// ---- FIX: MISSING EVENT LISTENERS ADDED HERE ------------------------------
generateBtn.addEventListener('click', generate);

nextBtn.addEventListener('click', () => {
  if (currentStep < 4) showStep(currentStep + 1);
});
// ---------------------------------------------------------------------------

// ---- BOOTSTRAP ON PAGE LOAD -----------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  updateInputState(); // Initializes character count on load

  try {
    await initEngine();
    
    loadingOverlay.classList.add('opacity-0');
    setTimeout(() => {
      loadingOverlay.classList.add('hidden');
      appContainer.classList.remove('hidden');
    }, 500);

  } catch (err) {
    console.error(err);
    loadingSpinner.classList.add('hidden');
    loadingProgressWrap.classList.add('hidden');
    loadingStatus.classList.add('hidden');
    loadingError.classList.remove('hidden');
    loadingErrorText.textContent = err.message || "An unknown error occurred while loading the model.";
  }
});
