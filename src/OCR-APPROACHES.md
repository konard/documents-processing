# OCR approaches explored

A log of every OCR idea we tried on these documents (Russian passports, Form 'C',
India visas/ETAs, entry stamps, Vietnam tickets), what worked, what didn't, and
how to reproduce each. Nothing here is thrown away — the ones that failed are
kept as starting points for later.

All scripts live in `src/`: `src/ocr-lib.mjs` (the reusable toolkit) and
`tests/` (one dedicated `.mjs` per idea). Document folders (`passports/`,
`c-forms/`, `visas/`, `transcripts/`, …) live in the project root, one level up.
Run any test from the project root with `node tests/<file>`.

---

## The core insight: use the right source per field

Documents mix **machine-readable**, **clean printed**, and **hard printed**
fields. The winning strategy is to read each field from the source where it is
most reliable, not to throw the whole page at OCR.

| Field source                                 | Reliability               | How we read it                                                 |
| -------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| MRZ (passport bottom 2 lines)                | ✅ perfect, self-checking | crop band → OCR with MRZ charset → parse **with check digits** |
| Embedded PDF text (ETA, ticket)              | ✅ perfect                | `pdf.js` text extraction — not OCR at all                      |
| Clean printed table cell (Form C)            | ✅ good                   | block-crop the value column → OCR                              |
| Printed over guilloché (passport issue date) | ⚠️ hard                   | keepBlack + calibrate + perspective search + consensus         |
| Overprinted on label text                    | ❌ blocked                | override file (visual value) — see below                       |

---

## What worked

### 1. MRZ + check digits — the gold standard (`tests/07-passport-mrz.mjs`)

The passport's two machine-readable lines encode surname, given name, number,
nationality, DOB, sex, expiry in a fixed OCR-B font. Crop the band, OCR with the
MRZ charset, then **validate every field with its check digit**. Even when OCR
misreads a digit, the check digit catches it, so a "pass" is trustworthy.

- Added **OCR-error correction** (`O→0, I→1, B→8, S→5…`) on numeric MRZ fields
  before parsing — recovered several misreads (e.g. a trailing `B` read back to `8`).
- Result: **4/5 passports fully validated**; the 5th self-flags its one bad field.

### 2. Embedded text extraction (`extract-text-transcripts.mjs`, `cforms-to-json.mjs`)

ETAs, Vietnam tickets, **and now the Form C** have a real text layer — `pdf.js`
reads them exactly. No OCR needed. Always prefer this when a text layer exists.
`cforms-to-json.mjs` auto-detects: if the Form C carries its section labels
(`Personal Details`, `Passport Details`, …) it reads every field EXACTLY from
the text by label, and marks the transcript `_source: "text"` (authoritative).
`split-cforms.mjs` splits the combined `forms.pdf` into one text PDF per
person first, naming each from its own text layer.

### 3. Block-crop OCR for tables — the image-Form-C fallback (`tests/02-block-crops.mjs`)

When a Form C is a **scan/photo with no text layer**, full-page OCR fails (the
2-column table confuses tesseract). Cropping each **single-column value block**
(Personal / Passport / Visa details) and OCRing that in isolation reads every
cross-checked field at ~0.8 s/doc. This is the OCR fallback inside
`cforms-to-json.mjs` (used only when the text path finds no layer). The text
path superseded it for our current, text-based `forms.pdf` — and notably
corrected two date fields (e.g. a month digit and a day digit) that
noisy OCR had earlier mis-flagged as document errors.

### 4. keepBlack — strip everything that isn't ink (**the breakthrough**)

The passport **date of issue** is not in the MRZ and sits on red guilloché.
Ordinary/Otsu binarize kept the background; the fix is a **fixed low threshold
that keeps only near-black pixels** (`keepBlack(canvas, 90)`), turning the
colored guilloché and lighter sub-labels white and leaving clean black digits.
This took issue-date OCR from **0/5 → readable**. Idea credit: "cut it out and
remove anything not black."

### 5. Calibration from averages (`tests/09`, `tests/12`, `calibrateIssueDateY`)

