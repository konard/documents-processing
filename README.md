# documents-processing

A toolkit of command-line scripts for reading, verifying, combining and
compressing scanned travel / immigration documents (passports, visas, Form C,
tickets) into clean, upload-ready PDFs.

It grew out of a real need to prepare a family's documents for an immigration
portal: extract each field from every scan, cross-check that the passport, visa,
Form C and ticket all agree, then produce compact per-person PDFs that strict
portal parsers actually accept.

> **Privacy:** this repository contains **no personal data**. Real data and
> fonts live in a `data/` folder in your working tree, never in `src/`. The
> files the scripts consume (`data/match-checks-data.json`,
> `data/ocr-overrides.json`, `data/fonts/`) are git-ignored; only the
> `data/*.example.json` templates with synthetic values are tracked. Copy an
> example to its real name and fill it in locally.

## Requirements

- **Node.js ≥ 20**
- The **`tesseract`** OCR engine on your `PATH` (used by the passport/Form C OCR
  steps). Install via your package manager, e.g. `brew install tesseract`.

## Install

```bash
npm install
```

Or install globally to get the `documents-processing` command on your `PATH`:

```bash
npm install -g documents-processing
```

## Usage

Every script is exposed as a subcommand of a single dispatcher:

```bash
documents-processing <command> [args...]
documents-processing --help          # list all commands
documents-processing <command>       # run with no args to see that command's usage
```

You can also run any script directly, e.g. `node src/compress-pdf.mjs in.pdf`.

### Commands

| Command                      | What it does                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `jpg-to-pdf`                 | Convert every image in a folder into a full-page PDF with the same basename.  |
| `split-cforms`               | Split a combined Form C PDF (one page per person) into one PDF per person.    |
| `split-tickets`              | Split a multi-passenger booking PDF into one ticket PDF per passenger.        |
| `first-page-tickets`         | Keep only the first page of each per-passenger ticket PDF, named per person.  |
| `rename-passport-entries`    | Rename scanned entry-stamp pages to the person they belong to (mapping file). |
| `cforms-to-json`             | Read each Form C into a structured JSON transcript (text layer, else OCR).    |
| `ocr-passports`              | OCR each passport data page (MRZ + check digits + issue date).                |
| `extract-text-transcripts`   | Pull fields from text-bearing docs (e-visas / ETAs and tickets).              |
| `pdf-to-lino`                | Read a text-bearing PDF into links notation (Vietnam e-visa form or any).     |
| `write-visual-transcripts`   | Emit visual-read transcripts from your `match-checks-data.json`.              |
| `build-markdown-transcripts` | Render a human-readable Markdown transcript for every document.               |
| `match-checks`               | Cross-check every field across a person's documents and report mismatches.    |
| `join-passport-visa`         | Combine passport + entry stamp + visa into one normalized PDF per person.     |
| `join-visa-ticket`           | Join a visa and ticket into a single PDF per passenger.                       |
| `markdown-to-pdf`            | Render a Markdown letter to a clean A4 PDF (optional one-page fit, fonts).    |
| `join-letter-attachments`    | Build a letter PDF followed by its attachment PDFs.                           |
| `documents-by-person`        | Collect each person's documents into a `documents-by-person/<PERSON>/` tree.  |
| `split-person-documents`     | Split & compress each person's combined PDF into upload-ready pieces.         |
| `compress-pdf`               | Shrink a PDF under a size cap without rebuilding pages or rasterizing text.   |
| `rebuild-letters`            | Rebuild all explanation-letter PDFs from their Markdown sources.              |
| `gmail-setup`                | Automate the one-time Gmail API setup (gcloud project, API, guidance).        |
| `fetch-flight-cancellations` | Fetch airline cancellation emails from Gmail and save each as .eml + PDF(s).  |

Run any command with `--help` (or no arguments) for its exact arguments.

## Fetching emails from Gmail

`fetch-flight-cancellations` pulls airline cancellation emails from Gmail and
saves each one to `flight-cancellations-originals/` as the byte-exact `.eml`
original, one or more PDFs, and any real attachments. Filenames are derived from
the message content (date, sender, subject), never from Gmail internals.

Set up an OAuth client once (no personal data is stored in the repo). Run
`gmail-setup` to automate everything Google allows — with the gcloud CLI it
creates/enables the project and Gmail API for you — and to print the single
step that has no API. Gmail is a **restricted** scope, so a custom OAuth client
is mandatory; only two things can never be automated, because Google protects
them: signing in to your own account and clicking **Allow**.

1. `documents-processing gmail-setup` — signs in via gcloud (optional), creates
   the project, and enables the **Gmail API**. It then links the credentials
   page where you create an OAuth client of type **Desktop app** (the one
   manual step) and tells you where to save the JSON.
2. Provide the client either as env vars / a `.env` file
   (`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — see `data/.env.example`) or as
   `data/gmail-credentials.json` (see `data/gmail-credentials.example.json`).
3. Run `fetch-flight-cancellations`; it opens a consent URL, captures the
   redirect on a local port, issues a **read-only** (`gmail.readonly`) token and
   caches it at `data/gmail-token.json` (git-ignored, refreshed automatically
   thereafter).

By default it searches the last 90 days for the two airlines (IndiGo, Air India)
and cancellation-related keywords; override with `--days=`, `--airlines=`,
`--keywords=`, or a full `--query=`.

Each email is rendered to PDF by several independent engines so a single failure
never loses an email — the system Chrome (DevTools "Print to PDF", highest
fidelity), the optional
[`browser-commander`](https://github.com/link-foundation/browser-commander)
package, the optional `wkhtmltopdf` CLI, and a pure `pdf-lib` text fallback that
always works. Every engine that succeeds writes its own `…-<engine>.pdf`.

## As a library

The reusable helpers are exported from the package entry point:

```js
import {
  renderImage,
  ocrCanvas,
  extractBiggestImage,
} from 'documents-processing';
```

- `src/ocr-lib.mjs` — image I/O, preprocessing, tesseract OCR, MRZ parsing.
- `src/pdf-image-tools.mjs` — extract / re-encode the images inside a PDF page.

## Notes on PDF compatibility

Some strict server-side PDF parsers reject files that have been rebuilt or that
embed very high-resolution images. `compress-pdf` therefore never rebuilds
pages — it only swaps image streams in place — caps images at 1280 px on their
long side, and re-encodes them as baseline (non-progressive) JPEG. See
`src/OCR-APPROACHES.md` for the OCR methodology.

## Development

```bash
npm run lint          # eslint
npm run format:check  # prettier
npm run check         # lint + format + duplication
```

## License

Released under the Unlicense — see [LICENSE](LICENSE).
