import { normalizeOcrResult } from './ocrReview.js';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Adapt the SDK's supported worker API to a cancellable one-job lifecycle. */
function createPaddleJob() {
  let disposed = false;
  let transportWorker;
  const job = {
    onmessage: null,
    onerror: null,
    terminate() { disposed = true; transportWorker?.terminate(); },
    postMessage({ image }) { void run(image); },
  };
  const send = data => { if (!disposed) job.onmessage?.({ data }); };
  async function run(image) {
    let ocr;
    try {
      send({ type: 'progress', status: 'Loading handwriting reader (first use downloads models)', progress: 0 });
      const { PaddleOCR } = await import('https://esm.sh/@paddleocr/paddleocr-js@0.4.2?bundle');
      if (disposed) return;
      ocr = await PaddleOCR.create({
        textDetectionModelName: 'PP-OCRv6_small_det',
        textRecognitionModelName: 'PP-OCRv6_small_rec',
        worker: { createWorker: () => {
          if (disposed) throw new DOMException('Aborted', 'AbortError');
          transportWorker = new Worker(new URL('./ocrWorker.js', import.meta.url), { type: 'module' });
          return transportWorker;
        } },
        ortOptions: { backend: 'wasm', numThreads: 1, wasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/' },
      });
      if (disposed) return;
      send({ type: 'progress', status: 'Detecting and reading text lines', progress: 0.5 });
      const [result] = await ocr.predict(image, { textRecScoreThresh: 0 });
      send({ type: 'result', result: { ...result, model: 'PaddleOCR PP-OCRv6 small' } });
    } catch (error) {
      send({ type: 'error', message: `Could not read this photo: ${error.message || error}. Adjust the photo, check your connection, or type the notes.` });
    } finally {
      if (!disposed) await ocr?.dispose();
    }
  }
  return job;
}

export function validateImage(file) {
  if (!file || !ALLOWED_TYPES.includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP image of your notes.');
  if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Choose an image smaller than 5 MB.');
}

/** Each job owns its worker. Terminating it releases both ONNX models, even
 * during downloads or initialization, and cannot leave a stale job updating UI. */
export function createOcrReader({ workerFactory = createPaddleJob, timeoutMs = 180000 } = {}) {
  return {
    async recognize(file, { image = file, signal, onProgress } = {}) {
      validateImage(file);
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        let worker;
        let settled = false;
        let timer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          worker?.terminate();
          error ? reject(error) : resolve(value);
        };
        const abort = () => finish(signal.reason || new DOMException('Aborted', 'AbortError'));
        try {
          worker = workerFactory();
          worker.onmessage = event => {
            if (settled) return;
            const message = event.data;
            try {
              if (message.type === 'progress') onProgress?.(message);
              else if (message.type === 'error') finish(new Error(message.message));
              else if (message.type === 'result') finish(null, normalizeOcrResult(message.result));
            } catch (error) {
              finish(error);
            }
          };
          worker.onerror = () => finish(new Error('The image reader could not start. Check your connection, then try again or type the notes.'));
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) return abort();
          timer = setTimeout(() => finish(new Error('Image reading took too long. Crop to the writing or try again after the model download completes.')), timeoutMs);
          worker.postMessage({ image });
        } catch (error) {
          finish(error);
        }
      });
    },
  };
}
