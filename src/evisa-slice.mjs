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
import os from 'node:os';
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
 * Where the page's own sections begin, as row numbers in the capture.
 *
 * The form is written in numbered parts — the images, the personal details,
 * the passport, the trip — and each heading is an `h3`. Cutting there gives
 * the applicant one part of the form per picture, which is how they read it.
 *
 * The capture is taken at the page's own device pixel ratio, so a position in
 * page pixels is scaled to match.
 */
export async function sectionTops(page, scale = 1) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('h3')]
      .filter((heading) => heading.offsetParent !== null)
      .map((heading) => ({
        top: heading.getBoundingClientRect().top + window.scrollY,
        title: heading.innerText.trim(),
      }))
  );
  // A little above each heading, so the heading is not flush with the edge.
  return found
    .map((at) => ({
      top: Math.max(0, Math.round((at.top - 12) * scale)),
      title: at.title,
    }))
    .sort((a, b) => a.top - b.top);
}

/**
 * The band the form itself occupies, without the site's furniture.
 *
 * The banner at the top and the ministry's footer carry nothing the applicant
 * entered and nothing to check. The form ends at its own buttons, which are
 * worth keeping: pressing Next is the next thing that happens.
 */
export async function formBand(page, scale = 1) {
  const band = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) {
      return null;
    }
    const box = form.getBoundingClientRect();
    const buttons = [...document.querySelectorAll('button')]
      .filter((button) => button.offsetParent !== null)
      .map((button) => button.getBoundingClientRect().bottom + window.scrollY);
    const foot = Math.max(box.bottom + window.scrollY, ...buttons);
    return { top: box.top + window.scrollY, bottom: foot };
  });
  if (!band) {
    return null;
  }
  return {
    top: Math.max(0, Math.round((band.top - 16) * scale)),
    bottom: Math.round((band.bottom + 24) * scale),
  };
}

/** A heading cut to something a caption can carry whole. */
function shortTitle(title) {
  const text = String(title).replace(/\s+/g, ' ').trim();
  return text.length > 64 ? `${text.slice(0, 63)}…` : text;
}

/**
 * The part of the page worth showing: from its first ink to its last.
 *
 * A capture opens on the site's banner and ends in its footer, neither of
 * which holds anything the applicant entered.
 */
export function contentBand(rows) {
  let top = 0;
  let bottom = rows.length;
  while (top < rows.length && rows[top]) {
    top++;
  }
  while (bottom > top && rows[bottom - 1]) {
    bottom--;
  }
  return { top, bottom: Math.max(bottom, top + 1) };
}

/**
 * Cuts a capture into readable sections and writes them as JPEG.
 *
 * Returns the files written, each with the band of the original it covers, so
 * a caption can say which part of the form the applicant is looking at.
 */
export async function sliceImage(
  imagePath,
  outputDir,
  { quality = 82, trim = false, tops = null, band: given = null } = {}
) {
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(outputDir, { recursive: true });
  const image = sharp(imagePath, { failOn: 'none' });
  const { width, height } = await image.metadata();

  const rows = await blankRows(imagePath);
  // The site's banner and its footer carry nothing the applicant entered, so
  // they are left off when asked: what is worth checking is the form between.
  // The form's own band when the caller measured it, so the site's banner
  // and footer are left off; otherwise the ink on the page.
  const band = given
    ? { top: given.top, bottom: Math.min(given.bottom, height) }
    : trim
      ? contentBand(rows)
      : { top: 0, bottom: height };
  // The page's own sections when the caller measured them, and otherwise the
  // blank bands between rows.
  // A heading within a screenful of the top opens the first section rather
  // than cutting a sliver off above it.
  const marks = (tops ?? []).filter(
    (at) => at.top > band.top + 400 && at.top < band.bottom - 40
  );
  const cuts = marks.length
    ? marks.map((at) => at.top)
    : planCuts(band.bottom - band.top, width, gapCentres(rows)).map(
        (cut) => cut + band.top
      );
  const edges = [band.top, ...cuts, band.bottom];

  const sections = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const top = edges[i];
    const height2 = edges[i + 1] - top;
    const target = path.join(
      outputDir,
      `section-${String(i + 1).padStart(2, '0')}.jpg`
    );
    await sharp(imagePath, { failOn: 'none' })
      .extract({ left: 0, top, width, height: height2 })
      .jpeg({ quality })
      .toFile(target);
    sections.push({
      path: target,
      index: i + 1,
      of: edges.length - 1,
      title: shortTitle(
        marks[i - 1]?.title ??
          (i === 0 ? 'Photos and passport page' : `Part ${i + 1}`)
      ),
      top,
      height: height2,
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

/**
 * Gives a promise a deadline.
 *
 * Reading a page and sending a file are both calls out to something else —
 * a browser, an upload — and either can stall without ever failing. A step
 * that has not finished in its time gives way to `whenLate`.
 */
export function withDeadline(work, ms, whenLate) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(whenLate), ms);
  });
  // The timer is cleared whichever way the race ends, so a step that
  // finished in time does not hold the process open waiting for its deadline.
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** How long the page is given to say where its sections are. */
const MEASURE_MS = 20_000;

/** How long one upload is given before it is left behind. */
const SEND_MS = 120_000;

export async function sendFormAndSections({
  ctx,
  chatId,
  screenshot,
  caption,
  page,
  log,
  InputFile,
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-slice-'));
  try {
    const { sliceImage, sectionTops, formBand } =
      await import('./evisa-slice.mjs');
    // The page says where its own parts begin and where the form itself
    // starts and ends, so each picture is one part of the form, and the
    // site's banner and footer are left off.
    // A browser that has stopped answering must not hold the form back: the
    // measurements are worth twenty seconds, and the page is sent either way.
    const tops = page
      ? await withDeadline(
          sectionTops(page, 2).catch(() => null),
          MEASURE_MS,
          null
        )
      : null;
    const band = page
      ? await withDeadline(
          formBand(page, 2).catch(() => null),
          MEASURE_MS,
          null
        )
      : null;
    const sections = await sliceImage(screenshot, dir, {
      trim: true,
      tops,
      band,
    });
    // The sections first, in order, so the form unrolls down the chat as the
    // applicant reads it; the whole page follows as the file they keep, with
    // the outcome under it.
    let sent = 0;
    for (const section of sections) {
      // One picture that will not upload must not cost the applicant the
      // rest of their form.
      const done = await withDeadline(
        ctx
          .replyWithPhoto(
            new InputFile(section.path, `section-${section.index}.jpg`),
            { caption: section.title }
          )
          .then(() => true)
          .catch((error) => {
            log(
              chatId,
              `section ${section.index} did not send: ${error.message}`
            );
            return false;
          }),
        SEND_MS,
        false
      );
      if (done) {
        sent += 1;
      } else {
        log(chatId, `section ${section.index} timed out; going on`);
      }
    }
    await withDeadline(
      ctx
        .replyWithDocument(new InputFile(screenshot, 'form.png'), { caption })
        .catch((error) =>
          log(chatId, `the page did not send: ${error.message}`)
        ),
      SEND_MS,
      null
    );
    log(chatId, `sent ${sent} of ${sections.length} sections, then the page`);
  } catch (error) {
    log(chatId, `could not cut the page into sections: ${error.message}`);
    await ctx.replyWithDocument(new InputFile(screenshot, 'form.png'), {
      caption,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
