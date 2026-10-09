<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-privacy-guardrail-white.png">
  <img align="left" alt="Privacy Guardrail" src="docs/assets/logo-privacy-guardrail-black.png" height="120">
</picture>
<a href="https://www.dfki.de/" title="Deutsches Forschungszentrum für Künstliche Intelligenz">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/DFKI-Logo_ohne_RGB_weiss.png">
    <img align="right" alt="DFKI" src="docs/assets/dfki_Logo_digital_black.png" height="72">
  </picture>
</a>
<br clear="all">

# Privacy Guardrail

Privacy Guardrail is a Manifest V3 browser extension for Google Chrome and Microsoft Edge that detects personally identifiable information (PII) before text is pasted — or a Word, Excel, PowerPoint or PDF file is uploaded — into supported LLM chat apps. Detection runs **entirely on your device**: deterministic recognizers compiled from Rust to WebAssembly, plus optional transformer NER through ONNX Runtime Web. No pasted text leaves the browser, and the project has no telemetry.

Developed at the [German Research Center for Artificial Intelligence (DFKI)](https://www.dfki.de/), Data Science and its Applications research department.

> **Status — public beta (`0.x`).** Detection is assistive: it helps you catch personal data before it leaves your machine, but it will not catch everything and is not a compliance or DLP product. See [Known limitations](#known-limitations).

## Contents

- [Supported chat apps](#supported-chat-apps)
- [Install](#install)
- [System requirements](#system-requirements)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [Documentation](#documentation)
- [For developers](#for-developers)
- [Roadmap](#roadmap)
- [Acknowledgements](#acknowledgements)

## Supported chat apps

- ChatGPT (`chat.openai.com`, `chatgpt.com`)
- Claude (`claude.ai`)
- Gemini (`gemini.google.com`)

Generic or custom sites are not supported in this beta.

## Install

End users should install from the **Chrome Web Store** once the listing is live. The same package runs unchanged in **Microsoft Edge** — see [`docs/user/install-on-microsoft-edge.md`](docs/user/install-on-microsoft-edge.md). Each GitHub Release also attaches the packaged ZIP and SHA-256 checksum for transparency and manual loading.

For an unpacked developer install, see [`docs/developer/building.md`](docs/developer/building.md).

## System requirements

- Chrome desktop stable (latest) or Microsoft Edge desktop stable (latest). Minimum Chromium version 116.
- **Recommended:** ≥ 16 GB RAM and a WebGPU-capable GPU for smooth Local AI detection.
- **Minimum for Local AI:** more than 2 GB browser-reported memory. On 2 GB or less, the extension auto-disables Local AI and runs pattern-only detection. Between 2 GB and 4 GB, Local AI stays on but a slowdown warning may appear.
- On capable systems (more than 4 GB browser-reported memory, passive WebGPU available, and no known CPU/WASM fallback), Local AI may warm automatically while the user is active on a supported chat page.
- Without WebGPU, Local AI falls back to CPU/WASM execution (slower but functional).
- The Local AI model is a compact 4-bit (q4f16) build that keeps memory around 1 GB while loaded, used for both the WebGPU path and the CPU/WASM fallback.
- Pattern-only detection runs on any supported Chrome or Edge system regardless of memory or WebGPU.

These requirements are heuristic because Local AI runs a transformer NER model entirely in the browser and Chromium browsers report memory in coarse buckets.

## How it works

- Intercepts text paste events in supported chat inputs.
- Checks Word (`.docx`), Excel (`.xlsx`), PowerPoint (`.pptx`) and PDF files before they are uploaded — via file picker, drag and drop, or paste — and warns when they contain personal data. Text, comments, speaker notes, hidden sheets and document properties are read locally; the upload is held until you choose to send or drop it. PDFs are read from their text layer only (no OCR).
- Detects regex/checksum-backed PII such as email addresses, phone numbers, SSNs, credit cards, IBANs, IP addresses, and dates.
- Adds local transformer NER for names, addresses, identifiers, credentials, and other free-text PII when model assets are prepared.
- Shows a review UI before replacing detected spans.
- Replaces selected spans with stable placeholders such as `[EMAIL_1]` or `[PERSON_1]`.
- Stores the placeholder map locally in extension storage so model responses can be restored later, with restored values visually highlighted.

No pasted text is sent to a remote inference service. There is no telemetry or analytics. See [`PRIVACY.md`](PRIVACY.md) for the full privacy posture.

## Known limitations

- Detection can miss sensitive content and can flag harmless text.
- Short names, ambiguous words, code blocks, tables, and unusual formatting reduce detection quality.
- Local AI can be slow or unavailable depending on browser, device memory, and WebGPU support; pattern-only mode covers a narrower set of categories.
- Restoration of placeholders into model responses depends on local records and may not handle every response rewrite.
- File scanning warns but does not redact: an uploaded file is sent as it is. Scanned PDFs and images are not read (no OCR); password-protected files and legacy binary formats (`.doc`, `.xls`, `.ppt`) cannot be checked. Very large files are checked only partially.

## Documentation

### For End-Users

- [User guide](docs/user/) — install, day-to-day use, Local AI explained, managing local data, troubleshooting, reporting issues safely, detected categories and limitations.
- [Privacy posture](PRIVACY.md)
- [Terms of Use](TERMS.md)
- [Security reporting](SECURITY.md)
- [Support](SUPPORT.md)
- [Changelog](CHANGELOG.md)
- [Impressum / Legal notice](IMPRESSUM.md)

### Project

- [Contributing](CONTRIBUTING.md)
- [Building from source](docs/developer/building.md)
- [Model assets](docs/developer/model-assets.md)
- [Releasing](docs/developer/releasing.md)

### For Developers

Quickstart for working on the extension:

```bash
rustup update
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.118
npm install

npm run build:wasm
npm run dev
```

Load `dist/` as an unpacked extension in `chrome://extensions` (Chrome) or `edge://extensions` (Edge), with Developer mode on.

Model-free pull-request checks:

```bash
npm run validate:ci
```

The full transformer build requires preparing BardsAI EU multilingual NER assets — see [`docs/developer/model-assets.md`](docs/developer/model-assets.md). Once prepared, build with strict enforcement:

```bash
NER_MODEL_ASSETS_REQUIRED=1 npm run build
```

### Repository layout

- `src/` — extension TypeScript, UI, offscreen detection, benchmark harness.
- `crate/` — Rust/WASM detection engine.
- `scripts/` — model prep, packaging checks, benchmark helpers.
- `benchmarks/` — benchmark harness; generated corpora and reports stay local.
- `docs/` — user, developer, and design documentation.

Build and local-model artifacts are intentionally not committed: `dist/`, `crate/pkg/`, `crate/target/`, `generated/models/`, `.model-sources/`, `.venv/`, `.private-docs/`, `tests-local/`, and `benchmarks/cache/`. See [`docs/release/public-source-boundary.md`](docs/release/public-source-boundary.md) for the public source boundary.

## Roadmap

Directional themes — none are commitments, and order may change with evidence and community feedback:

- More reliable local PII detection (smaller models, distillation, fine-tuning, hybrid pipelines).
- More browser-efficient inference paths for lower-resource devices.
- Support for additional Chromium-based browsers beyond Chrome and Edge desktop stable.
- Mobile support for AI workflows on smartphones.
- Support for additional AI chat platforms.

## Acknowledgements

<table width="100%"><tr>
<td align="left" width="120"><a href="https://www.dfki.de/web/forschung/forschungsbereiche/data-science-und-ihre-anwendungen" title="Data Science and its Applications, DFKI">
  <img alt="DSA — Data Science and its Applications" src="docs/assets/dsa-logo.png" height="120">
</a></td>
<td>
Privacy Guardrail is developed in the <a href="https://dsa.dfki.de">Data Science and its Applications research department</a> at the <a href="https://www.dfki.de/">German Research Center for Artificial Intelligence (DFKI)</a>.</td></tr></table>

### Contributors

- Andrea Sipka
- Björn Busch-Geertsema — Lead Developer
- Sergey Redyuk — Developer
- Siddharth Saraswat – Developer

- Ruth Ikegah – Community Manager
- Prof. Dr. Sebastian Vollmer — Principal Investigator & Project Originator
- Rahul Sharma
- Islam Mesabah
- Kai Spriestersbach
- Andrea Sipka