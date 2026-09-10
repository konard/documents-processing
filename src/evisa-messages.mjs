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
      '/visa — apply for an e-visa\n' +
      '/arrival — the pre-arrival declaration, for after the visa\n' +
      '/documents — fetch a filed application, its receipt and the visa\n\n' +
      'The buttons below change the language.',
    arrivalIntro:
      'The pre-arrival declaration is filed just before you fly, and needs ' +
      'the granted visa and the flight. Here is what I already have for it.',
    arrivalMissing: 'Still needed for it:',
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
    changedMark: '<b>(new)</b>',
    changedNote: 'What is marked (new) changed since the last form.',
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
      'The bot is shutting down, and the browser window with the form is ' +
      'being closed. Nothing is lost that you sent me. When the bot is back, ' +
      'say /visa and send the documents and details again.',
    browserClosed:
      'The browser window has closed, and the form in it is gone. I still ' +
      'have everything you sent: say "fill" and I open a new window and ' +
      'fill it again.',
    sentAsPhoto: (kb) =>
      `This came as a Telegram photo, shrunk to ${kb} KB with the camera's ` +
      'data stripped; the site may doubt a portrait like that. I use it, ' +
      'but a copy sent as a file (attach, then File) arrives as it is.',
    stopped:
      'Stopped. Nothing more is filled or sent, and the browser is closed. ' +
      'Say /visa to begin an application again.',
    alreadyFilling: 'Still filling. Next is not pressed without your word.',
    needed: 'Still needed:',
    thenAgain: 'Once you send it, I fill the form again and show it.',
    ready:
      'Check the form. If everything is right, say "send" and I press Next: ' +
      'the site then shows the application for review. If not, send the ' +
      'correction.',
    stages: {
      form: 'the application form',
      review: 'review of the application',
      declared: 'declaration completed',
      payment: 'payment',
      unknown: 'a page I do not know',
    },
    applicationIn:
      'The site took the code and registered the application. Its dialog ' +
      'says:',
    applicationInNext:
      'Note the electronic document code: it is what checks the status ' +
      'later. From here, go to the browser window: press Confirm there and ' +
      'go on to payment yourself. I press nothing in that dialog.',
    inBrowserNow:
      'The application is registered; the rest is in the browser window: ' +
      'Confirm in the dialog, then payment. I press nothing there.',
    stepMoved: (stage) =>
      `Pressed Next, and the site accepted the page. Now at: ${stage}. ` +
      'This is the whole page.',
    stepKept: 'Pressed Next, but the site kept the page.',
    reviewEmpty:
      'Pressed Next, and the site opened the review page, but empty: no ' +
      'application and no code on it. That is a failure on its side. Your ' +
      'form is still in the browser as you left it — say "send" to try Next ' +
      'again, or send a correction first.',
    stepMessages: (n) =>
      `${n} ${n === 1 ? 'message' : 'messages'} on it. Send the corrections.`,
    siteSaid: (text) => `The site said: "${text}".`,
    stepFailed: (why) =>
      `Could not press Next: ${why}. The browser is left open as it is.`,
    captchaAsk:
      'At the bottom the site asks for the code in this picture. Type it ' +
      'here as it is, and I press Next: that sends the application on to ' +
      'payment.',
    captchaAgain:
      'The site did not take the code. Here is a new picture; type its code.',
    readAsPassportPage:
      'This looks like a passport data page, so I used it as one. I could ' +
      'not read the machine line at the bottom of it, so send the details ' +
      'that are wrong and I will correct them.',
    unclearPicture:
      'I could not tell what this picture is, so I have not put it on the ' +
      'form. A portrait goes in as a photo of a face on a plain background; ' +
      'a passport goes in as the data page.',
    bookingWithoutAddress:
      'This looks like a booking, but I could not find the address on it. ' +
      'Send the address in Viet Nam as text and I will use that.',
    bookingAddress: (address, province, ward) =>
      ['Read the address in Viet Nam off this booking:', `• ${address}`]
        .concat(province ? [`• province: ${province}`] : [])
        .concat(ward ? [`• ward: ${ward}`] : [])
        .join('\n'),
    applicationKept: (number) =>
      `I have noted the application number ${number}. Once the payment goes ` +
      'through in the browser, I fetch the form and the receipt on my own; ' +
      'you can also ask any time with /documents.',
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
      'Send the application number with the command, like ' +
      '/documents E260908XXX0000000000. It is in the email the site sent ' +
      'when the application was filed.',
    documentsNoCaptcha:
      'The lookup page did not show a code picture. Try /documents again in ' +
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
      `Typed the code. Pressing Next in ${seconds} seconds, which sends the ` +
      'application in. Say "stop" to cancel, or "send" to skip the wait.',
    sendCountdown: (seconds) =>
      `Pressing Next in ${seconds} seconds. Say "stop" to cancel, or "send" ` +
      'to skip the wait.',
    pastForm:
      'The application has gone past the form, and I cannot change it from ' +
      'the chat. Correct it in the browser, or start over with /start.',
    unreadable:
      'I could not read that. Please send a sharper photo of the whole page.',
    languageSet: 'Now speaking English.',
  },
  ru: {
    welcome: 'Помогу подготовить заявление на электронную визу во Вьетнам.',
    menu:
      'Помогаю с документами для въезда во Вьетнам.\n\n' +
      '/visa — подать на электронную визу\n' +
      '/arrival — декларация перед прилётом, уже после визы\n' +
      '/documents — скачать поданное заявление, квитанцию и визу\n\n' +
      'Кнопки ниже меняют язык.',
    arrivalIntro:
      'Декларацию перед прилётом подают незадолго до вылета, для неё нужны ' +
      'выданная виза и рейс. Вот что у меня для неё уже есть.',
    arrivalMissing: 'Для неё ещё нужно:',
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
    changedMark: '<b>(новое)</b>',
    changedNote: 'Помеченное «(новое)» изменилось с прошлой анкеты.',
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
      'Бот выключается, окно браузера с анкетой сейчас закроется. Всё, что ' +
      'вы присылали, у меня сохранено. Когда бот вернётся, напишите /visa и ' +
      'пришлите документы и данные заново.',
    browserClosed:
      'Окно браузера закрылось, и анкета в нём пропала. Всё присланное я ' +
      'помню: напишите «заполняй», и я открою новое окно и заполню заново.',
    sentAsPhoto: (kb) =>
      `Это пришло как фото: Telegram сжал его до ${kb} КБ и убрал данные ` +
      'камеры, и сайт может усомниться в таком портрете. Я его использую, ' +
      'но лучше прислать ещё раз как файл (скрепка, затем «Файл»).',
    stopped:
      'Остановил. Больше ничего не заполняю и не отправляю, браузер закрыт. ' +
      'Чтобы начать заново, напишите /visa.',
    alreadyFilling: 'Ещё заполняю. «Next» без вашего слова не нажму.',
    needed: 'Ещё нужно:',
    thenAgain: 'Как пришлёте, заполню анкету заново и покажу.',
    ready:
      'Проверьте анкету. Если всё верно, напишите «отправляй», и я нажму ' +
      '«Next»: сайт покажет анкету на проверку. Если нет, пришлите ' +
      'исправление.',
    stages: {
      form: 'анкета',
      review: 'проверка анкеты',
      declared: 'заявление принято',
      payment: 'оплата',
      unknown: 'незнакомая мне страница',
    },
    applicationIn:
      'Сайт принял код и зарегистрировал заявление. В его окне написано:',
    applicationInNext:
      'Запишите код электронного документа: по нему потом проверяют ' +
      'статус. Дальше в окне браузера: нажмите там «Confirm» и пройдите ' +
      'оплату сами. В этом окне я ничего не нажимаю.',
    inBrowserNow:
      'Заявление зарегистрировано, дальше в окне браузера: «Confirm» в ' +
      'окне сайта, потом оплата. Там я ничего не нажимаю.',
    stepMoved: (stage) =>
      `Нажал «Next», сайт принял страницу. Шаг: ${stage}. Вот вся страница.`,
    stepKept: 'Нажал «Next», но сайт оставил страницу.',
    reviewEmpty:
      'Нажал «Next», сайт открыл страницу проверки, но пустую: ни анкеты, ' +
      'ни кода на ней. Это сбой на его стороне. Ваша анкета в браузере ' +
      'осталась как была — напишите «отправляй», чтобы попробовать ещё раз, ' +
      'или сначала пришлите исправление.',
    stepMessages: (n) => `Замечаний на ней: ${n}. Пришлите исправления.`,
    siteSaid: (text) => `Сайт ответил: «${text}».`,
    stepFailed: (why) =>
      `Нажать «Next» не вышло: ${why}. Браузер оставлен как есть.`,
    captchaAsk:
      'Внизу сайт просит код с этой картинки. Напишите его сюда как есть, и ' +
      'я нажму «Next»: это отправит анкету дальше, к оплате.',
    captchaAgain: 'Сайт не принял код. Вот новая картинка, напишите код с неё.',
    readAsPassportPage:
      'Похоже на страницу паспорта с данными — так её и использую. Машинную ' +
      'строку внизу прочитать не удалось, поэтому пришлите то, что неверно, ' +
      'и я поправлю.',
    unclearPicture:
      'Не понял, что на этой картинке, и в анкету её не поставил. ' +
      'Портретное фото — лицо на однотонном фоне; паспорт — страница с ' +
      'данными.',
    bookingWithoutAddress:
      'Похоже на бронирование, но адреса на нём я не нашёл. Пришлите адрес ' +
      'во Вьетнаме текстом, и я впишу его.',
    bookingAddress: (address, province, ward) =>
      ['Взял адрес во Вьетнаме из бронирования:', `• ${address}`]
        .concat(province ? [`• провинция: ${province}`] : [])
        .concat(ward ? [`• район: ${ward}`] : [])
        .join('\n'),
    applicationKept: (number) =>
      `Запомнил номер заявления ${number}. Как только в браузере пройдёт ` +
      'оплата, сам скачаю анкету и квитанцию; можно и в любой момент ' +
      'спросить командой /documents.',
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
      'Пришлите номер заявления вместе с командой, например ' +
      '/documents E260908XXX0000000000. Он есть в письме, которое сайт ' +
      'прислал при подаче.',
    documentsNoCaptcha:
      'Страница поиска не показала картинку с кодом. Попробуйте /documents ' +
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
      `Вписал код. Нажму «Next» через ${seconds} секунд, это отправит ` +
      'заявление. Напишите «стой», чтобы отменить, или «отправляй», чтобы ' +
      'не ждать.',
    sendCountdown: (seconds) =>
      `Нажму «Next» через ${seconds} секунд. Напишите «стой», чтобы ` +
      'отменить, или «отправляй», чтобы не ждать.',
    pastForm:
      'Анкета уже ушла дальше, и из чата я её не изменю. Исправьте в ' +
      'браузере или начните заново: /start.',
    unreadable:
      'Не удалось прочитать. Пришлите более чёткое фото всей страницы.',
    languageSet: 'Говорю по-русски.',
  },
};

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
