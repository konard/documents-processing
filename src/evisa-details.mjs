// evisa-details.mjs
//
// What the chat sends in, taken as details: the sentences somebody types, and
// the files they forward.
//
// Everything the bot knows about a person arrives one of two ways — out of a
// document it read, or out of a sentence somebody typed — and this holds the
// front door to both. A message that no other handler claimed (not a command,
// not a captcha, not a yes or a no) is read for details, and whatever it
// yields joins the record the forms are filled from.
//
// Both forms are served from here. The visa application and the arrival
// declaration take their values from the same record, so a correction sent
// while the declaration is open reaches the declaration.

import path from 'node:path';

/**
 * Downloads a file Telegram holds.
 *
 * The download URL carries the bot's token, so a failure is reported by its
 * own words: the URL in a stack trace would put the token in the log.
 */
export async function downloadFile(ctx, token) {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(url).catch((error) => {
    throw new Error(`could not download the file: ${error.message}`);
  });
  if (!response.ok) {
    throw new Error(`could not download the file: HTTP ${response.status}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    extension: path.extname(file.file_path || '.jpg') || '.jpg',
  };
}

/** The fields worth checking against a map before they go on a form. */
export const ADDRESS_FIELDS = [
  'permanentAddress',
  'contactAddress',
  'emergencyAddress',
];

/**
 * Reads a typed message for details and records what it holds.
 *
 * The message is logged with what was read out of it: a field the parser
 * missed is only diagnosable against the words that were sent.
 *
 * Returns the fields that were read, so a caller can say what it heard.
 */
export async function takeTypedDetails({
  chatId,
  session,
  text,
  parseFreeText,
  describeFields,
  valuesAllowed,
  verifyAddress,
  log,
  shown,
}) {
  const parsed = parseFreeText(text);
  const said = valuesAllowed()
    ? `: ${JSON.stringify(text)}`
    : ` of ${text.length} characters`;
  log(
    chatId,
    `text message (${session.language})${said}; read: ${describeFields(parsed)}`
  );
  Object.assign(session.data, parsed);

  // A value the applicant types settles a field the passport's readers split
  // on: the person holding the passport outranks two disagreeing readings of
  // it.
  for (const key of Object.keys(parsed)) {
    delete session.disputed?.[key];
  }
  session.received = (session.received ?? 0) + 1;
  // A correction is what unsticks a form: the next fill is worth showing, and
  // worth explaining again if it is still refused.
  session.toldWhatIsStuck = false;
  session.lastFill = null;

  for (const field of ADDRESS_FIELDS) {
    if (parsed[field]) {
      await verifyAddress(chatId, session, field, { log, shown });
    }
  }
  return parsed;
}
