// mrz-readers.mjs
//
// Adapters that put every MRZ reader behind one interface, so the benchmark can
// compare them without knowing how each works.
//
// A reader declares whether it is installed and reads one image into the common
// field names. Anything not installed is skipped, so the benchmark runs with
// whatever happens to be available.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

/** Turns a YYMMDD MRZ date into YYYY-MM-DD using the same pivots we use. */
function expandDate(digits, kind) {
  if (!/^\d{6}$/.test(String(digits ?? ''))) {
    return digits ?? null;
  }
  const yy = Number(String(digits).slice(0, 2));
  const year =
    kind === 'future'
      ? yy < (new Date().getUTCFullYear() % 100) - 10
        ? 2100 + yy
        : 2000 + yy
      : yy <= 30
        ? 2000 + yy
        : 1900 + yy;
  return `${year}-${String(digits).slice(2, 4)}-${String(digits).slice(4, 6)}`;
}

/**
 * This repository's own reader: Tesseract over a fixed MRZ band, with the
 * check-digit repair in mrz-lib.
 */
const builtIn = {
  name: 'built-in (tesseract + mrz-lib)',
  license: 'Unlicense (this repo)',
  isAvailable() {
    return Promise.resolve(true);
  },
  async read(image) {
    const { readPassportMrz } = await import('./evisa-passport.mjs');
    const result = await readPassportMrz(image);
    return {
      documentNumber: result.data.passportNumber,
      birthDate: result.data.dateOfBirth,
      expirationDate: result.data.passportExpiryDate,
      surname: result.data.surname,
      givenName: result.data.givenName,
    };
  },
};

/**
 * Our OCR of the MRZ band, handed to the MIT `mrz` library for parsing. Pairing
 * it with the built-in reader isolates how much of a result comes from the
 * parser and how much from the OCR.
 */
const builtInOcrMrzParse = {
  name: 'tesseract + mrz (npm, MIT)',
  license: 'MIT',
  async isAvailable() {
    try {
      await import('mrz');
      return true;
    } catch {
      return false;
    }
  },
  async read(image) {
    const [{ parse }, ocr] = await Promise.all([
      import('mrz'),
      import('./ocr-lib.mjs'),
    ]);
    const img = await ocr.renderImage(image);
    const canvas = ocr.upscale(
      ocr.regionCanvas(img, { x: 0, y: 0.883, w: 1, h: 0.112 }),
      3
    );
    const text = ocr.ocrCanvas(canvas, {
      whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
      psm: 6,
    });
    const lines = text
      .split('\n')
      .map((line) => line.replace(/\s/g, ''))
      .filter((line) => line.length > 25)
      .slice(0, 2)
      .map((line) => line.padEnd(44, '<').slice(0, 44));
    if (lines.length < 2) {
      throw new Error('did not find two MRZ lines');
    }
    const parsed = parse(lines);
    const f = parsed.fields;
    return {
      documentNumber: f.documentNumber,
      birthDate: expandDate(f.birthDate, 'past'),
      expirationDate: expandDate(f.expirationDate, 'future'),
      surname: f.lastName,
      givenName: f.firstName,
    };
  },
};

