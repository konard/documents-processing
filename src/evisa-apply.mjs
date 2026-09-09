#!/usr/bin/env node
// evisa-apply.mjs
//
// Prefills the Vietnam e-visa application form from documents you already have.
//
// Usage:
//   node src/evisa-apply.mjs --input <path> [--input <path> ...] [options]
//
//   --input <path>     JSON, lino, image, PDF, folder or zip. Repeatable.
//   --portrait <path>  Portrait photo to upload (4x6, white background).
//   --passport <path>  Passport data page image to upload.
//   --out <dir>        Where to write prepared images and the screenshot.
//   --screenshot       Save a full-page screenshot of the filled form.
//   --dry-run          Resolve and validate the data; do not open a browser.
//   --emit-lino        Print the resolved record as lino notation.
//   --ocr              Read the passport MRZ to fill missing fields.
//   --fill             Open the browser and fill the form after reading.
//
// Reading a passport and filling a form are separate jobs: --ocr reads and
// reports, and --fill is what opens a browser.
//   --keep-open        Leave the browser open (default; --no-keep-open closes).
//
// The form is filled but never submitted: the browser stays open so you can
// review every field and submit it yourself.

import fs from 'node:fs';
import path from 'node:path';
import { loadSource, guessDocumentRole, toLino } from './evisa-sources.mjs';
import {
  normalizeApplicant,
  validateApplicant,
  mergeSources,
} from './evisa-data.mjs';
import { openForm, prepareDocument, fillAndCapture } from './evisa-session.mjs';
import { lookupAddress, renderVerifiedAddress } from './evisa-geocode.mjs';

/**
 * The flags that carry no argument of their own.
 *
 * `--ocr` reads and stops: reading a passport and filling a form are separate
 * jobs, and `--fill` is what asks for the browser.
 */
const SWITCHES = {
  '--screenshot': { screenshot: true },
  '--dry-run': { dryRun: true },
  '--emit-lino': { emitLino: true },
  '--ocr': { ocr: true, readOnly: true },
  '--fill': { readOnly: false },
  '--read-only': { readOnly: true },
  '--no-keep-open': { keepOpen: false },
};

/** Parses the flags above into a plain options object. */
export function parseArgs(argv) {
  const options = {
    inputs: [],
    out: 'evisa-output',
    screenshot: false,
    dryRun: false,
    emitLino: false,
    ocr: false,
    keepOpen: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      options.inputs.push(argv[++i]);
    } else if (arg === '--portrait') {
      options.portrait = argv[++i];
    } else if (arg === '--passport') {
      options.passport = argv[++i];
    } else if (arg === '--out' || arg === '-o') {
      options.out = argv[++i];
    } else if (SWITCHES[arg]) {
      Object.assign(options, SWITCHES[arg]);
    } else if (!arg.startsWith('-')) {
      options.inputs.push(arg);
    }
  }
  return options;
}

/**
 * Collects every input into one applicant record.
 *
 * Sources are merged in the order given, so a verified JSON file listed after a
 * scan overrides whatever OCR read from it.
 */
export async function resolveApplicant(options) {
  const records = [];
  const documents = [];

  for (const input of options.inputs) {
    for (const source of await loadSource(input)) {
      if (source.documentPath) {
        documents.push({
          path: source.documentPath,
          role: guessDocumentRole(source.documentPath),
        });
      }
      if (Object.keys(source.data).length > 0) {
        records.push(source);
      }
    }
  }

  const ocrNotes = [];
  if (options.ocr) {
    const passportDoc =
      documents.find((doc) => doc.role === 'passport') ??
      documents.find((doc) => doc.role === 'unknown');
    if (passportDoc) {
      // Imported here so a --dry-run never loads the native image libraries.
      const { readPassportConsensus, describeAgreement } =
        await import('./evisa-passport-consensus.mjs');
      // Every engine at hand reads the page, and each field is what they
      // agree on; a field they split on is left for the applicant to settle.
      const result = await readPassportConsensus(passportDoc.path, {
        log: (line) => ocrNotes.push(line),
      });
      if (result.data.passportNumber) {
        const data = { ...result.data };
        for (const field of result.unverified) {
          delete data[field];
        }
        // OCR goes first so any explicit record overrides it.
        records.unshift({
          name: `ocr:${path.basename(passportDoc.path)}`,
          data,
        });
        ocrNotes.push(...describeAgreement(result));
        ocrNotes.push(
          ...result.unverified.map(
            (field) => `${field} failed its MRZ check digit and needs review`
          )
        );
      } else {
        ocrNotes.push(`no MRZ found in ${path.basename(passportDoc.path)}`);
      }
    }
  }

  const merged = mergeSources(...records);
  const applicant = normalizeApplicant(merged.data);
  return {
    applicant,
    provenance: merged.provenance,
    documents,
    ocrNotes,
    validation: validateApplicant(applicant),
  };
}

