/**
 * Basic usage example
 * Demonstrates how to use the package
 *
 * Run with any runtime:
 * - Bun: bun examples/basic-usage.js
 * - Node.js: node examples/basic-usage.js
 * - Deno: deno run examples/basic-usage.js
 */

import { box, jitter, parseSaneDate } from '../src/index.mjs';

// Example: describe a region of interest on a scanned page.
// `box` builds the rectangle descriptor the OCR helpers expect.
const region = box(120, 240, 300, 60);
console.log('Region of interest:');
console.log(`  ${JSON.stringify(region)}`);

// Example: nudge that region slightly, staying inside the page bounds.
// Re-reading a field across jittered boxes is how consensus reads are built.
console.log('\nJittered variants (for consensus OCR):');
for (const px of [4, 8]) {
  console.log(
    `  ±${px}px -> ${JSON.stringify(jitter(region, px, 1000, 1400))}`
  );
}

// Example: parse a DD.MM.YYYY date off a document, rejecting OCR noise.
// Whitespace is ignored; out-of-range days, months and years yield null.
console.log('\nDate parsing:');
for (const raw of ['12.03.2024', '1 2 . 0 3 . 2 0 2 4', '32.03.2024', 'x']) {
  console.log(`  ${JSON.stringify(raw)} -> ${parseSaneDate(raw)}`);
}