/** PassportEye: the reference Python implementation, MIT licensed. */
const passportEye = {
  name: 'PassportEye (python, MIT)',
  license: 'MIT',
  async isAvailable() {
    try {
      await run('python3', ['-c', 'import passporteye'], { timeout: 60000 });
      return true;
    } catch {
      return false;
    }
  },
  async read(image) {
    const script = `
import json, sys
from passporteye import read_mrz
mrz = read_mrz(sys.argv[1])
if mrz is None:
    print(json.dumps({}))
else:
    d = mrz.to_dict()
    print(json.dumps({
        'documentNumber': d.get('number'),
        'birthDate': d.get('date_of_birth'),
        'expirationDate': d.get('expiration_date'),
        'surname': d.get('surname'),
        'givenName': d.get('names'),
    }))
`;
    const { stdout } = await run('python3', ['-c', script, image], {
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
    const raw = JSON.parse(stdout.trim().split('\n').pop());
    return {
      ...raw,
      birthDate: expandDate(raw.birthDate, 'past'),
      expirationDate: expandDate(raw.expirationDate, 'future'),
    };
  },
};

/**
 * mrz-scanner, which locates the MRZ region itself, with no fixed band.
 *
 * Benchmarked for reference only. It is AGPL-3.0-or-later, so depending on it
 * would impose that license on anything shipped with it, which does not suit a
 * public-domain package.
 */
const mrzScanner = {
  name: 'mrz-scanner (AGPL - reference only)',
  license: 'AGPL-3.0-or-later',
  isAvailable() {
    return Promise.resolve(
      fs.existsSync('node_modules/mrz-scanner/src/mrz2json.js')
    );
  },
  async read(image) {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'mrz-scan-'));
    try {
      // Its CLI rejects lines shorter than the TD3 width, so its own OCR is
      // used and the lines are padded here before parsing. Without this the
      // reader fails on scans it actually read correctly.
      const script = `
        const fs = require('fs-extra');
        const detect = require('${path.resolve('node_modules/mrz-scanner/src/detect-and-parse-mrz.js')}')({ fs });
        detect(process.argv[1], {})
          .then((r) => console.log(JSON.stringify({ lines: (r && r.ocrized) || null })))
          .catch((e) => console.log(JSON.stringify({ error: String((e && e.message) || e), lines: (e && e.ocrized) || null })));
      `;
      const { stdout } = await run('node', ['-e', script, image], {
        timeout: 180000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const out = JSON.parse(stdout.trim().split('\n').pop());
      if (!out.lines || out.lines.length < 2) {
        throw new Error(out.error || 'no MRZ lines detected');
      }
      const { parse } = await import('mrz');
      const lines = out.lines
        .slice(0, 2)
        .map((line) => String(line).padEnd(44, '<').slice(0, 44));
      const f = parse(lines).fields;
      return {
        documentNumber: f.documentNumber,
        birthDate: expandDate(f.birthDate, 'past'),
        expirationDate: expandDate(f.expirationDate, 'future'),
        surname: f.lastName,
        givenName: f.firstName,
      };
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  },
};

/**
 * Pulls the two MRZ lines out of whatever a general OCR engine returned.
 *
 * A full-page read gives every line on the page in no guaranteed order, so the
 * MRZ is found by shape: line 2 of a TD3 document is mostly digits and carries
 * a sex marker.
 */
export function findMrzLines(lines) {
  const cleaned = lines
    .map((line) =>
      String(line)
        .toUpperCase()
        .replace(/[^A-Z0-9<]/g, '')
    )
    .filter((line) => line.length >= 25);

  const isLine1 = (line) => /^P[A-Z<]/.test(line) && line.includes('<<');
  // Line 2 is mostly digits and ends in filler. Matching on that shape keeps it
  // recognizable when OCR drops or merges a character, which happens on the
  // nationality code in particular.
  const isLine2 = (line) => {
    if (isLine1(line) || line.length < 28) {
      return false;
    }
    const digits = (line.match(/[0-9]/g) ?? []).length;
    return digits >= 18 && /[MFX<]/.test(line) && /^[A-Z0-9<]+$/.test(line);
  };

  const second = cleaned.find(isLine2);
  const first = cleaned.find(isLine1);
  if (!second) {
    return null;
  }
  return [
    (first ?? '').padEnd(44, '<').slice(0, 44),
    second.padEnd(44, '<').slice(0, 44),
  ];
}

/** Builds a reader around a general OCR engine that reads the whole page. */
function generalOcrReader({ name, license, script, check, args = [] }) {
  return {
    name,
    license,
    async isAvailable() {
      try {
        await run('python3', ['-c', check], { timeout: 90000 });
        return true;
      } catch {
        return false;
      }
    },
    async read(image) {
      const { stdout } = await run('python3', [script, ...args, image], {
        timeout: 300000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const { lines } = JSON.parse(stdout.trim().split('\n').pop());
      const mrz = findMrzLines(lines ?? []);
      if (!mrz) {
        throw new Error('no MRZ found in the page text');
      }
      const { parse } = await import('mrz');
      const f = parse(mrz).fields;
      return {
        documentNumber: f.documentNumber,
        birthDate: expandDate(f.birthDate, 'past'),
        expirationDate: expandDate(f.expirationDate, 'future'),
        surname: f.lastName,
        givenName: f.firstName,
        // Kept so a caller can cross-check the printed zone against the MRZ.
        pageText: lines,
      };
    },
  };
}

const engineDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ocr-engines'
);

/** Apple's Vision framework: a general OCR engine built into macOS. */
const macVision = generalOcrReader({
  name: 'macOS Vision (general, system)',
  license: 'system framework (macOS only)',
  script: path.join(engineDir, 'vision-ocr.py'),
  check: 'import Vision, Quartz',
});

/**
 * PaddleOCR: the most widely used open-source OCR engine, Apache-2.0 and
 * CPU-only, so it needs no GPU.
 */
const paddleOcr = generalOcrReader({
  name: 'PaddleOCR (general, Apache-2.0)',
  license: 'Apache-2.0',
  script: path.join(engineDir, 'paddle-ocr.py'),
  check: 'from paddleocr import PaddleOCR',
});

/**
 * PaddleOCR restricted to the MRZ band.
 *
 * Its cost scales with the area searched, so narrowing to the strip that holds
 * the machine-readable zone is several times faster at the same accuracy.
 */
const paddleOcrBand = generalOcrReader({
  name: 'PaddleOCR band (general, Apache-2.0)',
  license: 'Apache-2.0',
  script: path.join(engineDir, 'paddle-ocr.py'),
  args: ['--band'],
  check: 'from paddleocr import PaddleOCR',
});

/** RapidOCR: a general ONNX-based engine, portable across platforms. */
const rapidOcr = generalOcrReader({
  name: 'RapidOCR (general, Apache-2.0)',
  license: 'Apache-2.0',
  script: path.join(engineDir, 'rapid-ocr.py'),
  check: 'from rapidocr_onnxruntime import RapidOCR',
});

export const availableReaders = [
  builtIn,
  builtInOcrMrzParse,
  passportEye,
  mrzScanner,
  macVision,
  rapidOcr,
  paddleOcr,
  paddleOcrBand,
];