/**
 * Checks the home addresses against the map and takes the map's rendering
 * where it confirms the house, so a Latin-typed address gains the postal
 * code and city it lacked. One the map cannot place stays as written.
 */
async function verifyAddresses(applicant) {
  for (const key of [
    'permanentAddress',
    'contactAddress',
    'emergencyAddress',
  ]) {
    if (!applicant[key]) {
      continue;
    }
    const found = await lookupAddress(applicant[key]);
    const verified = renderVerifiedAddress(applicant[key], found);
    if (verified) {
      console.log(`${key} confirmed by the map: ${verified}`);
      applicant[key] = verified;
    } else {
      console.log(`${key} not confirmed by the map; kept as written`);
    }
  }
}

/** Prints what was filled, what the site had already read, and what changed. */
function reportFill(result) {
  console.log(`Filled ${result.filled.length} fields.`);
  if (result.agreed?.length) {
    console.log(
      `The site read ${result.agreed.length} field(s) from the passport and they matched: ${result.agreed.join(', ')}`
    );
  }
  for (const change of result.corrected ?? []) {
    console.log(
      `  corrected ${change.field}: the site read "${change.was}", replaced with "${change.now}"`
    );
  }
  if (result.siteOnly?.length) {
    console.log(
      `  kept the site's own reading, unconfirmed by ours: ${result.siteOnly.join(', ')}`
    );
  }
  for (const failure of result.failures) {
    console.log(`  could not fill ${failure.field}: ${failure.error}`);
  }
}

function report(resolved) {
  const { validation, ocrNotes } = resolved;
  for (const note of ocrNotes) {
    console.log(`  ocr: ${note}`);
  }
  for (const warning of validation.warnings) {
    console.log(`  warning: ${warning}`);
  }
  for (const error of validation.errors) {
    console.log(`  error: ${error}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.inputs.length === 0 && !options.portrait && !options.passport) {
    console.error('No inputs. See the usage comment at the top of this file.');
    process.exit(1);
  }

  const resolved = await resolveApplicant(options);
  const fieldCount = Object.keys(resolved.applicant).length;
  console.log(
    `Resolved ${fieldCount} fields from ${options.inputs.length} input(s).`
  );
  report(resolved);

  if (options.emitLino) {
    console.log(`\n${toLino(resolved.applicant)}\n`);
  }

  if (!resolved.validation.valid) {
    console.log('\nThe data is incomplete. Fix the errors above, or pass');
    console.log('--dry-run to keep iterating without opening a browser.');
  }

  // Reading a passport and filling a form are different jobs. A run given
  // only --ocr wants the reading, and opening a browser on an empty form
  // after it is a surprise, so the browser is opened only when there is
  // something to put in it.
  if (options.dryRun || options.readOnly) {
    return;
  }

  await verifyAddresses(resolved.applicant);
  fs.mkdirSync(options.out, { recursive: true });

  const uploads = {};
  const describe = (prepared) =>
    `${prepared.bytes} bytes${prepared.cropped ? ', data page cut out' : ''}` +
    `${prepared.unchanged ? ', otherwise unchanged' : `, re-encoded at q${prepared.quality}`}`;

  if (options.portrait) {
    const out = path.join(options.out, 'portrait.jpg');
    const prepared = await prepareDocument(options.portrait, out);
    uploads.portraitPhoto = prepared.path;
    console.log(`Portrait: ${prepared.path} (${describe(prepared)})`);
  }
  if (options.passport) {
    const out = path.join(options.out, 'passport.jpg');
    // A photo may show the whole passport, so the data page is cut out first.
    const prepared = await prepareDocument(options.passport, out, {
      crop: true,
    });
    uploads.passportPage = prepared.path;
    console.log(`Passport page: ${prepared.path} (${describe(prepared)})`);
  }

  const { browser, page } = await openForm({ headless: false });

  try {
    const result = await fillAndCapture(page, resolved.applicant, {
      uploads,
      screenshot: options.screenshot
        ? path.join(options.out, 'evisa-form.png')
        : null,
    });
    reportFill(result);
    if (result.screenshot) {
      console.log(`Screenshot: ${result.screenshot}`);
    }

    console.log('\nThe form is filled but NOT submitted.');
    console.log('Review every field in the browser, then submit it yourself.');

    if (options.keepOpen) {
      console.log('Press Ctrl+C when you are done.');
      await new Promise(() => {});
    }
  } finally {
    if (!options.keepOpen) {
      await browser.close();
    }
  }
}

// Only run when executed directly, so the helpers above stay importable.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
