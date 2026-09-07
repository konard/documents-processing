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

// The machine-readable zone is Latin-only by design, so an English-trained
// engine reads it whatever language the rest of the page is in. The printed
// side of a Russian passport is bilingual, and reading its Cyrillic half would
// need a Russian model that is not installed here (`tesseract --list-langs`
// shows eng alone). Where a value is printed in both, the Latin half is the one
// the form wants anyway, which is what preferEnglishHalf keeps.

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
  const fold = await findFoldAbove(inputPath, band.top);
  const estimated = Math.max(0, bottom - pageHeight);
  const top = fold !== null && fold < bottom ? fold : estimated;
  // The top comes from the fold and the bottom from the zone, so the height
  // is whatever lies between them; a fixed height measured from a high fold
  // would end above the zone.
  const width = Math.min(pageWidth, meta.width - left);
  const height = bottom - top;

  await sharp(inputPath, { failOn: 'none' })
    .extract({ left, top, width, height })
    .jpeg({ quality: 95 })
    .toFile(outputPath);

  return { cropped: true, left, top, width, height };
}

/** The least a crease has to darken a column to count, in grey levels. */
const CREASE_DEPTH = 12;

/** The share of columns, in the emptiest third of the width, a seam must cross. */
const SEAM_SHARE = 0.6;

/**
 * Finds the fold between two pages of an open passport.
 *
 * A spread photographed flat shows the seam as a shadowed crease: a thin band
 * darker than the paper just above and just below it, running the whole width
 * of the page. A row of print, a signature rule or the edge of the photo can
 * look the same along one column, so every column is searched on its own for
 * such dips and each row counts the columns that dip there. The seam collects a
 * vote from nearly every column; print gets votes only where its letters are.
 *
 * The thirds of the width are counted separately and the emptiest one decides,
 * because print sits in the middle of a page and a seam does not: a heading or
 * a signature never reaches both margins, however dark it is.
 *
 * The cut goes on the lower edge of the crease, where the paper brightens into
 * the data page's own margin, so no shadow and none of the facing page remain.
 * A flat scan of a single page has no full-width dip and gets no cut. The rows
 * near the top and the machine-readable zone are left out of the search.
 */
export async function findFoldAbove(inputPath, mrzTop) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(inputPath, { failOn: 'none' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const bounds = {
    top: Math.round(height * 0.15),
    floor: Math.round(mrzTop - height * 0.15),
    // The crease is a fixed fraction of a page, so the distances scale with
    // the image: paper is sampled this far above and below a candidate row,
    // and this many rows either side are averaged to quiet the guilloche.
    reach: Math.max(4, Math.round(height * 0.015)),
    blur: Math.max(1, Math.round(height * 0.002)),
  };
  if (bounds.floor - bounds.top < bounds.reach * 4) {
    return null;
  }

  const thirds = countCreaseVotes(data, width, height, bounds);
  const share = (y) =>
    Math.min(...thirds.map((third) => third[y])) / (width / 3);
  let seam = bounds.top;
  for (let y = bounds.top; y < bounds.floor; y++) {
    if (share(y) > share(seam)) {
      seam = y;
    }
  }
  if (share(seam) < SEAM_SHARE) {
    return null;
  }

  // The darkest row is inside the crease. Its lower edge is the steepest
  // brightening below it, which is where the page's own paper begins.
  const rowMean = (y) => {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += data[y * width + x];
    }
    return sum / width;
  };
  let edge = seam;
  let steepest = -Infinity;
  const last = Math.min(height - 2, seam + bounds.reach * 2);
  for (let y = seam; y <= last; y++) {
    const step = rowMean(y + 1) - rowMean(y);
    if (step > steepest) {
      steepest = step;
      edge = y + 1;
    }
  }
  return edge;
}

/**
 * Counts, for every row, the columns that dip dark there with paper on both
 * sides, kept in three tallies for the left, middle and right of the width.
 *
 * A dip is a local peak of how much darker a row is than the paper `reach` rows
 * above and below it. The rows around the peak are counted with it, since the
 * crease wanders by a row or two across the printed pattern.
 */
function countCreaseVotes(data, width, height, { top, floor, reach, blur }) {
  const thirds = [0, 1, 2].map(() => new Float64Array(height));
  const profile = new Float64Array(height);
  const dip = new Float64Array(height);
  const marked = new Uint8Array(height);

  for (let x = 0; x < width; x++) {
    for (let y = blur; y < height - blur; y++) {
      let sum = 0;
      for (let k = -blur; k <= blur; k++) {
        sum += data[(y + k) * width + x];
      }
      profile[y] = sum / (blur * 2 + 1);
    }
    for (let y = top; y < floor; y++) {
      dip[y] = Math.min(profile[y - reach], profile[y + reach]) - profile[y];
    }
    marked.fill(0);
    for (let y = top + 1; y < floor - 1; y++) {
      const isPeak =
        dip[y] >= CREASE_DEPTH && dip[y] >= dip[y - 1] && dip[y] > dip[y + 1];
      if (isPeak) {
        marked.fill(1, y - blur, y + blur + 1);
      }
    }
    const third = thirds[Math.min(2, Math.floor((x * 3) / width))];
    for (let y = top; y < floor; y++) {
      third[y] += marked[y];
    }
  }
  return thirds;
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
