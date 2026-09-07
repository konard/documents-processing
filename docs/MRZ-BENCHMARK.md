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

| Reader                          | Fields | Accuracy | Clean images | Median    |
| ------------------------------- | ------ | -------- | ------------ | --------- |
| **macOS Vision (system)**       | 25/25  | **100%** | **5/5**      | 491 ms    |
| **PaddleOCR band (Apache-2.0)** | 25/25  | **100%** | **5/5**      | 5 495 ms  |
| **PaddleOCR (Apache-2.0)**      | 25/25  | **100%** | **5/5**      | 15 877 ms |
| **Consensus of all engines**    | 25/25  | **100%** | **5/5**      | 26 145 ms |
| built-in (Tesseract + mrz-lib)  | 24/25  | 96%      | 4/5          | 267 ms    |
| PassportEye (Python, MIT)       | 24/25  | 96%      | 4/5          | 1 976 ms  |
| Tesseract + `mrz` (npm, MIT)    | 23/25  | 92%      | 3/5          | 264 ms    |
| mrz-scanner (AGPL)              | 17/25  | 68%      | 2/5          | 694 ms    |
| RapidOCR (Apache-2.0)           | 13/25  | 52%      | 2/5          | 1 334 ms  |

macOS Vision reads every field correctly in under half a second, making it both
the most accurate and, after the Tesseract readers, the fastest. It is a system
framework, so there is nothing to download and it is already GPU-accelerated
through Metal.

PaddleOCR is the most-starred open-source OCR engine (89k stars, Apache-2.0)
and reads the MRZ reliably, but it is the slowest here by a wide margin: about
10 s per image of CPU inference. Restricting it to the MRZ band cuts that to
about 5 s at the same accuracy.

## What the numbers show

**Three engines read every field correctly**, and all are general OCR rather
than purpose-built MRZ readers. Reaching that took fixing three bugs in this
repository, each of which had been making an engine look worse than it is:

- Line 1 of an MRZ holds only letters, so a digit there is a misread. The
  parser deleted them, turning `NIK0LAI` into `NIKLAI` and losing a letter;
  they are now mapped back (`0` to `O`, `1` to `I`, and so on).
- A line 2 that lost a character shifts every field after the gap, producing a
  wrong number and a wrong date that both still look plausible. Such a line is
  now refused. It is checked against the fixed TD3 layout rather than by
  length, since several engines legitimately truncate the trailing filler.
- Names were compared without accounting for how differently engines render
  the `<` padding, which is described below.

**Combining engines also reaches 100%, with a wider margin.** Two independent
trios both get every field right, but not with equal confidence:

| Combination                         | Time   | Unanimous fields |
| ----------------------------------- | ------ | ---------------- |
| Tesseract + Vision + PaddleOCR band | 6.26 s | **24 / 25**      |
| Tesseract + Vision + RapidOCR       | 2.19 s | 12 / 25          |

Both score 100%, but the second reaches it with 13 fields carried by a bare
two-vote majority, because RapidOCR alone manages only 52%. The first has
almost every field agreed by all three engines, so a single bad scan is far
less likely to flip an answer. Speed is not the only thing being traded here.

**Comparing names needs care.** Engines render the MRZ's `<` padding
differently: some strip it, some return a run of one letter, some garble it,
and some absorb a single `<` into the name as an extra character. Scoring those
as different readings made three engines look worse than they are and hid a
combination that was already correct. `namesAgree` in `src/mrz-consensus.mjs`
treats them as the same reading, and both the benchmark and the voting use it.

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
RapidOCR's ONNX models, PaddlePaddle, and mrz-scanner's ONNX models.

## Recommended

**One engine:** macOS Vision. It reads every field correctly in 491 ms, needs no
download, and is already GPU-accelerated through Metal. On a machine where it is
unavailable, PaddleOCR restricted to the MRZ band is the portable equivalent at
5.5 s.

**Three engines, for a second opinion:** Tesseract + Apple Vision + PaddleOCR
band, at 6.26 s. They share no code, and 24 of 25 fields come back unanimous, so
a disagreement is a real signal rather than noise.

## Cheap engines first, expensive one only when they disagree

`tieredConsensus` in `src/mrz-consensus.mjs` runs the fast engines and calls a
slow one only if they leave something unsettled.

On these passports the fast engines already settle everything, so no fallback
is triggered. The tiering matters for scans where they disagree.

For a single fast reader where 96% is acceptable, the built-in one is cheapest
at 261 ms.

`mrz-scanner` appears in some cheap 100% combinations but is
**AGPL-3.0-or-later**. Depending on it would impose that licence on anything
shipped alongside, which does not suit a public-domain package, so it is
benchmarked for reference and not used.

## GPU acceleration

Short answer: it does not help here, and it was measured rather than assumed.

The machine is an Apple M3 Pro with an 18-core GPU and 18 GB of unified memory,
so the usual CUDA path does not apply. Each engine was checked separately:

| Engine       | GPU option on this machine | Result                                                                           |
| ------------ | -------------------------- | -------------------------------------------------------------------------------- |
| PaddleOCR    | none                       | No CUDA and no Metal build; no `paddlepaddle-gpu` wheel exists for Apple Silicon |
| RapidOCR     | `CoreMLExecutionProvider`  | Available, and **slower than CPU**                                               |
| Apple Vision | Metal, always on           | Already accelerated; nothing to enable                                           |
| Tesseract    | none                       | CPU-only by design                                                               |

CoreML was the one real candidate, and onnxruntime does offer it. Timing the
RapidOCR detection model directly:

| Input size | CPU     | CoreML  |
| ---------- | ------- | ------- |
| 640×640    | 0.026 s | 0.071 s |
| 960×960    | 0.060 s | 0.230 s |
| 1280×1280  | 0.112 s | 0.585 s |

CoreML is slower at every size, and the gap widens with resolution. The cause is
visible in its own diagnostics: it takes 320 of the model's 328 nodes but splits
them across **6 partitions**, so tensors cross between CPU and GPU six times per
run. These models are small enough that the transfers cost more than the compute
they save.

Apple Vision already runs on the GPU through Metal, which is why it is fast
without any configuration.

### What did help: search less of the page

Cost scales with the area searched, not with the hardware. PaddleOCR's slowest
step is scanning a full page for text, and the MRZ occupies the bottom strip.
Cropping to that strip cut it from 9.16 s to 1.65 s per image — about six times
faster — while reading the same values, on all five passports. The `--band` flag
on `src/ocr-engines/paddle-ocr.py` does this, and it is benchmarked as its own
row above.

That is worth more than any accelerator available here.

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
