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

| Reader                         | Fields | Accuracy | Clean images | Median   |
| ------------------------------ | ------ | -------- | ------------ | -------- |
| **Consensus of all engines**   | 25/25  | **100%** | **5/5**      | 4 250 ms |
| built-in (Tesseract + mrz-lib) | 24/25  | 96%      | 4/5          | 256 ms   |
| macOS Vision (system)          | 24/25  | 96%      | 4/5          | 466 ms   |
| PassportEye (Python, MIT)      | 24/25  | 96%      | 4/5          | 1 579 ms |
| Tesseract + `mrz` (npm, MIT)   | 22/25  | 88%      | 2/5          | 254 ms   |
| mrz-scanner (AGPL)             | 17/25  | 68%      | 2/5          | 663 ms   |
| RapidOCR (Apache-2.0)          | 15/25  | 60%      | 2/5          | 1 185 ms |

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

## Recommended combination

`built-in + PassportEye + macOS Vision + RapidOCR` reaches **100% in 3.48 s per
passport**, with every component under a permissive licence.

Sixteen combinations reach 100%, and the cheapest run in 1.7 s, but all of the
cheap ones include `mrz-scanner`, which is **AGPL-3.0-or-later**. Depending on
it would impose that licence on anything shipped alongside, which does not suit
a public-domain package, so it is benchmarked for reference and not used.

For a single fast reader where 96% is acceptable, the built-in one is the
cheapest at 256 ms.

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

## Adding an engine

Add an adapter to `src/mrz-readers.mjs` exposing `name`, `license`,
`isAvailable()` and `read(image)`. Anything not installed is skipped, so the
benchmark runs with whatever is present.
