#!/usr/bin/env node
/* eslint local/no-changelog-comments: ["warn", { allowDatesInStrings: true }] */
// The exhibit names carry each notice's send date so the files sort and read
// chronologically; those ISO dates are data, not source-change history.
// build-frro-exhibits.mjs
//
// Builds the FRRO flight-cancellation exhibits in flight-cancellation-final/
// from the byte-exact airline emails already saved in
// flight-cancellations-originals/. Every exhibit is a SINGLE-PAGE PDF (the
// whole airline notice, scaled to fit one A4 page — nothing is cut), because
// the FRRO expects one page per disruption notice.
//
// The exhibits are declared below as (source .eml, output name) pairs, so the
// set is auditable and reproducible: re-running regenerates the exact same
// files from the same originals. Sources are matched by a substring of their
// saved filename (which already carries date + sender + subject), so a resumed
// fetch that re-hashes a file does not break this build.
//
// This trip's affected flights are on Air India booking [REDACTED] (Goa -> Delhi
// -> Ho Chi Minh City, [REDACTED]). That booking has two airline notices, both
// with subject "Change in Itinerary", so it produces two exhibits:
//   1. [REDACTED] — [REDACTED] DEL->SGN rescheduled (01 Aug -> 02 Aug).
//   2. [REDACTED] — [REDACTED] GOX->DEL cancelled/modified, rebooked to [REDACTED].
// A different booking [REDACTED] ([REDACTED]) has its own notices; this build leaves
// them out, as they belong to a separate trip.
//
// Usage:  node build-frro-exhibits.mjs [baseDir]
//   baseDir defaults to the project root (one level above src/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emlToOnePagePdf } from './eml-to-pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || path.dirname(__dirname);
const ORIGINALS = path.join(BASE, 'flight-cancellations-originals');
const FINAL = path.join(BASE, 'flight-cancellation-final');
// A ready-to-attach bundle (each notice as .eml + one-page .pdf) for the
// Air India support request about this booking.
const SUPPORT_DIR = path.join(FINAL, '[REDACTED]-AirIndia-support-request');

// Each exhibit: a unique substring identifying the source .eml, and the final
// file name. Keep the substrings specific enough to match exactly one .eml.
// Each entry: `match` finds exactly one source .eml by a filename substring;
// `out` is the exhibit's name in the final folder; `bundle` is the base name
// (no extension) for the .eml/.pdf pair in the support-request folder.
const EXHIBITS = [
  {
    match:
      '2026-05-13-noreply-ai-notification@airindia.com-Change_in_Itinerary',
    out: 'AirIndia-[REDACTED]-1-[REDACTED]-DEL-SGN-rescheduled.pdf',
    bundle: '[REDACTED]-2026-05-13-[REDACTED]-DEL-SGN-rescheduled',
  },
  {
    match:
      '2026-05-19-noreply-ai-notification@airindia.com-Change_in_Itinerary',
    out: 'AirIndia-[REDACTED]-2-[REDACTED]-GOX-DEL-cancelled.pdf',
    bundle: '[REDACTED]-2026-05-19-[REDACTED]-GOX-DEL-cancelled',
  },
];

// Find the single .eml in ORIGINALS whose filename contains `substring`.
function findSourceEml(substring) {
  const matches = fs
    .readdirSync(ORIGINALS)
    .filter((name) => name.endsWith('.eml') && name.includes(substring));
  if (matches.length === 0) {
    throw new Error(`no .eml matching "${substring}" in ${ORIGINALS}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `"${substring}" matches ${matches.length} .eml files, need exactly one:\n  ${matches.join('\n  ')}`
    );
  }
  return path.join(ORIGINALS, matches[0]);
}

async function main() {
  fs.mkdirSync(FINAL, { recursive: true });
  fs.mkdirSync(SUPPORT_DIR, { recursive: true });
  for (const exhibit of EXHIBITS) {
    const source = findSourceEml(exhibit.match);

    // 1) The FRRO exhibit: a one-page PDF in the final folder.
    await emlToOnePagePdf(source, path.join(FINAL, exhibit.out));
    console.log(
      `✓ ${exhibit.out}\n    from ${path.basename(source)} (one page)`
    );

    // 2) The support-request bundle copy: the byte-exact .eml plus the same
    //    one-page PDF, so the whole booking's evidence can be attached at once.
    fs.copyFileSync(source, path.join(SUPPORT_DIR, `${exhibit.bundle}.eml`));
    await emlToOnePagePdf(
      source,
      path.join(SUPPORT_DIR, `${exhibit.bundle}.pdf`)
    );
    console.log(`✓ support-request/${exhibit.bundle}.{eml,pdf}`);
  }
  console.log(
    `\nDone. ${EXHIBITS.length} exhibit(s) in:\n  ${FINAL}\n` +
      `and the support-request bundle in:\n  ${SUPPORT_DIR}`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
