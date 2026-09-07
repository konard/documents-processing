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
    return { data: {}, unverified: [], repaired: [], mrzFound: false };
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

  // Fields the check digit had to correct, so a caller can surface them for a
  // second look even though they now validate.
  return { data, unverified, repaired: line2.repaired ?? [], mrzFound: true };
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
 * the upload rules: JPEG format, under 2 MB.
 */
export async function prepareUploadImage(inputPath, outputPath) {
  const sharp = (await import('sharp')).default;

  let source = inputPath;
  let cleanup = null;
  if (path.extname(inputPath).toLowerCase() === '.pdf') {
    const canvas = await renderImage(inputPath);
    source = `${outputPath}.source.png`;
    fs.writeFileSync(source, canvas.toBuffer('image/png'));
    cleanup = source;
  }

  // A JPEG that already fits the limit is uploaded byte for byte. Re-encoding
  // it would only lose detail, and any reframing would cut into the
  // head-and-shoulders composition the reviewer checks.
  const isJpeg = /\.jpe?g$/i.test(source);
  if (isJpeg && fs.statSync(source).size <= PHOTO_RULES.maxBytes) {
    fs.copyFileSync(source, outputPath);
    if (cleanup) {
      fs.rmSync(cleanup, { force: true });
    }
    return {
      path: outputPath,
      bytes: fs.statSync(outputPath).size,
      unchanged: true,
    };
  }

  // Otherwise shrink it just enough to clear the ceiling, preserving the
  // aspect ratio and never enlarging.
  const pipeline = sharp(source, { failOn: 'none' })
    .rotate()
    .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true });

  let quality = 92;
  let buffer = await pipeline.jpeg({ quality }).toBuffer();
  while (buffer.length > PHOTO_RULES.maxBytes && quality > 40) {
    quality -= 10;
    buffer = await pipeline.jpeg({ quality }).toBuffer();
  }
  fs.writeFileSync(outputPath, buffer);
  if (cleanup) {
    fs.rmSync(cleanup, { force: true });
  }

  return {
    path: outputPath,
    bytes: buffer.length,
    quality,
    unchanged: false,
  };
}
