// evisa-messages.mjs
//
// Everything the bot says, in the two languages it speaks.
//
// Kept apart from the logic that decides when to say it, so a change of
// wording is a change to this file alone and the bot module stays readable.

/** Phrases the bot uses, in the two languages it speaks. */
export const MESSAGES = {
  en: {
    welcome: 'I can prepare your Vietnam e-visa application.',
    menu:
      'I help with Vietnam entry documents.\n\n' +
      '/fill_visa — fill in an e-visa application\n' +
      '/download_visa — fetch a filed one: the form, the receipt, the visa\n' +
      '/arrival — the pre-arrival declaration, for after the visa\n' +
      '/stop — stop, and close the browser window\n\n' +
      'The buttons below change the language.',
    // Short on purpose. The traveller wants their arrival card filled, not a
    // briefing: the one rule that constrains them is the 72 hours, and the
    // rest belongs in what they are asked for.
    arrivalIntro:
      'The declaration can be filed no earlier than 72 hours before arrival.',
    arrivalMissing: 'Still needed:',
    // The whole promise in one line: write it however you like, all at once.
    // Without it the list above reads as a questionnaire to be answered a
    // line at a time, which is what this bot exists to avoid.
    arrivalHowToSend:
      'Send it all in one message, in your own words — I will sort it out.',
    // The form is open and past its captcha; the site draws no field until a
    // nationality is chosen, so that is the one thing holding the fill up.
    // Said plainly, because a window standing open with nothing happening in
    // it looks like a bot that has stopped.
    // What the site does with a nationality is the site's business, not the
    // traveller's. All they need to know is that the way is clear and it is
    // their turn.
    arrivalNothingToFill: 'The form is open. Send me these and I fill it:',
    arrivalShotName: 'declaration.png',
    arrivalPageName: (name) => name,
    arrivalPageOf: (at, of, title) => `<b>Page ${at} of ${of}: ${title}</b>`,
    arrivalPageReady:
      'Check here and in browser. If correct, send <b>next</b>. For changes ' +
      'or optional fields, send text or a document.',
    arrivalReviewReady:
      'Check the whole declaration here and in the open browser. If ' +
      'everything is correct, send <b>send</b>. For corrections or optional ' +
      'details, send text or a document.',
    arrivalReviewSafetyUnknown:
      'I could not tick the required confirmation box. Check it in the open ' +
      'browser. When it is ticked and the declaration is correct, send ' +
      '<b>send</b>.',
    arrivalCannotConfirmNow:
      'There is no filled declaration page waiting for confirmation yet. ' +
      'Check the open browser or send the missing details.',
    arrivalNotAdvanced:
      'The declaration remains on this page. Nothing was submitted; the ' +
      'browser stays open. Check it there or send corrections.',
    arrivalPageRetry:
      'Every required field is filled, but the site stayed on this page. ' +
      'Check the open browser and send <b>next</b> to try again. You can ' +
      'also send text or a document to change any field or add optional details.',
    arrivalPassengerCheck: (values) =>
      compactSummary('<b>Page 1 filled:</b>', [
        compactLine(
          'passenger',
          values.fullName,
          values.gender,
          values.dateOfBirth
        ),
        compactLine(
          'passport',
          values.passportType,
          values.nationality,
          values.passportNumber,
          values.passportExpiryDate
            ? `expires ${values.passportExpiryDate}`
            : ''
        ),
        compactLine(
          'e-visa',
          values.visaType,
          values.visaNumber,
          dateWindow(values.visaIssueDate, values.visaExpiryDate)
        ),
        compactLine('issued by', values.visaIssuedPlace),
        compactLine('arrival', values.arrivalDate),
        compactLine('contacts', values.email, values.phone),
        values.passportImage || values.readTheNotes
          ? '• passport uploaded; required notice ticked'
          : '',
      ]),
    arrivalTripCheck: (values) =>
      compactSummary('<b>Page 2 filled so far:</b>', [
        compactLine(
          'journey',
          values.departedFrom,
          values.modeOfTravel,
          values.vehicleNumber
        ),
        compactLine('arrival point', values.borderGate),
        compactLine('purpose', values.purpose),
        compactLine(
          'stay',
          values.accommodationType,
          values.province,
          values.ward
        ),
        compactLine('address', values.accommodationAddress),
        compactLine('workplace', values.workplace),
        compactLine('leaving Viet Nam', values.departureDate),
      ]),
    arrivalPassportUnread:
      'The site could not reread the passport image; check the passport values.',
    arrivalPageRefused: (page, why) =>
      [
        `The site would not accept <b>${page}</b>.`,
        why.length
          ? `It is asking for:\n${why.map((one) => `• ${one}`).join('\n')}`
          : '',
        'Send me what it wants and I will fill it again.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    arrivalPageIncomplete: () =>
      'Send the missing details, corrections, or optional details as text or ' +
      'a document, and I will refill it. The browser stays open.',
    arrivalFiling: 'Filing the declaration now.',
    arrivalEmailCode:
      'The site sent a six-digit code to your email. Send that code here.',
    arrivalEmailCodeAgain:
      'The site did not accept that code. Check the email and send the ' +
      'six-digit code again.',
    arrivalEmailVerificationUnknown:
      'Email verification failed: the site did not show a definite result. ' +
      'Check the open browser before trying again.',
    arrivalFiled: 'The declaration was filed successfully.',
    arrivalResultPdf: 'Filed pre-arrival declaration (PDF).',
    arrivalResultQr: 'QR code for the filed pre-arrival declaration.',
    arrivalResultIncomplete: (artifacts) =>
      `The declaration was filed, but I could not retrieve: ${artifacts.join(', ')}. ` +
      'The result remains open in the browser for a short time.',
    arrivalDuplicate: (passportNumber = '') =>
      'No new declaration was filed: pre-arrival information already exists' +
      `${passportNumber ? ` for passport ${passportNumber}` : ''}. ` +
      'Use the previously filed declaration.',
    arrivalFilingUnknown:
      'I could not verify the filing result. Check the open browser before ' +
      'trying again; I will not press Submit again automatically.',
    arrivalNotFiled: (why) =>
      `The declaration could not be filed. Reason: ${filingReason(why, 'en')}. ` +
      'Check the open browser before trying again.',
    arrivalNothingToFile:
      'There is no declaration waiting on its review page. Send /arrival to ' +
      'start one.',
    // Said as soon as the landing date is known, and again with the values
    // read off each document. Nothing is wrong when the window is shut: it is
    // simply not open yet, and the traveller should not be left wondering
    // whether their documents failed to arrive.
    arrivalWindowShut: (arrival, opens, days) =>
      `You land on ${arrival}, so the site starts taking this declaration ` +
      `on ${opens} — ${days === 1 ? 'tomorrow' : `in ${days} days`}. It ` +
      'offers the day you arrive and the two before it, and there is no way ' +
      'to file it sooner. Keep sending me what it needs in the meantime: I ' +
      'hold it all, and on the day I fill the form in one go.',
    // A rehearsal is worth nothing if it is mistaken for the real filing, so
    // it says what it is every time, in the chat and in the log.
    arrivalRehearsal: (using, real) =>
      `⚠️ This is a rehearsal, not your declaration. I am filling the form ` +
      `for ${using}, a day the site will accept today, so we can watch every ` +
      `other field go in${real ? ` — you actually land on ${real}` : ''}. ` +
      'Nothing is sent, and this fills nothing in for your real arrival. ' +
      'The declaration that counts is the one filed inside the window.',
    arrivalCaptcha:
      'The declaration site asks for this code before it draws the form. ' +
      'Send me what you read.',
    arrivalCaptchaAgain:
      'That code was refused. Here is a fresh one — send me what you read.',
    arrivalCaptchaContinue:
      'The site requested another security code before continuing. Send me ' +
      'what you read; the covered form will not be sent as a page screenshot.',
    arrivalCaptchaUnavailable:
      'The site requested a security code but has not supplied its image. ' +
      'Nothing advanced or was submitted. Send <b>next</b> to try again.',
    arrivalDisagreed:
      'The site read your passport photo differently from me. I kept my ' +
      'reading — check these and tell me if the site was right:',
    arrivalDisagreedOne: (field, site, bot) =>
      `${field}: I have ${bot}, the site read ${site}`,
    arrivalTooEarly: (wanted, offered) =>
      `The site will not take a declaration for ${wanted} yet: it offers ` +
      `only ${offered.join(', ')}. It opens 72 hours before you land, so ` +
      'come back then and I will fill it in.',
    arrivalExpired:
      'The declaration site closed the session before the form was finished. ' +
      'Send /fill_arrival and I open a new one — everything you have told me ' +
      'is kept, so there is nothing to send again.',
    arrivalSiteStalled:
      'The declaration site is not issuing its security code right now — its ' +
      'own page says "Failed to get CAPTCHA". That is on their side, not ' +
      'yours, and it usually passes within a few minutes. Send /arrival ' +
      'again shortly and I will open it afresh.',
    arrivalFormUnavailable:
      'The declaration site did not open the passenger page. Nothing was ' +
      'submitted. Send /arrival again and I will reopen it.',
    arrivalFilled: 'On the declaration now:',
    arrivalStillWanted: 'Still to fill in:',
    // What the site marks in red under a field, said in the chat instead. The
    // traveller is not looking at the page, so an unexplained refusal at the
    // end is the alternative.
    arrivalRefused: 'The site will not take these as they stand:',
    arrivalRefusedWhy: {
      nineDigits:
        'the e-visa number — the site wants the Số / No. line from the visa ' +
        'itself, which is 9 digits and no letter',
      tooCloseToVisa: (days) =>
        'your passport expiry — the site wants the passport to outlast the ' +
        `visa by 30 days, and it has ${Math.round(days)}`,
    },
    arrivalYours:
      'The form is filled and waiting in the browser. Check it, then send ' +
      'it yourself — I do not file it for you.',
    arrivalNeedsWork:
      'This page is not complete yet. The browser stays open for corrections.',
    documentIssuesHeading: 'Documents to check:',
    documentIssues: {
      downloadFailed: (count) =>
        `• ${count} Telegram ${count === 1 ? 'file' : 'files'} did not download; ` +
        `resend ${count === 1 ? 'it' : 'them'} (not a photo-quality error).`,
      compressedPhoto: (count) =>
        `• Telegram compressed ${count} ${count === 1 ? 'photo' : 'photos'}; ` +
        'if rejected, resend the original as a file.',
      passportPageUncertain: (count) =>
        `• Machine lines were unreadable on ${count} passport-page ` +
        `${count === 1 ? 'image' : 'images'}; check the passport values.`,
      bookingWithoutAddress: (count) =>
        `• No Viet Nam address was read from ${count} booking ` +
        `${count === 1 ? 'image' : 'images'}; send it as text.`,
      unknownImage: (count) =>
        `• ${count} ${count === 1 ? 'image was' : 'images were'} not identified or used.`,
    },
    checklistDocuments: 'Send these',
    checklistDetails: 'Tell me these',
    checklistFooter:
      'Photos, PDFs and forwarded messages all work, in any order.',
    readFromPassport: 'read from your passport photo',
    summary: 'What I put on the form:',
    // The name the filled page is sent under. A client draws a file's name
    // above its caption, so it is the first thing read.
    formFile: 'FORM.png',
    // The page the site draws for checking, before the application is in.
    previewFile: 'FORM-PREVIEW.png',
    sections: {
      applicant: 'Applicant',
      passport: 'Passport',
      contacts: 'Contacts',
      emergency: 'Emergency contact',
      trip: 'Trip',
    },
    assumedMark: '*',
    // Where a value came from, when the site read the passport too. The
    // applicant is asked to check these against the passport itself, so it
    // has to be plain which reading each value is.
    agreedMark: ' ✓site',
    siteOnlyMark: ' (from the site)',
    overruledMark: (was) => ` (site read "${was}")`,
    assumedNote:
      'Starred values were not given, so I chose them. If any is wrong, ' +
      'send the value you want.',
    hyphenNote: (printed) =>
      `(the passport has ${printed}; the site takes no hyphen, so a space)`,
    disputedNote: (candidates) =>
      `the readers of the passport disagree: ${candidates.join(' or ')}. ` +
      'Tell me which is right.',
    derived: {
      contactAddress: '(same as the permanent address)',
      validFrom: '(the entry date)',
      validTo: '(90 days, the most an e-visa allows)',
    },
    filled: (n) => `Filled ${n} fields.`,
    siteAgreed: (n) =>
      `The site read ${n} of them from the passport itself, and they matched.`,
    siteCorrected: 'Corrected what the site read differently:',
    declarations: {
      temporaryResidence: 'the commitment to declare temporary residence',
      truthful: 'that the statements are true',
      compliance: 'compliance with Vietnamese law on entry',
      instructionsRead: 'that the instructions were read',
    },
    declared: (names) =>
      'The declarations under the form are compulsory (the site will not go ' +
      `on without them); all are ticked — ${names.join(', ')}. In your name.`,
    failed: (field, why) => `Could not fill ${field}: ${why}`,
    fillFailed: (why) =>
      `Filling stopped: ${why}. The browser window is now in front of you, ` +
      'with the form as far as it got — nothing is closed and nothing is ' +
      'lost. Carry on in it by hand, or send a correction and I fill again.',
    browserGone:
      'Filling stopped: the browser closed, most likely because the bot was ' +
      'restarted. Send /start, then the documents and details again.',
    restarting:
      'The bot is shutting down, and the browser window it opened is being ' +
      'closed. Documents and details are not kept across a shutdown. When ' +
      'the bot is back, /start lists what it can do, and anything you sent ' +
      'has to be sent again.',
    browserClosed:
      'The browser window has closed, and everything in it is gone. Send the ' +
      'documents and details again and I open a new window.',
    stopped:
      'Stopped. Nothing more is filled or sent, and the browser is closed. ' +
      '/start lists what the bot can do, and any of it can be begun again.',
    alreadyFilling: 'Still filling. Nothing is sent without your word.',
    needed: 'Still needed:',
    thenAgain: 'Once you send it, I fill the form again and show it.',
    ready:
      'Check the form. If everything is right, say "next" and the site will ' +
      'lay the application out for a last look. If not, send the correction.',
    stages: {
      form: 'the application form',
      review: 'review of the application',
      declared: 'declaration completed',
      payment: 'payment',
      unknown: 'a page I do not know',
    },
    applicationIn: 'The application is registered. The site gives:',
    registrationCode: 'application number',
    registrationEmail: 'email',
    registrationBirth: 'date of birth',
    registrationPassport: 'passport',
    registrationNationality: 'nationality',
    registrationApplied: 'filed on',
    applicationInNext:
      'Keep the application number: it is what the status is checked by. ' +
      'The rest is in the browser window — confirm there and pay. I press ' +
      'nothing in it.',
    inBrowserNow:
      'The application is registered; the rest is in the browser window: ' +
      'Confirm in the dialog, then payment. I press nothing there.',
    stepMoved: (stage) =>
      `The site accepted the application. Now at: ${stage}. ` +
      'This is the whole page.',
    stepKept: 'The site kept the page, so something on it needs changing.',
    reviewEmpty:
      'The site opened the review page, but empty: no ' +
      'application and no code on it. That is a failure on its side. Your ' +
      'form is still in the browser as you left it — say "next" to try ' +
      'again, or send a correction first.',
    stepMessages: (n) =>
      `${n} ${n === 1 ? 'message' : 'messages'} on it. Send the corrections.`,
    siteSaid: (text) => `The site said: "${text}".`,
    stepFailed: (why) =>
      `The application could not be sent on: ${why}. The browser is left ` +
      'open as it is.',
    captchaAsk:
      'This is the application as it will be filed. Look it over, and if ' +
      'everything is right, send me the code from this picture: the ' +
      'application then goes in, and the browser window moves on to payment.',
    captchaAgain:
      'The site did not take that code. Here is a new picture; send the code ' +
      'from it.',
    lookupCaptchaAsk:
      'Looking the application up. Send the code from this picture and I ' +
      'fetch whatever the site has ready: the form, the receipt, the visa.',
    applicationKept: (number) =>
      `I have noted the application number ${number}. Once the payment goes ` +
      'through in the browser, I fetch the form and the receipt on my own; ' +
      'you can also ask any time with /download_visa.',
    paymentSeen:
      'The browser reached the site\u2019s payment page, so the payment is ' +
      'through. Fetching the documents now.',
    fieldStuck: (fields, more = 0) =>
      `The site will not take ${fields.join(', ')}${
        more ? ` and ${more} more` : ''
      }, and filling the form again changes nothing. Send the value you want ` +
      `and I will try that; everything else on the form is as you saw it.`,
    nothingChanged:
      'Nothing changed on the form since you last saw it, so I have not sent ' +
      'it again. Send a correction whenever you have one.',
    documentsNeedNumber:
      'I can fetch a filed application: the form, the payment receipt, and ' +
      'the visa after it is granted.\n\n' +
      'The site asks for three things before it shows any of them:\n' +
      '• the application number — starts with E, in the site´s email\n' +
      '• the email the application was filed with\n' +
      '• the applicant´s date of birth — as on the passport\n\n' +
      'All three are in the confirmation email the site sent when the ' +
      'application was filed. Send them in one message or one at a time, in ' +
      'any order:\n\n' +
      'E260908XXX0000000000 someone@example.com 01/02/1990',
    documentsStillNeed: (missing) =>
      `Still needed:\n${missing.map((it) => `• ${it}`).join('\n')}`,
    documentsNumberName: 'the application number — starts with E',
    documentsEmailName: 'the email the application was filed with',
    documentsBirthName: 'the date of birth, as 01/02/1990',
    documentsOpening:
      'Opening the lookup. The site guards it with a code picture, which I ' +
      'will send as soon as it loads.',
    documentsNoCaptcha:
      'The lookup page did not show a code picture. Try /download_visa again in ' +
      'a moment.',
    documentsNone: 'The site found no application under that number.',
    documentsNotReady:
      'The site offers nothing to download yet. The form and the receipt ' +
      'appear after payment, and the visa after a grant.',
    applicationStatus: (status, meaning) =>
      ({
        waiting:
          `The site says: ${status}. It is still being looked at; ` +
          'nothing to do but wait.',
        unpaid:
          `The site says: ${status}. It is waiting for payment, which ` +
          'is done in the browser.',
        granted: `The site says: ${status}. The visa has been granted.`,
        refused: `The site says: ${status}. The application was refused.`,
        unknown: `The site says: ${status}.`,
      })[meaning],
    captchaEntered: (seconds) =>
      `Typed the code. Sending the application in ${seconds} seconds. Say ` +
      '"stop" to cancel, or "next" to skip the wait.',
    sendCountdown: (seconds) =>
      `Sending in ${seconds} seconds. Say "stop" to cancel, or "next" ` +
      'to skip the wait.',
    pastForm:
      'The application has gone past the form, and I cannot change it from ' +
      'the chat. Correct it in the browser, or start over with /start.',
    languageSet: 'Now speaking English.',
  },
  ru: {
    welcome: 'Помогу подготовить заявление на электронную визу во Вьетнам.',
    menu:
      'Помогаю с документами для въезда во Вьетнам.\n\n' +
      '/fill_visa — заполнить заявление на электронную визу\n' +
      '/download_visa — скачать поданное: анкету, квитанцию, визу\n' +
      '/arrival — декларация перед прилётом, уже после визы\n' +
      '/stop — остановиться и закрыть окно браузера\n\n' +
      'Кнопки ниже меняют язык.',
    arrivalIntro:
      'Подать декларацию можно не ранее чем за 72 часа до прибытия.',
    arrivalMissing: 'Ещё нужно:',
    arrivalHowToSend:
      'Пришлите всё одним сообщением, своими словами — я разберу.',
    // Форма уже открыта и капча пройдена: сайт не показывает ни одного поля,
    // пока не выбрано гражданство.
    arrivalNothingToFill: 'Форма открыта. Пришлите это, и я её заполню:',
    arrivalShotName: 'declaration.png',
    arrivalPageName: (name) =>
      ({
        'Passenger Information': 'Данные пассажира',
        'Trip Information': 'Информация о поездке',
        'Review & Submit': 'Проверка и отправка',
      })[name] ?? name,
    arrivalPageOf: (at, of, title) =>
      `<b>Страница ${at} из ${of}: ${title}</b>`,
    arrivalPageReady:
      'Проверьте здесь и в браузере. Если всё верно, напишите <b>далее</b>. ' +
      'Для изменений или необязательных полей пришлите текст или документ.',
    arrivalReviewReady:
      'Проверьте всю декларацию здесь и в открытом браузере. Если всё верно, ' +
      'напишите <b>отправляй</b>. Для исправления или добавления ' +
      'необязательных сведений пришлите текст или документ.',
    arrivalReviewSafetyUnknown:
      'Не удалось поставить обязательную галочку подтверждения. Проверьте её ' +
      'в открытом браузере. Когда галочка поставлена и декларация верна, ' +
      'напишите <b>отправляй</b>.',
    arrivalCannotConfirmNow:
      'Сейчас нет заполненной страницы декларации, ожидающей подтверждения. ' +
      'Проверьте открытый браузер или пришлите недостающие данные.',
    arrivalNotAdvanced:
      'Декларация остаётся на этой странице. Ничего не отправлено; браузер ' +
      'остаётся открытым. Проверьте её там или пришлите исправления.',
    arrivalPageRetry:
      'Все обязательные поля заполнены, но сайт остался на этой странице. ' +
      'Проверьте открытый браузер и напишите <b>далее</b>, чтобы повторить. ' +
      'Также можно прислать текст или документ, чтобы изменить любое поле ' +
      'или добавить необязательные сведения.',
    arrivalPassengerCheck: (values) =>
      compactSummary('<b>Страница 1 заполнена:</b>', [
        compactLine(
          'пассажир',
          values.fullName,
          genderInRussian(values.gender),
          values.dateOfBirth
        ),
        compactLine(
          'паспорт',
          values.passportType,
          values.nationality,
          values.passportNumber,
          values.passportExpiryDate ? `до ${values.passportExpiryDate}` : ''
        ),
        compactLine(
          'e-visa',
          values.visaType,
          values.visaNumber,
          dateWindow(values.visaIssueDate, values.visaExpiryDate)
        ),
        compactLine('виза выдана', values.visaIssuedPlace),
        compactLine('прилёт', values.arrivalDate),
        compactLine('контакты', values.email, values.phone),
        values.passportImage || values.readTheNotes
          ? '• паспорт загружен; обязательная отметка поставлена'
          : '',
      ]),
    arrivalTripCheck: (values) =>
      compactSummary('<b>На странице 2 заполнено:</b>', [
        compactLine(
          'перелёт',
          values.departedFrom,
          values.modeOfTravel,
          values.vehicleNumber
        ),
        compactLine('пункт прибытия', values.borderGate),
        compactLine('цель', values.purpose),
        compactLine(
          'проживание',
          values.accommodationType,
          values.province,
          values.ward
        ),
        compactLine('адрес', values.accommodationAddress),
        compactLine('место работы', values.workplace),
        compactLine('вылет из Вьетнама', values.departureDate),
      ]),
    arrivalPassportUnread: 'Сайт не перечитал паспорт; проверьте данные.',
    arrivalPageRefused: (page, why) =>
      [
        `Сайт не принял страницу <b>${page}</b>.`,
        why.length
          ? `Он просит:\n${why.map((one) => `• ${one}`).join('\n')}`
          : '',
        'Пришлите нужное, и я заполню заново.',
      ]
        .filter(Boolean)
        .join('\n\n'),
    arrivalPageIncomplete: () =>
      'Пришлите недостающее, исправления или необязательные сведения текстом ' +
      'либо документом — заполню снова. Браузер остаётся открытым.',
    arrivalFiling: 'Подаю декларацию.',
    arrivalEmailCode:
      'Сайт отправил шестизначный код на вашу электронную почту. Пришлите ' +
      'этот код сюда.',
    arrivalEmailCodeAgain:
      'Сайт не принял этот код. Проверьте письмо и пришлите шестизначный код ' +
      'ещё раз.',
    arrivalEmailVerificationUnknown:
      'Не удалось завершить проверку электронной почты: сайт не показал ' +
      'однозначный результат. Проверьте открытый браузер перед новой попыткой.',
    arrivalFiled: 'Декларация успешно подана.',
    arrivalResultPdf: 'Поданная предварительная декларация (PDF).',
    arrivalResultQr: 'QR-код поданной предварительной декларации.',
    arrivalResultIncomplete: (artifacts) =>
      `Декларация подана, но не удалось получить: ${artifacts.join(', ')}. ` +
      'Результат ещё ненадолго остаётся открытым в браузере.',
    arrivalDuplicate: (passportNumber = '') =>
      'Новая декларация не подана: предварительная информация уже существует' +
      `${passportNumber ? ` для паспорта ${passportNumber}` : ''}. ` +
      'Используйте ранее поданную декларацию.',
    arrivalFilingUnknown:
      'Я не смог проверить результат подачи. Проверьте открытый браузер ' +
      'перед новой попыткой; автоматически нажимать Submit ещё раз не буду.',
    arrivalNotFiled: (why) =>
      `Не удалось подать декларацию. Причина: ${filingReason(why, 'ru')}. ` +
      'Проверьте открытый браузер перед новой попыткой.',
    arrivalNothingToFile:
      'Нет декларации, ждущей на странице проверки. Отправьте /arrival, ' +
      'чтобы начать.',
    arrivalWindowShut: (arrival, opens, days) =>
      `Вы прилетаете ${arrival}, поэтому сайт начнёт принимать эту ` +
      `декларацию ${opens} — ${days === 1 ? 'завтра' : `через ${days} ${days < 5 ? 'дня' : 'дней'}`}. ` +
      'Он предлагает день прилёта и два дня перед ним, раньше подать никак ' +
      'нельзя. Присылайте пока всё, что для неё нужно: я всё сохраню и в ' +
      'нужный день заполню форму за один раз.',
    arrivalRehearsal: (using, real) =>
      `⚠️ Это репетиция, а не ваша декларация. Заполняю форму на ${using} — ` +
      'день, который сайт принимает уже сегодня, чтобы посмотреть, как ' +
      `встанут все остальные поля${real ? `. На самом деле вы прилетаете ${real}` : ''}. ` +
      'Ничего не отправляется, и на ваш настоящий прилёт это ничего не ' +
      'заполняет. Считается только декларация, поданная в свой срок.',
    arrivalCaptcha:
      'Сайт декларации просит этот код, прежде чем показать форму. ' +
      'Пришлите то, что видите.',
    arrivalCaptchaAgain: 'Код не подошёл. Вот новый — пришлите то, что видите.',
    arrivalCaptchaContinue:
      'Перед продолжением сайт запросил ещё один код проверки. Пришлите то, ' +
      'что видите; закрытую им форму я не буду отправлять как снимок страницы.',
    arrivalCaptchaUnavailable:
      'Сайт запросил код проверки, но не выдал картинку. Переход не выполнен; ' +
      'ничего не отправлено. Напишите <b>далее</b>, чтобы попробовать снова.',
    arrivalDisagreed:
      'Сайт прочитал фото паспорта иначе, чем я. Я оставил своё — ' +
      'проверьте и скажите, если прав сайт:',
    arrivalDisagreedOne: (field, site, bot) =>
      `${field}: у меня ${bot}, сайт прочитал ${site}`,
    arrivalTooEarly: (wanted, offered) =>
      `Сайт пока не принимает декларацию на ${wanted}: он предлагает только ` +
      `${offered.join(', ')}. Приём открывается за 72 часа до прилёта — ` +
      'вернитесь тогда, и я всё заполню.',
    arrivalExpired:
      'Сайт декларации закрыл сессию, не дождавшись конца заполнения. ' +
      'Отправьте /fill_arrival — открою заново. Всё, что вы мне уже ' +
      'сказали, сохранено, присылать заново ничего не нужно.',
    arrivalSiteStalled:
      'Сайт декларации сейчас не выдаёт код проверки — на его же странице ' +
      'написано «Failed to get CAPTCHA». Это на их стороне, не на вашей, и ' +
      'обычно проходит за несколько минут. Отправьте /arrival чуть позже — ' +
      'открою заново.',
    arrivalFormUnavailable:
      'Сайт декларации не открыл страницу данных пассажира. Ничего не ' +
      'отправлено. Пришлите /arrival ещё раз — я открою форму заново.',
    arrivalFilled: 'Сейчас в декларации:',
    arrivalStillWanted: 'Ещё нужно заполнить:',
    arrivalRefused: 'Вот это сайт в таком виде не примет:',
    arrivalRefusedWhy: {
      nineDigits:
        'номер электронной визы — сайту нужна строка Số / No. с самой визы: ' +
        '9 цифр, без буквы',
      tooCloseToVisa: (days) =>
        'срок паспорта — сайту нужно, чтобы паспорт был действителен на 30 ' +
        `дней дольше визы, а сейчас разница ${Math.round(days)}`,
    },
    arrivalYours:
      'Форма заполнена и ждёт в браузере. Проверьте и отправьте сами — ' +
      'я её за вас не подаю.',
    arrivalNeedsWork:
      'Страница ещё не заполнена. Браузер остаётся открытым для исправлений.',
    documentIssuesHeading: 'Что проверить в документах:',
    documentIssues: {
      downloadFailed: (count) =>
        `• ${count} ${count === 1 ? 'файл' : count < 5 ? 'файла' : 'файлов'} Telegram ` +
        `${count === 1 ? 'не скачан' : 'не скачаны'}; пришлите снова ` +
        '(дело не в качестве фото).',
      compressedPhoto: (count) =>
        `• Telegram сжал ${count} фото; при отказе пришлите оригинал файлом.`,
      passportPageUncertain: (count) =>
        `• На ${count} ${count === 1 ? 'странице' : 'страницах'} паспорта не прочитаны ` +
        'машинные строки; проверьте данные.',
      bookingWithoutAddress: (count) =>
        `• В ${count} ${count === 1 ? 'брони' : 'бронях'} не прочитан адрес; ` +
        'пришлите текстом.',
      unknownImage: (count) =>
        `• ${count} ${count === 1 ? 'изображение не распознано и не использовано' : 'изображений не распознано и не использовано'}.`,
    },
    checklistDocuments: 'Пришлите',
    checklistDetails: 'Напишите',
    checklistFooter:
      'Подойдут фото, PDF и пересланные сообщения, в любом порядке.',
    readFromPassport: 'прочитаю с фото паспорта',
    summary: 'Что я вписал в анкету:',
    // Имя файла с заполненной анкетой: клиент показывает его над подписью,
    // поэтому его читают первым.
    formFile: 'АНКЕТА.png',
    previewFile: 'ПРЕДПРОСМОТР-АНКЕТЫ.png',
    sections: {
      applicant: 'Заявитель',
      passport: 'Паспорт',
      contacts: 'Контакты',
      emergency: 'Экстренный контакт',
      trip: 'Поездка',
    },
    assumedMark: '*',
    // Откуда значение, когда сайт тоже прочитал паспорт. Заявитель сверяет
    // это с самим паспортом, поэтому должно быть видно, чьё это чтение.
    agreedMark: ' ✓сайт',
    siteOnlyMark: ' (это с сайта)',
    overruledMark: (was) => ` (сайт читал «${was}»)`,
    assumedNote:
      'Со звёздочкой — то, что вы не указывали и я подставил сам. Если ' +
      'что-то не так, пришлите нужное значение.',
    hyphenNote: (printed) =>
      `(в паспорте ${printed}; дефис сайт не принимает, заменён пробелом)`,
    disputedNote: (candidates) =>
      `паспорт прочитан по-разному: ${candidates.join(' или ')}. ` +
      'Напишите, как правильно.',
    derived: {
      contactAddress: '(как адрес регистрации)',
      validFrom: '(день въезда)',
      validTo: '(90 дней, максимум для электронной визы)',
    },
    filled: (n) => `Заполнено полей: ${n}.`,
    siteAgreed: (n) =>
      `Из них ${n} сайт сам распознал с паспорта, и они совпали.`,
    siteCorrected: 'Исправил то, что сайт распознал иначе:',
    declarations: {
      temporaryResidence: 'обязательство заявить о временном проживании',
      truthful: 'достоверность сведений',
      compliance: 'соблюдение законов Вьетнама при въезде',
      instructionsRead: 'ознакомление с инструкцией',
    },
    // Said as what it is: the site will not let the form go on without these,
    // so they are not a choice the bot made on the applicant's behalf. They
    // are still statements in the applicant's name, so each one is named.
    declared: (names) =>
      `Обязательные галочки под анкетой (без них сайт не пропускает ` +
      `дальше), отметил все — ${names.join(', ')}. Это от вашего имени.`,
    failed: (field, why) => `Не удалось заполнить ${field}: ${why}`,
    fillFailed: (why) =>
      `Заполнение прервалось: ${why}. Окно браузера поднято перед вами, ` +
      'форма в нём в том виде, до которого дошло — ничего не закрыто и ' +
      'ничего не потеряно. Можно продолжить в нём руками, либо пришлите ' +
      'исправление, и я заполню заново.',
    browserGone:
      'Заполнение прервалось: браузер закрылся, скорее всего из-за ' +
      'перезапуска бота. Пришлите /start, затем документы и данные заново.',
    restarting:
      'Бот выключается, открытое им окно браузера сейчас закроется. Документы ' +
      'и данные при выключении не сохраняются. Когда бот вернётся, /start ' +
      'покажет, что он умеет, а присланное нужно будет прислать заново.',
    browserClosed:
      'Окно браузера закрылось, и всё, что в нём было, пропало. Документы и ' +
      'данные пришлите заново, и я открою новое окно.',
    stopped:
      'Остановил. Больше ничего не заполняю и не отправляю, браузер закрыт. ' +
      '/start покажет, что бот умеет, — любое из этого можно начать заново.',
    alreadyFilling: 'Ещё заполняю. Без вашего слова ничего не отправлю.',
    needed: 'Ещё нужно:',
    thenAgain: 'Как пришлёте, заполню анкету заново и покажу.',
    ready:
      'Проверьте анкету. Если всё верно, напишите «далее» — сайт покажет её ' +
      'на последнюю проверку. Если нет, пришлите исправление.',
    stages: {
      form: 'анкета',
      review: 'проверка анкеты',
      declared: 'заявление принято',
      payment: 'оплата',
      unknown: 'незнакомая мне страница',
    },
    applicationIn: 'Заявление зарегистрировано. Сайт выдал:',
    registrationCode: 'номер заявления',
    registrationEmail: 'почта',
    registrationBirth: 'дата рождения',
    registrationPassport: 'паспорт',
    registrationNationality: 'гражданство',
    registrationApplied: 'подано',
    applicationInNext:
      'Сохраните номер заявления — по нему проверяют статус. Дальше всё в ' +
      'окне браузера: подтвердите и оплатите. В нём я ничего не нажимаю.',
    inBrowserNow:
      'Заявление зарегистрировано, дальше в окне браузера: «Confirm» в ' +
      'окне сайта, потом оплата. Там я ничего не нажимаю.',
    stepMoved: (stage) =>
      `Сайт принял анкету. Шаг: ${stage}. Вот вся страница.`,
    stepKept: 'Сайт оставил страницу — значит, на ней нужно что-то поправить.',
    reviewEmpty:
      'Сайт открыл страницу проверки, но пустую: ни анкеты, ' +
      'ни кода на ней. Это сбой на его стороне. Ваша анкета в браузере ' +
      'осталась как была — напишите «далее», чтобы попробовать ещё раз, ' +
      'или сначала пришлите исправление.',
    stepMessages: (n) => `Замечаний на ней: ${n}. Пришлите исправления.`,
    siteSaid: (text) => `Сайт ответил: «${text}».`,
    stepFailed: (why) =>
      `Отправить анкету дальше не вышло: ${why}. Браузер оставлен как есть.`,
    captchaAsk:
      'Это анкета в том виде, в каком она уйдёт. Проверьте её, и если всё ' +
      'верно, пришлите код с этой картинки: анкета отправится, а окно ' +
      'браузера перейдёт к оплате.',
    captchaAgain:
      'Сайт не принял этот код. Вот новая картинка — пришлите код с неё.',
    lookupCaptchaAsk:
      'Ищу заявление. Пришлите код с этой картинки, и я скачаю всё, что у ' +
      'сайта готово: анкету, квитанцию, визу.',
    applicationKept: (number) =>
      `Запомнил номер заявления ${number}. Как только в браузере пройдёт ` +
      'оплата, сам скачаю анкету и квитанцию; можно и в любой момент ' +
      'спросить командой /download_visa.',
    paymentSeen:
      'Браузер дошёл до страницы оплаты — значит, оплата прошла. Скачиваю ' +
      'документы.',
    fieldStuck: (fields, more = 0) =>
      `Сайт не принимает: ${fields.join(', ')}${
        more ? ` и ещё ${more}` : ''
      }. Повторное заполнение ничего не меняет. Пришлите нужное значение — ` +
      `попробую его; остальное в анкете такое же, как вы видели.`,
    nothingChanged:
      'С прошлого раза в анкете ничего не изменилось, поэтому не присылаю её ' +
      'снова. Пришлите исправление, когда будет.',
    documentsNeedNumber:
      'Могу скачать поданное заявление: анкету, квитанцию об оплате и саму ' +
      'визу после выдачи.\n\n' +
      'Сайт просит три вещи, прежде чем что-то показать:\n' +
      '• номер заявления — начинается с E, есть в письме от сайта\n' +
      '• почту, с которой подавали заявление\n' +
      '• дату рождения заявителя — как в паспорте\n\n' +
      'Всё это есть в письме, которое сайт прислал при подаче. Пришлите ' +
      'одним сообщением или по одному, в любом порядке:\n\n' +
      'E260908XXX0000000000 someone@example.com 01/02/1990',
    documentsStillNeed: (missing) =>
      `Ещё нужно:\n${missing.map((it) => `• ${it}`).join('\n')}`,
    documentsNumberName: 'номер заявления — начинается с E',
    documentsEmailName: 'почта, с которой подавали заявление',
    documentsBirthName: 'дата рождения, в виде 01/02/1990',
    documentsOpening:
      'Открываю поиск. Сайт закрывает его картинкой с кодом — пришлю её, ' +
      'как только загрузится.',
    documentsNoCaptcha:
      'Страница поиска не показала картинку с кодом. Попробуйте /download_visa ' +
      'ещё раз через минуту.',
    documentsNone: 'Сайт не нашёл заявления с таким номером.',
    documentsNotReady:
      'Сайт пока ничего не предлагает скачать. Анкета и квитанция ' +
      'появляются после оплаты, а виза — когда её выдадут.',
    applicationStatus: (status, meaning) =>
      ({
        waiting:
          `Сайт пишет: ${status}. Заявление ещё рассматривают, ` +
          'остаётся ждать.',
        unpaid: `Сайт пишет: ${status}. Ждёт оплаты — её делают в браузере.`,
        granted: `Сайт пишет: ${status}. Визу выдали.`,
        refused: `Сайт пишет: ${status}. В заявлении отказано.`,
        unknown: `Сайт пишет: ${status}.`,
      })[meaning],
    captchaEntered: (seconds) =>
      `Вписал код. Отправлю анкету через ${seconds} секунд. Напишите ` +
      '«стой», чтобы отменить, или «далее», чтобы не ждать.',
    sendCountdown: (seconds) =>
      `Отправлю через ${seconds} секунд. Напишите «стой», чтобы ` +
      'отменить, или «далее», чтобы не ждать.',
    pastForm:
      'Анкета уже ушла дальше, и из чата я её не изменю. Исправьте в ' +
      'браузере или начните заново: /start.',
    languageSet: 'Говорю по-русски.',
  },
};

/** One compact line of related values, or nothing when that group is empty. */
function compactLine(label, ...values) {
  const present = values.filter(Boolean);
  return present.length ? `• ${label}: ${present.join(' · ')}` : '';
}

/** A page summary that does not print an empty heading. */
function compactSummary(heading, lines) {
  const present = lines.filter(Boolean);
  return present.length ? [heading, ...present].join('\n') : '';
}

/** The two ends of a visa validity window, where either end may be absent. */
function dateWindow(from, until) {
  return [from, until].filter(Boolean).join(' — ');
}

/** The three radio values in words natural to a Russian conversation. */
function genderInRussian(gender) {
  return (
    { Male: 'мужской', Female: 'женский', Other: 'другой' }[gender] ?? gender
  );
}

/** Stable filing outcomes in the traveller's language, never driver jargon. */
function filingReason(reason, language) {
  const known = {
    en: {
      'the site stayed on the review':
        'the site stayed on the review page after Submit',
      'not on the review page': 'the review page is not open',
      'not confirmed': 'the declaration was not confirmed',
    },
    ru: {
      'the site stayed on the review':
        'после нажатия Submit сайт остался на странице проверки',
      'not on the review page': 'страница проверки не открыта',
      'not confirmed': 'декларация не подтверждена',
    },
  };
  return known[language]?.[reason] ?? saidBriefly(reason);
}

/** Field prompts, so a request names the document in plain language. */
export const FIELD_PROMPTS = {
  en: {
    portraitPhoto: 'a portrait photo (white background, no glasses)',
    passportPage: 'a photo of your passport data page',
    surname: 'your surname',
    givenName: 'your given names',
    dateOfBirth: 'your date of birth',
    sex: 'your sex',
    nationality: 'your nationality',
    email: 'your email address',
    religion: 'your religion (write "None" if none)',
    placeOfBirth: 'your place of birth',
    passportNumber: 'your passport number',
    passportType: 'your passport type (usually Ordinary)',
    passportIssueDate: 'the passport issue date',
    passportExpiryDate: 'the passport expiry date',
    passportIssuingAuthority: 'the authority that issued the passport',
    permanentAddress: 'your permanent address',
    contactAddress: 'your contact address',
    phone: 'your phone number',
    emergencyName: 'an emergency contact name',
    emergencyAddress: 'the emergency contact address',
    emergencyPhone: 'the emergency contact phone',
    emergencyRelationship: 'your relationship to that contact',
    purpose: 'the purpose of your trip',
    validFrom: 'the first day you want the visa valid',
    validTo: 'the last day you want the visa valid',
    entryDate: 'your intended date of entry',
    stayLengthDays: 'how many days you intend to stay',
    addressInVietnam: 'your address in Viet Nam (a booking works)',
    provinceInVietnam: 'the province or city you will stay in',
    wardInVietnam: 'the ward or commune',
    entryBorderGate: 'the airport or border you will enter through',
    exitBorderGate: 'the airport or border you will leave through',
  },
  ru: {
    portraitPhoto: 'портретное фото (белый фон, без очков)',
    passportPage: 'фото страницы паспорта с данными',
    surname: 'фамилию',
    givenName: 'имя и отчество',
    dateOfBirth: 'дату рождения',
    sex: 'пол',
    nationality: 'гражданство',
    email: 'адрес электронной почты',
    religion: 'вероисповедание (напишите «Нет», если нет)',
    placeOfBirth: 'место рождения',
    passportNumber: 'номер паспорта',
    passportType: 'тип паспорта (обычно Ordinary)',
    passportIssueDate: 'дату выдачи паспорта',
    passportExpiryDate: 'дату окончания паспорта',
    passportIssuingAuthority: 'кем выдан паспорт',
    permanentAddress: 'адрес постоянной регистрации',
    contactAddress: 'контактный адрес',
    phone: 'номер телефона',
    emergencyName: 'контактное лицо на случай экстренной связи',
    emergencyAddress: 'адрес этого контактного лица',
    emergencyPhone: 'телефон этого контактного лица',
    emergencyRelationship: 'кем он вам приходится',
    purpose: 'цель поездки',
    validFrom: 'с какого дня нужна виза',
    validTo: 'по какой день нужна виза',
    entryDate: 'предполагаемую дату въезда',
    stayLengthDays: 'сколько дней планируете пробыть',
    addressInVietnam: 'адрес во Вьетнаме (подойдёт бронирование)',
    provinceInVietnam: 'провинцию или город пребывания',
    wardInVietnam: 'район или коммуну',
    entryBorderGate: 'через какой аэропорт или границу въезжаете',
    exitBorderGate: 'через какой аэропорт или границу выезжаете',
  },
};

/**
 * The codes Playwright dims its call log with.
 *
 * Built from the character code so no formatter can turn the escape into a
 * raw byte in the source. The escape is optional here: stripped of it on the
 * way through, the codes still reach a chat as a literal "[2m".
 */
const DIMMED = new RegExp(`${String.fromCharCode(27)}?\\[\\d+m`, 'g');

/**
 * One line naming what went wrong, for someone reading a chat.
 *
 * A Playwright error carries its whole call log in `message`: forty lines of
 * selectors, click actions and escape codes. That belongs in the log, where a
 * failing selector is diagnosed. The traveller needs the field and a reason
 * they can act on, so only the first line comes through, capped.
 */
export function saidBriefly(error) {
  const first = String(error?.message ?? error)
    .split('\n')[0]
    .replace(DIMMED, '')
    .replace(/\s+/g, ' ')
    .trim();
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}
