# Vet SOAP Scribe

Turns veterinary case notes into Subjective, Objective, Assessment, and Plan
sections. Models run locally in the browser.

## Run

With Node.js 18 or newer, run:

```sh
npm start
```

Open http://localhost:8080 in a WebGPU-capable browser. No npm install is needed.
Use localhost or HTTPS rather than opening index.html directly.

## Use

- Type clinical notes up to 1,500 characters, or upload a JPG, PNG, or WebP up to 5 MB.
- For photos, rotate/crop the image, select Read text, correct the transcription,
  and confirm that you checked it against the source image.
- Generate the SOAP note, review the sections, and copy the result.

Gemma 3 1B formats SOAP notes, with SmolLM2 360M as the loading fallback.
PaddleOCR PP-OCRv6 small reads images in a separate CPU/WebAssembly worker.
Guardrails bound model requests and check generated facts against the source.

First use needs internet to download runtimes and models. Fully offline/PWA
support is not implemented. Handwriting can still be wrong despite high reader
scores. Physical-phone performance and combined model memory usage need testing.
A veterinarian must review the final note before use in a patient record.
