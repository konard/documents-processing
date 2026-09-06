// evisa-passport.mjs
//
// Reads applicant data off a passport data page and prepares the two images the
// e-visa form uploads. Field values come from the machine-readable zone, whose
// check digits let us tell a confident read from a guess.

import fs from 'node:fs';
import path from 'node:path';
import { renderImage, regionCanvas, upscale, ocrCanvas } from './ocr-lib.mjs';
import { parseMrzLine1, parseMrzLine2 } from './mrz-lib.mjs';
import { PHOTO_RULES, countryName, sexLabel } from './evisa-schema.mjs';

/** The MRZ occupies the bottom ~11% of a TD3 passport data page. */
const MRZ_REGION = { x: 0, y: 0.883, w: 1, h: 0.112 };
const MRZ_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';

/**
 * Reads the MRZ from a rendered passport page and converts it to schema fields.
 *
 * Every MRZ field carries a check digit. When one fails the value is still
 * returned, but listed in `unverified` so the caller can require review rather
 * than silently submitting a misread passport number.
 */
export async function readPassportMrz(imagePath) {
  const image = await renderImage(imagePath);
  const canvas = upscale(regionCanvas(image, MRZ_REGION), 3);
  const text = ocrCanvas(canvas, { whitelist: MRZ_WHITELIST, psm: 6 });

  const lines = text
    .split('\n')
    .map((line) => line.replace(/\s/g, ''))
    .filter((line) => line.length > 25);

  let line1 = null;
  let line2 = null;
  for (const line of lines) {
    if (!line1 && /^P[A-Z<]/.test(line)) {
      line1 = parseMrzLine1(line);
    } else if (!line2) {
      line2 = parseMrzLine2(line);
    }
  }

  if (!line2) {
    return { data: {}, unverified: [], mrzFound: false };
  }

  const unverified = [];
  if (!line2.passportCheckOk) {
    unverified.push('passportNumber');
  }
  if (!line2.dobCheckOk) {
    unverified.push('dateOfBirth');
  }
  if (!line2.expiryCheckOk) {
    unverified.push('passportExpiryDate');
  }

  const data = {
    passportNumber: line2.passportNumber,
    dateOfBirth: line2.dob,
    passportExpiryDate: line2.expiry,
    nationality: countryName(line2.nationality),
    sex: sexLabel(line2.sex),
  };
  if (line1) {
    data.surname = line1.surname;
    data.givenName = line1.given;
  }

  for (const key of Object.keys(data)) {
    if (!data[key]) {
      delete data[key];
    }
  }

  return { data, unverified, mrzFound: true };
}

/**
 * Finds the passport data page inside a larger scan and crops it out.
 *
 * The page is detected as the dominant document rectangle via `sharp`'s trim,
 * which removes the uniform scanner background around the document.
 */
export async function cropPassportPage(inputPath, outputPath) {
  const sharp = (await import('sharp')).default;
  const image = sharp(inputPath, { failOn: 'none' });
  const meta = await image.metadata();

  // `trim` removes a uniform border; the offsets it reports tell us where the
  // document sits on the platen.
  const trimmed = await sharp(inputPath, { failOn: 'none' })
    .trim({ threshold: 20 })
    .toBuffer({ resolveWithObject: true })
    .catch(() => null);

  if (!trimmed) {
    await sharp(inputPath, { failOn: 'none' })
      .jpeg({ quality: 92 })
      .toFile(outputPath);
    return { cropped: false, width: meta.width, height: meta.height };
  }

  await sharp(trimmed.data).jpeg({ quality: 92 }).toFile(outputPath);
  return {
    cropped:
      trimmed.info.width !== meta.width || trimmed.info.height !== meta.height,
    width: trimmed.info.width,
    height: trimmed.info.height,
  };
}

/**
 * Renders any supported input (including a PDF page) to a JPEG that satisfies
 * the upload rules: JPEG, under 2 MB, and a 4:6 portrait aspect for the photo.
 */
export async function prepareUploadImage(
  inputPath,
  outputPath,
  { portrait = false } = {}
) {
  const sharp = (await import('sharp')).default;

  let source = inputPath;
  let cleanup = null;
  if (path.extname(inputPath).toLowerCase() === '.pdf') {
    const canvas = await renderImage(inputPath);
    source = `${outputPath}.source.png`;
    fs.writeFileSync(source, canvas.toBuffer('image/png'));
    cleanup = source;
  }

  let pipeline = sharp(source, { failOn: 'none' }).rotate();
  if (portrait) {
    // The form asks for a 4x6 cm portrait, so match that 2:3 aspect ratio.
    pipeline = pipeline.resize(800, 1200, {
      fit: 'cover',
      position: 'attention',
    });
  }

  let quality = 92;
  let buffer = await pipeline.jpeg({ quality }).toBuffer();
  // Step the quality down until the file clears the form's 2 MB ceiling.
  while (buffer.length > PHOTO_RULES.maxBytes && quality > 40) {
    quality -= 10;
    buffer = await pipeline.jpeg({ quality }).toBuffer();
  }
  fs.writeFileSync(outputPath, buffer);
  if (cleanup) {
    fs.rmSync(cleanup, { force: true });
  }

  return { path: outputPath, bytes: buffer.length, quality };
}
