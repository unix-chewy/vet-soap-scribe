# Vet SOAP Scribe

Vet SOAP Scribe turns short veterinary case notes into a structured SOAP note:

- **S**ubjective - history and signs reported by the owner
- **O**bjective - vitals and examination findings
- **A**ssessment - diagnosis or problem list
- **P**lan - tests, treatment, medication, and follow-up

The app runs in the browser. It uses WebGPU and WebLLM to run a small language
model locally, then displays the result one SOAP section at a time.

## How to use

1. Open `index.html` in a browser with WebGPU support.
2. Enter the case notes.
3. Select **Generate SOAP Note**.
4. Review the sections and use **Copy All** or copy an individual section.

The model is loaded when generation starts. The first run may take longer
because the model weights need to be downloaded. Chrome is recommended.

## How it works

The app uses a two-phase pipeline: 

```text
Case notes
    |
    v
Pre-classify notes (deterministic fallback)
    |
    v
Phase 1: model drafts S/O/A/P lines
    |
    v
Repair and clean the draft
    |
    +--> If the draft is incomplete:
    |        Phase 2: constrained model re-format
    |
    v
Parse sections and split compound facts
    |
    v
Apply section rules, remove duplicates, recover missing facts
    |
    v
Display and copy the SOAP note
```

Note: To be added feature, camera thingy.

The first model call focuses on extracting facts. If its output is not usable,
a second call asks the model to copy the draft using a strict `S:`, `O:`, `A:`,
`P:` line format. The parser then checks the result and moves items to the
appropriate section when needed. It does not intentionally add facts that were
not in the notes.

## Model Selection

Used Gemma3 1B parameter for formatting rn

## Notes

This tool is intended to help organize notes, not replace veterinary judgment.
Review the generated SOAP note before saving it to a patient record.