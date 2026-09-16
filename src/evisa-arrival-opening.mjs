// Reads the opening CAPTCHA once, then hands the current picture to the user.

export async function tryOpeningCaptcha({
  page,
  ctx,
  chatId,
  strings,
  log,
  askCaptcha,
  ocr,
  tries,
  solveCaptcha,
  askAfterRounds,
}) {
  if (!ocr) {
    return { asked: false, solved: false, stalled: false };
  }
  let asked = false;
  let stalled = false;
  const solved = await solveCaptcha({
    page,
    chatId,
    log,
    ocr,
    tries,
    onStalled: () => {
      stalled = true;
    },
    onRound: async (round) => {
      if (asked || round < askAfterRounds) {
        return false;
      }
      asked = await askCaptcha(ctx, chatId, strings.arrivalCaptcha, page);
      log(
        chatId,
        `captcha ${round}: ${asked ? 'asked the chat; the page keeps this picture' : 'no picture to send'}`
      );
      return asked;
    },
  });
  return { asked, solved, stalled };
}
