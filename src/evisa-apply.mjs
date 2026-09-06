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
import {
  FORM_URL,
  acceptNoteModal,
  waitForForm,
  fillForm,
  screenshotForm,
} from './evisa-fill.mjs';

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
    } else if (arg === '--screenshot') {
      options.screenshot = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--emit-lino') {
      options.emitLino = true;
    } else if (arg === '--ocr') {
      options.ocr = true;
    } else if (arg === '--no-keep-open') {
      options.keepOpen = false;
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
      const { readPassportMrz } = await import('./evisa-passport.mjs');
      const result = await readPassportMrz(passportDoc.path);
      if (result.mrzFound) {
        // OCR goes first so any explicit record overrides it.
        records.unshift({
          name: `ocr:${path.basename(passportDoc.path)}`,
          data: result.data,
        });
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

  if (options.dryRun) {
    return;
  }

  fs.mkdirSync(options.out, { recursive: true });

  const uploads = {};
  const { prepareUploadImage } = await import('./evisa-passport.mjs');
  if (options.portrait) {
    const out = path.join(options.out, 'portrait.jpg');
    const prepared = await prepareUploadImage(options.portrait, out, {
      portrait: true,
    });
    uploads.portraitPhoto = prepared.path;
    console.log(
      `Prepared portrait: ${prepared.path} (${prepared.bytes} bytes)`
    );
  }
  if (options.passport) {
    const out = path.join(options.out, 'passport.jpg');
    const prepared = await prepareUploadImage(options.passport, out);
    uploads.passportPage = prepared.path;
    console.log(
      `Prepared passport page: ${prepared.path} (${prepared.bytes} bytes)`
    );
  }

  const { launchBrowser } = await import('browser-commander');
  const { browser, page } = await launchBrowser({
    engine: 'playwright',
    headless: false,
  });

  try {
    await page.goto(FORM_URL, { waitUntil: 'domcontentloaded' });
    await acceptNoteModal(page);
    await waitForForm(page);

    const result = await fillForm(page, resolved.applicant, { uploads });
    console.log(`Filled ${result.filled.length} fields.`);
    for (const failure of result.failures) {
      console.log(`  could not fill ${failure.field}: ${failure.error}`);
    }

    if (options.screenshot) {
      const shot = await screenshotForm(
        page,
        path.join(options.out, 'evisa-form.png')
      );
      console.log(`Screenshot: ${shot}`);
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
