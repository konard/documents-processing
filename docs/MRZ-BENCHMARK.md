# Choosing an MRZ reader

Six OCR approaches were measured on the same five real passport scans, on
accuracy per field and on wall-clock time. The scans and their expected values
are personal documents and stay outside this repository; the benchmark takes
them as an argument.

```bash
node src/mrz-benchmark.mjs --cases /path/to/cases.json --json results.json
```

## Results

Five fields per passport (document number, birth date, expiry, surname, given
name) over five passports: 25 fields in total.

Measured on an Apple M3 Pro (18-core GPU, 18 GB unified memory), CPU/Metal
only. No discrete GPU is involved, and none of these engines needs one.

| Reader                         | Fields | Accuracy | Clean images | Median    |
| ------------------------------ | ------ | -------- | ------------ | --------- |
| **PaddleOCR (Apache-2.0)**     | 25/25  | **100%** | **5/5**      | 15 131 ms |
| **Consensus of all engines**   | 25/25  | **100%** | **5/5**      | 19 904 ms |
| built-in (Tesseract + mrz-lib) | 24/25  | 96%      | 4/5          | 261 ms    |
| macOS Vision (system)          | 24/25  | 96%      | 4/5          | 473 ms    |
| PassportEye (Python, MIT)      | 24/25  | 96%      | 4/5          | 1 924 ms  |
| Tesseract + `mrz` (npm, MIT)   | 22/25  | 88%      | 2/5          | 253 ms    |
| mrz-scanner (AGPL)             | 17/25  | 68%      | 2/5          | 677 ms    |
| RapidOCR (Apache-2.0)          | 15/25  | 60%      | 2/5          | 1 146 ms  |

PaddleOCR is the most widely used open-source OCR engine (89k stars,
Apache-2.0) and the only single reader that got every field right. It is also
by far the slowest here: about 10 s per image of inference on CPU, which
downscaling barely improves because these scans are already small.

## What the numbers show

**No single engine read every passport correctly.** Three tie at 96%, and each
misses a different field: the built-in reader misses one given name, Vision
misses a different given name, PassportEye misses a birth date.

**The errors are independent, so combining engines fixes them.** Every field is
read correctly by at least four of the six, so a majority vote reaches 100%.
That is what `src/mrz-consensus.mjs` does, and it is measured as its own row
above rather than assumed.

**A dedicated MRZ library is not automatically better than a general OCR
engine.** macOS Vision, which simply reads the whole page, matched the
purpose-built readers and beat two of them. It is also the only engine that
recovered the printed zone on these Russian passports, whose guilloche pattern
defeats Tesseract entirely.

## Independent engines, not just independent wrappers

A vote only means something if the voters can fail independently. Three of the
readers above (the built-in one, Tesseract + `mrz`, and PassportEye) share
Tesseract underneath, so they can repeat the same misread and outvote a correct
answer. Counting them as three votes overstates the evidence.

Five genuinely distinct engines are represented: Tesseract, Apple Vision,
RapidOCR's ONNX models, PaddlePaddle, and mrz-scanner's ONNX models. Restricted
to one reader per engine, every combination that reaches 100% includes
PaddleOCR, costing about 16 s.

## Recommended: cheap engines first, expensive one only when they disagree

`tieredConsensus` in `src/mrz-consensus.mjs` runs the fast engines and calls a
slow one only if they leave something unsettled.

With Tesseract, Apple Vision and RapidOCR as the fast tier and PaddleOCR as the
fallback, this reads **25/25 fields correctly at 5.05 s per passport** — the
same accuracy as running everything, at about a quarter of the cost. Only one
of the five passports needed the fallback at all.

For a single fast reader where 96% is acceptable, the built-in one is cheapest
at 261 ms.

`mrz-scanner` appears in some cheap 100% combinations but is
**AGPL-3.0-or-later**. Depending on it would impose that licence on anything
shipped alongside, which does not suit a public-domain package, so it is
benchmarked for reference and not used.

## Notes on individual engines

- **macOS Vision** is a system framework: no download, no key, no network. It
  needs `pyobjc-framework-Vision` and only runs on macOS and iOS.
- **mrz-scanner** OCRs well but its CLI rejects MRZ lines shorter than the TD3
  width, so it fails on scans it actually read correctly. The adapter here pads
  the lines before parsing, which is what its 68% reflects; unpatched it scored
  20%.
- **RapidOCR** reads the MRZ accurately but drops characters from the
  nationality code, so MRZ lines are matched on overall shape rather than the
  exact field layout.
- **PaddleOCR** is CPU-only here and needs no GPU. Its models download once and
  are then cached locally, so it works offline afterwards.
- **Vision-language models** (GOT-OCR, olmOCR, Qwen2.5-VL) were not benchmarked:
  they want a discrete GPU and several gigabytes of weights, which does not fit
  a laptop with 18 GB of shared memory.

## Adding an engine

Add an adapter to `src/mrz-readers.mjs` exposing `name`, `license`,
`isAvailable()` and `read(image)`. Anything not installed is skipped, so the
benchmark runs with whatever is present.
