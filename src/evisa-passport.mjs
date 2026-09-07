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
import { normalizeName } from './evisa-data.mjs';

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
    // A cropped page puts the zone lower in the frame, and some passports
    // print it on a tinted band that needs a taller slice to catch cleanly.
    { x: 0, y: 0.72, w: 1, h: 0.28 },
    { x: 0, y: 0.78, w: 1, h: 0.22 },
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
    // From OCR, so a digit in a name is a misread and is mapped back.
    data.surname = normalizeName(line1.surname, { fromOcr: true });
    data.givenName = normalizeName(line1.given, { fromOcr: true });
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
  // The bottom edge is measured from the zone itself, with a margin below it
  // scaled to the zone's own height. Deriving it from an estimated page height
  // can land above the zone and cut it off.
  const bottom = Math.min(
    meta.height,
    band.top + band.height + Math.round(band.height * 0.8)
  );
  // Prefer the fold when the photo shows one: it is where the page actually
  // ends, while the proportional height is only an estimate.
  const fold = await findFoldAbove(inputPath, meta, band.top);
  const estimated = Math.max(0, bottom - pageHeight);
  const top = fold !== null && fold < bottom ? fold : estimated;

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
 * Finds the fold between two pages of an open passport.
 *
 * A spread photographed flat shows the seam as an abrupt change in brightness
 * across a row: one page ends, a shadowed crease follows, the next begins.
 * Cutting on that line removes the facing page cleanly, where a cut measured
 * only from the machine-readable zone leaves a sliver of it behind.
 *
 * Only the region above the zone is searched, and only for a step large enough
 * to be a page edge; a flat scan of a single page has none and gets no cut.
 */
async function findFoldAbove(inputPath, meta, mrzTop) {
  const sharp = (await import('sharp')).default;
  const width = 500;
  const height = Math.max(1, Math.round((meta.height / meta.width) * width));
  const limit = Math.round((mrzTop / meta.height) * height);

  const { data } = await sharp(inputPath, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const means = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += data[y * width + x];
    }
    means.push(sum / width);
  }

  // A fold is a dark line with paper on both sides, so it shows as a trough:
  // darker than the rows above it and the rows below. Measuring that depth
  // separates it from the edge of a page, which is dark on one side only, and
  // from a row of print, which is dark without either side being bright.
  const troughs = [];
  for (let y = Math.round(height * 0.15); y < limit - height * 0.15; y++) {
    const above =
      means.slice(y - 10, y - 2).reduce((sum, value) => sum + value, 0) / 8;
    const below =
      means.slice(y + 3, y + 11).reduce((sum, value) => sum + value, 0) / 8;
    // The shallower side decides: a true line is bright on both.
    const depth = Math.min(above, below) - means[y];
    if (depth > 15) {
      troughs.push({ y, depth });
    }
  }
  if (troughs.length === 0) {
    return null;
  }

  // Keep the deepest, then take the lowest trough within reach of it, since
  // the crease can register as two lines and the lower one is the true edge.
  const deepest = troughs.reduce((best, candidate) =>
    candidate.depth > best.depth ? candidate : best
  );
  const nearby = troughs.filter(
    (trough) =>
      trough.depth > deepest.depth * 0.6 &&
      Math.abs(trough.y - deepest.y) < height * 0.06
  );
  // The line has thickness, and the rows around its darkest point belong to
  // it. Cutting through the middle of that run leaves the lower half of the
  // fold showing: enough to see the page was photographed whole, while the
  // remaining edge is close to the paper's own colour.
  const first = nearby[0].y;
  const last = nearby[nearby.length - 1].y;
  const middle = Math.round((first + last) / 2);
  return Math.round((middle / height) * meta.height);
}

/**
 * Locates the machine-readable zone by the rows that carry it.
 *
 * The zone is two lines of evenly spaced glyphs running most of the page width,
 * so those rows cross between ink and paper far more often than any other. That
 * holds whether the page fills the frame, sits on a desk, or is one half of an
 * open spread, which page-edge detection does not.
 *
 * MRZ print is grey on white, so the ink threshold is deliberately generous; a
 * darker one misses the band completely.
 */
async function findMrzBand(inputPath, meta) {
  const sharp = (await import('sharp')).default;
  const width = 500;
  const height = Math.max(1, Math.round((meta.height / meta.width) * width));

  const { data } = await sharp(inputPath, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rows = [];
  for (let y = 0; y < height; y++) {
    let crossings = 0;
    let first = -1;
    let last = -1;
    let wasInk = false;
    for (let x = 0; x < width; x++) {
      const ink = data[y * width + x] < 170;
      if (ink !== wasInk) {
        crossings += 1;
        wasInk = ink;
      }
      if (ink) {
        if (first === -1) {
          first = x;
        }
        last = x;
      }
    }
    rows.push({ crossings, first, last });
  }

  // The zone runs along the bottom of a data page. Searching only the lower
  // part keeps a fold from being mistaken for it: a crease crosses between
  // light and dark more often than the printed glyphs do, so on a spread it
  // would otherwise win.
  const lowest = Math.round(height * 0.6);
  const lower = rows.slice(lowest);
  const busiest = Math.max(...lower.map((row) => row.crossings));
  if (busiest < 30) {
    return null;
  }

  // Group the busy rows that sit close together; the lowest such group is the
  // machine-readable zone, since nothing on a passport sits below it.
  const marked = rows
    .map((row, y) => ({ ...row, y }))
    .filter((row) => row.y >= lowest && row.crossings >= busiest * 0.75);
  if (marked.length === 0) {
    return null;
  }

  const gap = Math.max(4, Math.round(height * 0.04));
  const groups = [[marked[0]]];
  for (const row of marked.slice(1)) {
    const current = groups[groups.length - 1];
    if (row.y - current[current.length - 1].y <= gap) {
      current.push(row);
    } else {
      groups.push([row]);
    }
  }

  const band = groups[groups.length - 1];
  const scaleX = meta.width / width;
  const scaleY = meta.height / height;
  return {
    left: Math.round(Math.min(...band.map((row) => row.first)) * scaleX),
    width: Math.round(
      (Math.max(...band.map((row) => row.last)) -
        Math.min(...band.map((row) => row.first)) +
        1) *
        scaleX
    ),
    top: Math.round(band[0].y * scaleY),
    height: Math.round((band[band.length - 1].y - band[0].y + 1) * scaleY),
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
