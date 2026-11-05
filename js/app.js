import { CreateWebWorkerMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
import { parseSOAP, NOT_MENTIONED } from "./soapParser.js";

const MODEL_ID = "SmolLM2-360M-Instruct-q4f16_1-MLC"; 

// ---- DOM references -------------------------------------------------------
const $ = (id) => document.getElementById(id);

const rawNotes = $('rawNotes');
const generateBtn = $('generateBtn');
const statusEl = $('status');
const inputSection = $('inputSection');
const outputSection = $('outputSection');
const nextBtn = $('nextBtn');
const finalActions = $('finalActions');

// ---- State ----------------------------------------------------------------
let engine = null;
let initPromise = null;                  
let busy = false;
let currentStep = 1;
let soapData = { S: [], O: [], A: [], P: [] };

function setStatus(msg) {
  statusEl.textContent = msg;
}

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
    
    const hasF16 = adapter.features.has('shader-f16');
    const maxBuffer = adapter.limits.maxStorageBufferBindingSize;
    
    console.log(`GPU: ${adapter.info?.vendor}, f16: ${hasF16}, maxBuffer: ${maxBuffer}`);

    // Fallback if the phone's GPU is extremely limited
    let modelToUse = MODEL_ID;
    if (maxBuffer < 200 * 1024 * 1024) { 
        console.warn("Small GPU buffer detected, switching to even tinier model.");
        modelToUse = "SmolLM2-360M-Instruct-q4f16_1-MLC"; 
    }

    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

    engine = await CreateWebWorkerMLCEngine(worker, modelToUse, {
      initProgressCallback: (report) => setStatus(report.text),
    });

    return engine;
  })();

  try {
    return await initPromise;
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
  generateBtn.disabled = true;
  generateBtn.innerHTML = '<span class="spinner"></span> Processing...';

  try {
    if (!engine) {
      setStatus("Loading Model...");
      await initEngine();
    }

    setStatus("Generating SOAP note...");

    soapData = await extractSOAP(notes);

    for (const key of ['S', 'O', 'A', 'P']) {
      $(`list-${key}`).innerHTML = soapData[key].map(renderItem).join('');
    }

    inputSection.classList.add('hidden');
    outputSection.classList.remove('hidden');
    showStep(1);
  } catch (err) {
    console.error("Full Error Object:", err); // <-- ADD THIS LINE
    let errorMsg = err?.message || err?.toString() || JSON.stringify(err) || "Unknown error";
    setStatus(`Error: ${errorMsg}`);
  } finally {
    busy = false;
    generateBtn.textContent = "Generate SOAP Note";
    generateBtn.disabled = !rawNotes.value.trim();
  }
}

// ---- Model call -----------------------------------------------------------
const SOAP_SYSTEM = `You are a veterinary SOAP note editor. Convert the input into a JSON object with exactly four arrays of strings: "S", "O", "A", "P".

RULES:
- S (Subjective) = Signalment, history, and owner complaints. (e.g., "Lethargic", "Owner gave omeprazole").
- O (Objective) = Vitals and exam findings. (e.g., "Temp 39.5", "Heart rate 120", "Abdomen tense").
- A (Assessment) = Diagnosis or suspected disease. (e.g., "Suspect gastroenteritis").
- P (Plan) = Treatments and procedures. (e.g., "Bloodwork", "Subcutaneous fluids").

CRITICAL RULES:
1. DO NOT DROP ANY DATA. Every sentence from the input MUST be included.
2. If the input contains the word "Plan:", DO NOT include the word "Plan:" in your output. Only extract the actions.
3. Do not put Vitals (Temp, HR) or Diagnoses (Suspect...) in the Plan section.
4. If a section is empty, use ["[NOT MENTIONED]"].
5. Output ONLY valid JSON.

Example:
Input: 8yo cat. Vomiting. Temp 38.9. Lungs clear. Suspect URI. Plan: give fluids.
Output: {"S":["8yo cat.","Vomiting."],"O":["Temp 38.9.","Lungs clear."],"A":["Suspect URI."],"P":["Give fluids."]}`;

async function extractSOAP(notes) {
  const reply = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: SOAP_SYSTEM },
      { role: 'user', content: notes },
    ],
    temperature: 0.0,
    top_p: 1,
    max_tokens: 600,
    stop: ['\n\nInput:', '<|im_end|>'],
  });

  return parseSOAP(reply.choices[0].message.content);
}

// ---- Rendering ------------------------------------------------------------
function renderItem(item) {
  if (item === NOT_MENTIONED) {
    return `<li class="not-mentioned">${NOT_MENTIONED}</li>`;
  }
  const div = document.createElement('div');
  div.textContent = item;
  return `<li>${div.innerHTML}</li>`;
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
  const text = soapData[key].map((i) => `- ${i}`).join('\n');
  navigator.clipboard.writeText(text).catch((err) => {
    console.error('Clipboard write failed:', err);
    setStatus('Could not copy — clipboard permission denied.');
  });
}

function copyAll() {
  const body = ['S', 'O', 'A', 'P']
    .map((key) => `${key}:\n${soapData[key].map((i) => `- ${i}`).join('\n')}`)
    .join('\n\n');

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

// 3. PRELOAD ON FOCUS
// As soon as the user taps the textarea to type, start downloading/loading the model 
rawNotes.addEventListener('focus', () => {
  if (!engine && !initPromise) {
    setStatus("Pre-loading AI engine in background...");
    initEngine().catch(err => {
      console.error(err);
      setStatus("Engine unloaded. Will retry on click.");
    });
  }
});