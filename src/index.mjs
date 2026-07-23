// documents-processing — library entry point.
//
// Re-exports the reusable toolkits used by the command-line scripts in this
// package. The CLI commands themselves live as standalone scripts in this
// folder (run them via the `documents-processing <command>` dispatcher); this
// module exposes the underlying helpers for programmatic use.
//
//   ocr-lib.mjs         — image I/O, preprocessing, tesseract OCR, MRZ parsing
//   pdf-image-tools.mjs — extract / re-encode the images inside a PDF page

export * from './ocr-lib.mjs';
export * from './pdf-image-tools.mjs';
