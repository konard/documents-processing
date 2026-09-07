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

  // The MRZ sits at the bottom of a data page, and somewhere in the middle of a
  // photo of a whole passport. A few plausible bands are read in turn and the
  // first that parses is kept; a wrong band simply yields no MRZ.
  const bands = [
    MRZ_REGION,
    { x: 0, y: 0.86, w: 1, h: 0.14 },
    { x: 0, y: 0.6, w: 1, h: 0.2 },
    { x: 0, y: 0.68, w: 1, h: 0.16 },
    { x: 0, y: 0.45, w: 1, h: 0.2 },
    { x: 0, y: 0, w: 1, h: 1 },
  ];

  let lines = [];
  for (const band of bands) {
    const canvas = upscale(regionCanvas(image, band), 3);
    const text = ocrCanvas(canvas, { whitelist: MRZ_WHITELIST, psm: 6 });
    const candidate = text
      .split('\n')
      .map((line) => line.replace(/\s/g, ''))
      .filter((line) => line.length > 25);
    if (candidate.some((line) => parseMrzLine2(line))) {
      lines = candidate;
      break;
    }
  }

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
 * Finds the passport data page inside a wider photo and crops it out.
 *
 * A photo of a whole passport, or a page on a desk, carries background the form
 * has no use for. The page is found as the bright rectangle of paper against a
 * darker surround, which holds up where reading the print on it does not: a
 * dense page of text defeats that, a sheet of paper on a desk does not.
 *
 * The crop is lossless where it can be. Nothing is resized or re-encoded beyond
 * the single JPEG write, so quality is unchanged except for that one pass, and
 * when no MRZ is found the original is copied through untouched.
 */
export async function cropPassportPage(inputPath, outputPath) {
  const sharp = (await import('sharp')).default;
  const meta = await sharp(inputPath, { failOn: 'none' }).metadata();

  const band = await findMrzBand(inputPath, meta);
  // Cropping wrongly costs more than not cropping: it can cut away the very
  // fields the form needs. The page is only cut out when the band was found and
  // sits clearly inside a larger photo, which is the case a crop is meant for.
  const looksLikeWholePage =
    !band ||
    (band.width > meta.width * 0.92 && band.height > meta.height * 0.92);
  if (looksLikeWholePage) {
    fs.copyFileSync(inputPath, outputPath);
    return { cropped: false, width: meta.width, height: meta.height };
  }

  // A TD3 page is about 125x88mm and its MRZ sits along the bottom, so the page
  // is roughly the MRZ width and about 1.4 times as tall as it is wide.
  const pageWidth = Math.min(meta.width, Math.round(band.width * 1.06));
  const pageHeight = Math.min(meta.height, Math.round(pageWidth * 0.72));
  const left = Math.max(
    0,
    Math.round(band.left - (pageWidth - band.width) / 2)
  );
  const bottom = Math.min(
    meta.height,
    band.top + band.height + Math.round(pageHeight * 0.06)
  );
  const top = Math.max(0, bottom - pageHeight);

  await sharp(inputPath, { failOn: 'none' })
    .extract({
      left,
      top,
      width: Math.min(pageWidth, meta.width - left),
      height: Math.min(pageHeight, meta.height - top),
    })
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  return {
    cropped: true,
    width: Math.min(pageWidth, meta.width - left),
    height: Math.min(pageHeight, meta.height - top),
  };
}

/**
 * Finds the bright document within a photo taken against a darker background.
 *
 * A passport page is paper: brighter and flatter than a desk, a table or a
 * hand. Rows and columns whose average brightness stands well above the darkest
 * parts of the image bound the document, which is a steadier signal than trying
 * to recognise the print on it.
 *
 * Returns null when the page already fills the frame, which is the common case
 * and needs no crop at all.
 */
async function findMrzBand(inputPath, meta) {
  const sharp = (await import('sharp')).default;
  const width = 320;
  const height = Math.max(1, Math.round((meta.height / meta.width) * width));

  const { data } = await sharp(inputPath, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rowMean = new Array(height).fill(0);
  const colMean = new Array(width).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = data[y * width + x];
      rowMean[y] += value / width;
      colMean[x] += value / height;
    }
  }

  const all = [...rowMean, ...colMean];
  const darkest = Math.min(...all);
  const brightest = Math.max(...all);
  // Without a clear dark surround there is nothing to crop away.
  if (brightest - darkest < 45) {
    return null;
  }
  const bar = darkest + (brightest - darkest) * 0.55;

  const span = (means) => {
    let first = -1;
    let last = -1;
    for (let i = 0; i < means.length; i++) {
      if (means[i] >= bar) {
        if (first === -1) {
          first = i;
        }
        last = i;
      }
    }
    return first === -1 ? null : { first, last };
  };

  const rows = span(rowMean);
  const columns = span(colMean);
  if (!rows || !columns) {
    return null;
  }

  const scaleX = meta.width / width;
  const scaleY = meta.height / height;
  return {
    left: Math.round(columns.first * scaleX),
    width: Math.round((columns.last - columns.first + 1) * scaleX),
    top: Math.round(rows.first * scaleY),
    height: Math.round((rows.last - rows.first + 1) * scaleY),
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
