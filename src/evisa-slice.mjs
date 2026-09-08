// evisa-slice.mjs
//
// Cuts a tall page capture into sections small enough to read on a phone.
//
// The filled application runs to some nine screens, and the capture of it is
// a single image thousands of pixels tall. Telegram scales such an image down
// to fit a message, which leaves the text too small to check, so the whole
// form goes as a PDF and these sections go beside it as pictures the applicant
// can actually read.
//
// Cuts are placed in the blank bands between rows. A fixed height would sooner
// or later fall across a line of text or split a label from its value, which
// is precisely the field the applicant is trying to verify.

import fs from 'node:fs';
import path from 'node:path';

/** The tallest a section may be, as a multiple of the image's width. */
const MAX_ASPECT = 1.6;

/** The shortest a section may be, as a multiple of the image's width. */
const MIN_ASPECT = 0.45;

/** How near white a row must average to count as blank, in grey levels. */
const BLANK_LEVEL = 244;

/**
 * Rows that hold no ink, as a flat array of 0 and 1 by row.
 *
 * The page is white behind its text, so a row whose darkest pixel is still
 * near white lies between two rows of content and is somewhere a cut can go
 * without crossing anything.
 */
export async function blankRows(imagePath) {
  const sharp = (await import('sharp')).default;
  // One column of averages per row: the page reduced to its vertical profile,
  // which is all a cut needs and a fraction of the pixels.
  const { data, info } = await sharp(imagePath, { failOn: 'none' })
    .greyscale()
    .resize({ width: 1, fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rows = new Uint8Array(info.height);
  for (let row = 0; row < info.height; row++) {
    rows[row] = data[row] >= BLANK_LEVEL ? 1 : 0;
  }
  return rows;
}

/**
 * The middle of each band of blank rows, as row numbers.
 *
 * A cut down the middle of a gap leaves an even margin above and below it, so
 * neither section starts or ends flush against its text.
 */
export function gapCentres(rows, { minGap = 6 } = {}) {
  const centres = [];
  let start = null;
  for (let row = 0; row <= rows.length; row++) {
    if (rows[row]) {
      start ??= row;
      continue;
    }
    if (start !== null && row - start >= minGap) {
      centres.push(Math.floor((start + row) / 2));
    }
    start = null;
  }
  return centres;
}

/**
 * Where to cut a page of the given height, as row numbers.
 *
 * Each section is grown to the tallest it may be, then pulled back to the last
 * gap that leaves it above the shortest. A stretch of page with no gap in it
 * at all is cut at the height limit, since a section that never ends is worse
 * than one that splits a row.
 */
export function planCuts(height, width, centres) {
  const longest = Math.round(width * MAX_ASPECT);
  const shortest = Math.round(width * MIN_ASPECT);
  const cuts = [];
  let top = 0;
  while (height - top > longest) {
    const limit = top + longest;
    const gap = lastGapBefore(centres, limit, top + shortest);
    const cut = gap ?? limit;
    cuts.push(cut);
    top = cut;
  }
  return cuts;
}

/** The last gap at or before `limit` that still lies at or after `floor`. */
function lastGapBefore(centres, limit, floor) {
  let best = null;
  for (const centre of centres) {
    if (centre > limit) {
      break;
    }
    if (centre >= floor) {
      best = centre;
    }
  }
  return best;
}

/**
 * Cuts a capture into readable sections and writes them as JPEG.
 *
 * Returns the files written, each with the band of the original it covers, so
 * a caption can say which part of the form the applicant is looking at.
 */
export async function sliceImage(imagePath, outputDir, { quality = 82 } = {}) {
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(outputDir, { recursive: true });
  const image = sharp(imagePath, { failOn: 'none' });
  const { width, height } = await image.metadata();

  const rows = await blankRows(imagePath);
  const cuts = planCuts(height, width, gapCentres(rows));
  const edges = [0, ...cuts, height];

  const sections = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const top = edges[i];
    const band = edges[i + 1] - top;
    const target = path.join(
      outputDir,
      `section-${String(i + 1).padStart(2, '0')}.jpg`
    );
    await sharp(imagePath, { failOn: 'none' })
      .extract({ left: 0, top, width, height: band })
      .jpeg({ quality })
      .toFile(target);
    sections.push({
      path: target,
      index: i + 1,
      of: edges.length - 1,
      top,
      height: band,
    });
  }
  return sections;
}

/**
 * Binds the sections into one PDF, a page each.
 *
 * A PDF is what the applicant keeps and can print. Paging it at the same cuts
 * keeps every field whole on its page, and each page opens as a screenful.
 */
export async function sectionsToPdf(sections, outputPath) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (const section of sections) {
    const image = await pdf.embedJpg(fs.readFileSync(section.path));
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, await pdf.save({ useObjectStreams: false }));
  return outputPath;
}