Each scan is framed slightly differently, so a fixed box drifts off the date row.
Instead: find the date row on the passports where it reads easily, record those
y-positions, and **average them** → a calibrated row position that anchors the
harder passports too. Recovered a passport whose date row a fixed box missed.

### 6. Perspective search + percentage consensus (`tests/11`–`13`, `readIssueDate`)

Around the calibrated position, read the field from many **perspectives**
(y-offset, upscale factor, keepBlack threshold, red-channel drop). Then:

- **Strict regex + date sanity** — only count reads that are a real `dd.mm.yyyy`
  with valid day/month/year. This alone kills noise like `44.02.2024` (day 44).
- **Percentage consensus** — the winner must be a clear plurality (≥35% of valid
  reads and ≥2 hits), not merely "2 identical". A field that can't reach the bar
  is returned **null (unread)** — honest, never a guess.
- Result: **4/5 issue dates read at 83–100% agreement.**

---

## What didn't work (kept for future)

### A. Full-page OCR (`tests/01-fullpage-scale.mjs`)

Whole-page `--psm 6` on the Form C never found more than 3/7 key values at any
scale — the table columns interleave. Abandoned in favor of block crops.

### B. Grid-line detection by dark-pixel projection (`tests/05-detect-gridlines.mjs`)

Projecting dark pixels onto each axis to find table rules **locked onto the dark
text**, not the faint gray borders. The detected "lines" sat on text rows. Kept
as a visualization; a real cell-detector needs faint-line-specific handling.

### C. Faint-line detection (`tests/06-faint-line-detection.mjs`)

Tried to find the thin gray rules by requiring a long continuous mid-gray run.
The borders are too light / broken by JPEG compression to form 60%-continuous
runs — found almost nothing. Documented approach; would need morphological line
extraction to work.

### D. Label-anchored cell OCR (`tests/03`, `tests/04`)

Locate each label word by OCR, then crop the value cell to its right. Works
partially but the label positions are themselves jittery (OCR of small labels),
so value windows misalign. Superseded by block crops for the fields we check.

### E. Per-field consensus by default (`tests/00-speed-baseline.mjs`)

Running the full offset×preprocess consensus on **every** field was the slow
trap (~1.5 s/field → minutes/doc). Consensus is reserved for the few genuinely
hard fields (issue date), not used everywhere.

---

## What is genuinely blocked

### Overprinted issue date (example passport)

The issue-date digits are printed **on top of** the "Дата выдачи / Date of issue"
label, in faint orange ink, so digits and Cyrillic overlap on the same line. OCR
cannot isolate them, and it is hard for a human too. Recorded in
`ocr-overrides.json` with the visual value (`<DATE>`) and revisit ideas
(higher-res rescan, hue-specific channel math, overlap-tolerant OCR engine).

---

## The pipeline (how it all fits)

All scripts and config below live in `src/` (run from the project root, e.g.
`node src/ocr-passports.mjs`):

```
src/split-cforms.mjs    split combined forms.pdf → one text PDF per person
src/ocr-passports.mjs   MRZ+checkdigits, calibrated keepBlack issue-date, overrides
src/cforms-to-json.mjs  Form C → JSON: text layer if present (exact), else block-crop OCR
src/extract-text-transcripts.mjs   pdf.js text for ETAs + tickets
src/write-visual-transcripts.mjs   Claude's visual reads (authoritative for images)
src/build-markdown-transcripts.mjs full human-readable Markdown, tables, per doc
src/match-checks.mjs    reconcile machine vs visual; cross-check passport + visa details
src/ocr-overrides.json  fields OCR can't read yet (tracked for later)
tests/              one .mjs per idea above — run `node tests/<file>`
```

## Speed note

The issue-date reader is the slow step (~9 s/passport) because of the perspective
grid × red-channel preprocessing. It only runs when (re)generating the OCR
transcripts, not interactively. The fast/thorough tradeoff is documented in
`tests/13` (small grid: 2 s, 2/5) vs the current grid (9 s, 4/5). A future
two-tier reader (fast grid first, escalate only on empty) would get the best of
both.
