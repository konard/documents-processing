// documents-processing — library entry point.
//
// Re-exports the reusable toolkits used by the command-line scripts in this
// package. The CLI commands themselves live as standalone scripts in this
// folder (run them via the `documents-processing <command>` dispatcher); this
// module exposes the underlying helpers for programmatic use.
//
//   ocr-lib.js         — image I/O, preprocessing, tesseract OCR, MRZ parsing
//   pdf-image-tools.js — extract / re-encode the images inside a PDF page

export * from './ocr-lib.js';
export * from './pdf-image-tools.js';
