// evisa-image-role.mjs
//
// What an image the applicant sent actually is.
//
// The form takes two pictures, a portrait and a passport data page, and an
// applicant sends whatever else is to hand: a screenshot of a hotel booking, a
// ticket, a photograph of a letter. Deciding by elimination — no passport zone,
// so it must be the portrait — put a booking screenshot in the portrait upload
// and the site refused it for having no face in it.
//
// So each image is looked at on its own terms. A face is measured, since a
// portrait is a face filling much of the frame and a data page is a small face
// beside a great deal of print. Where there is no face at all the text decides:
// an address on it makes it a booking, and a booking is where an address in
// Viet Nam comes from.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The share of the frame a face must fill for the image to be a portrait. */
const PORTRAIT_FACE = 0.06;

/** Where the engines live, beside this file. */
const ENGINES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'ocr-engines'
);

/** Runs a python engine and returns what it printed, or null. */
function runEngine(script, imagePath, timeout = 30_000) {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [path.join(ENGINES, script), imagePath],
      { timeout, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** The faces in an image, largest first, as fractions of the frame. */
export async function findFaces(imagePath) {
  const read = await runEngine('vision-faces.py', imagePath);
  return read?.faces ?? [];
}

/** Every line of text an image holds. */
export async function readText(imagePath) {
  const read = await runEngine('vision-ocr.py', imagePath, 60_000);
  return read?.lines ?? [];
}

/** Words that mark a page as somebody's booking. */
const BOOKING_WORDS =
  /booking|отел|hotel|apartment|апартамент|заезд|отъезд|check.?in|check.?out|guest|номер|reservation|бронир|hostel|villa|resort|nights|ноч/i;

/** Words that mark a page as a boarding pass or ticket. */
const TICKET_WORDS =
  /boarding|flight|рейс|departure|вылет|passenger|посадочн|gate\s*\d|seat|terminal/i;

/**
 * What an image is, from what it holds.
 *
 * Returns one of `portrait`, `passportPage`, `booking`, `ticket` or
 * `unknown`, with the evidence, so a caller can say why.
 */
export function decideRole({ faces = [], lines = [], hasZone = false }) {
  const text = lines.join('\n');
  const largest = faces[0]?.area ?? 0;

  // The zone settles it: only a passport carries one.
  if (hasZone) {
    return { role: 'passportPage', why: 'the machine-readable zone was read' };
  }
  // A face filling the frame, with little else on the page, is the portrait.
  if (largest >= PORTRAIT_FACE && lines.length <= 12) {
    return {
      role: 'portrait',
      why: `a face fills ${Math.round(largest * 100)}% of the picture`,
    };
  }
  if (BOOKING_WORDS.test(text)) {
    return { role: 'booking', why: 'the page reads like a booking' };
  }
  if (TICKET_WORDS.test(text)) {
    return { role: 'ticket', why: 'the page reads like a ticket' };
  }
  // A face on a page of print, with no zone read, is most likely a data page
  // whose zone the readers missed.
  if (largest > 0 && lines.length > 12) {
    return {
      role: 'passportPage',
      why: 'a small face on a page of print, as a data page has',
    };
  }
  if (largest >= PORTRAIT_FACE) {
    return {
      role: 'portrait',
      why: `a face fills ${Math.round(largest * 100)}% of the picture`,
    };
  }
  return {
    role: 'unknown',
    why: faces.length ? 'a face too small to be a portrait' : 'no face on it',
  };
}

/**
 * Looks at an image and says what it is.
 *
 * The face detector runs first because it is quick and settles most images;
 * the text is read only when the face alone leaves the question open.
 */
export async function classifyImage(imagePath, { hasZone = false } = {}) {
  if (hasZone) {
    return {
      role: 'passportPage',
      why: 'the machine-readable zone was read',
      faces: [],
      lines: [],
    };
  }
  const faces = await findFaces(imagePath);
  const lines = await readText(imagePath);
  return { ...decideRole({ faces, lines, hasZone }), faces, lines };
}

/**
 * Files a picture that carried no passport zone.
 *
 * A face filling the frame is the portrait. A booking gives the address in
 * Viet Nam, which the form asks for in three parts and which an applicant
 * would otherwise have to type out of their own screenshot. Anything else is
 * said out loud, so nothing is quietly used as a portrait it is not.
 */
export async function sortUnreadableImage({
  ctx,
  chatId,
  session,
  read,
  local,
  extension,
  log,
  shown,
  keepPortrait,
  keepForUpload,
  strings,
}) {
  const seen = await classifyImage(local).catch((error) => {
    log(chatId, `could not tell what the picture is: ${error.message}`);
    return { role: 'portrait', why: 'nothing could be read from it' };
  });
  log(chatId, `the picture looks like the ${seen.role}: ${seen.why}`);

  if (seen.role === 'portrait') {
    keepPortrait(chatId, session, read, local, extension);
    return;
  }
  if (seen.role === 'passportPage') {
    // A data page whose zone the readers missed is still a data page, and
    // putting it in the portrait would fail the site's face check.
    session.uploads.passportPage = keepForUpload(
      read?.prepared?.path ?? local,
      `passport${extension}`
    );
    await ctx.reply(strings.readAsPassportPage);
    return;
  }
  if (seen.role === 'booking') {
    const { findVietnamAddress, parseVietnamAddress } =
      await import('./evisa-vietnam-address.mjs');
    const line = findVietnamAddress(seen.lines);
    const parsed = line ? parseVietnamAddress(line) : null;
    if (!parsed?.addressInVietnam) {
      await ctx.reply(strings.bookingWithoutAddress);
      return;
    }
    for (const [field, value] of Object.entries(parsed)) {
      if (value) {
        session.data[field] = value;
      }
    }
    // The summary under the filled form already lists every value that went
    // on it, this one included, so saying it here as well says it twice.
    log(chatId, `address in Viet Nam read from a booking: ${shown(line)}`);
    return;
  }
  await ctx.reply(strings.unclearPicture);
}
