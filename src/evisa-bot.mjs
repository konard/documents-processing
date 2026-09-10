#!/usr/bin/env node
// evisa-bot.mjs
//
// A Telegram bot that collects what a Vietnam e-visa application needs, in
// Russian or English, and shows the applicant the filled form.
//
// Documents and the values read from them are held while the application is
// being prepared, and kept afterwards for diagnosis; evisa-log describes what
// is written where, and clears it on a schedule.
//
// Which fields are required is read from the live form, so a change on the
// government side surfaces as a question to the applicant.
//
// Usage:
//   EVISA_BOT_TOKEN=... node src/evisa-bot.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  looksLikeAddress,
  stripAddressLabel,
  stripAddressNote,
} from './evisa-home-address.mjs';
import { PREARRIVAL_FIELDS as PREARRIVAL_ORDER } from './evisa-prearrival.mjs';
import { canonicalBorderGate } from './evisa-data.mjs';
import { BORDER_GATES } from './evisa-schema.mjs';

/**
 * How long a chat may go quiet before the bot fills the form on its own.
 *
 * Enough for the next of several messages sent together to arrive, and not
 * more: the fill is the answer, and nothing else is said until it is done.
 * The filled form is checked in the browser, and Next is only pressed on
 * the applicant's word, so the fill itself is safe to run without asking.
 */
export const IDLE_FILL_MS = 20_000;

/**
 * How long the bot waits between the applicant's word to send and pressing
 * Next: time to say "стой" after all. The one countdown in the conversation,
 * since this is the one step that is hard to take back.
 */
export const SEND_COUNTDOWN_MS = 30_000;

/**
 * How long a chat's browser is kept after its last message.
 *
 * A browser holds the filled form, so an applicant who comes back an hour
 * later finds it as they left it. One that nobody has touched for five
 * hours is not coming back, and each one open costs memory.
 */
export const CHAT_TTL_MS = 5 * 60 * 60 * 1000;

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
    sections: {
      applicant: 'Applicant',
      passport: 'Passport',
      contacts: 'Contacts',
      emergency: 'Emergency contact',
      trip: 'Trip',
    },
    assumedMark: '(assumed)',
    assumedNote:
      'What is marked "(assumed)" was not given, so I chose it. If any of ' +
      'it is wrong, send the value you want.',
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
      `Ticked the declarations under the form: ${names.join(', ')}.`,
    failed: (field, why) => `Could not fill ${field}: ${why}`,
    fillFailed: (why) =>
      `Filling stopped: ${why}. The browser is left open with the form as ` +
      'far as it got.',
    browserGone:
      'Filling stopped: the browser closed, most likely because the bot was ' +
      'restarted. Send /start, then the documents and details again.',
    restarting:
      'The bot is restarting, and this browser closes with it. Afterwards, ' +
      'send /start, then the documents and details again.',
    browserClosed:
      'The browser window has closed, and the form in it is gone. I still ' +
      'have everything you sent: say "fill" and I open a new window and ' +
      'fill it again.',
    sentAsPhoto: (kb) =>
      `This came as a Telegram photo, shrunk to ${kb} KB with the camera's ` +
      'data stripped; the site may doubt a portrait like that. I use it, ' +
      'but a copy sent as a file (attach, then File) arrives as it is.',
    stopped:
      'Stopped. Send corrections, or say "send" when everything is right.',
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
    fieldStuck: (fields) =>
      `The site will not take ${fields.join(', ')}, and filling the form ` +
      'again changes nothing. Send the value you want for it and I will try ' +
      'that; everything else on the form is as you saw it.',
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
    sections: {
      applicant: 'Заявитель',
      passport: 'Паспорт',
      contacts: 'Контакты',
      emergency: 'Экстренный контакт',
      trip: 'Поездка',
    },
    assumedMark: '(по умолчанию)',
    assumedNote:
      'Помеченное «(по умолчанию)» вы не указывали, я подставил сам. Если ' +
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
    declared: (names) => `Поставил галочки под анкетой: ${names.join(', ')}.`,
    failed: (field, why) => `Не удалось заполнить ${field}: ${why}`,
    fillFailed: (why) =>
      `Заполнение прервалось: ${why}. Браузер оставлен открытым с формой в ` +
      'том виде, до которого дошло.',
    browserGone:
      'Заполнение прервалось: браузер закрылся, скорее всего из-за ' +
      'перезапуска бота. Пришлите /start, затем документы и данные заново.',
    restarting:
      'Бот перезапускается, и этот браузер закрывается вместе с ним. Когда ' +
      'он вернётся, пришлите /start, затем документы и данные заново.',
    browserClosed:
      'Окно браузера закрылось, и анкета в нём пропала. Всё присланное я ' +
      'помню: напишите «заполняй», и я открою новое окно и заполню заново.',
    sentAsPhoto: (kb) =>
      `Это пришло как фото: Telegram сжал его до ${kb} КБ и убрал данные ` +
      'камеры, и сайт может усомниться в таком портрете. Я его использую, ' +
      'но лучше прислать ещё раз как файл (скрепка, затем «Файл»).',
    stopped:
      'Остановил. Пришлите исправления или напишите «отправляй», когда всё ' +
      'верно.',
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
    fieldStuck: (fields) =>
      `Сайт не принимает ${fields.join(', ')}, и повторное заполнение ничего ` +
      'не меняет. Пришлите нужное значение — попробую его; остальное в ' +
      'анкете такое же, как вы видели.',
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

/**
 * Field names for a list of values, where a prompt's wording would not read:
 * "your surname: DOE" and "фамилию: DOE" are questions, not labels. Only the
 * fields whose prompt does not serve as a label are here.
 */
export const FIELD_LABELS = {
  en: {
    surname: 'surname',
    givenName: 'given names',
    dateOfBirth: 'date of birth',
    sex: 'sex',
    nationality: 'nationality',
    email: 'email',
    religion: 'religion',
    placeOfBirth: 'place of birth',
    passportNumber: 'passport number',
    passportType: 'passport type',
    passportIssueDate: 'passport issued on',
    passportExpiryDate: 'passport expires on',
    passportIssuingAuthority: 'passport issued by',
    permanentAddress: 'permanent address',
    contactAddress: 'contact address',
    phone: 'phone',
    emergencyName: 'name',
    emergencyAddress: 'address',
    emergencyPhone: 'phone',
    emergencyRelationship: 'relationship',
    purpose: 'purpose',
    validFrom: 'visa valid from',
    validTo: 'visa valid to',
    entryDate: 'entry date',
    stayLengthDays: 'days of stay',
    addressInVietnam: 'address in Viet Nam',
    provinceInVietnam: 'province or city',
    wardInVietnam: 'ward or commune',
    entryBorderGate: 'entering through',
    exitBorderGate: 'leaving through',
  },
  ru: {
    surname: 'фамилия',
    givenName: 'имя и отчество',
    dateOfBirth: 'дата рождения',
    sex: 'пол',
    nationality: 'гражданство',
    email: 'электронная почта',
    religion: 'вероисповедание',
    placeOfBirth: 'место рождения',
    passportNumber: 'номер паспорта',
    passportType: 'тип паспорта',
    passportIssueDate: 'дата выдачи',
    passportExpiryDate: 'действителен до',
    passportIssuingAuthority: 'кем выдан',
    permanentAddress: 'адрес регистрации',
    contactAddress: 'контактный адрес',
    phone: 'телефон',
    emergencyName: 'имя',
    emergencyAddress: 'адрес',
    emergencyPhone: 'телефон',
    emergencyRelationship: 'кем приходится',
    purpose: 'цель поездки',
    validFrom: 'виза с',
    validTo: 'виза по',
    entryDate: 'дата въезда',
    stayLengthDays: 'дней пребывания',
    addressInVietnam: 'адрес во Вьетнаме',
    provinceInVietnam: 'провинция или город',
    wardInVietnam: 'район или коммуна',
    entryBorderGate: 'въезд через',
    exitBorderGate: 'выезд через',
  },
};

/** The label for a field in a list of values. */
function labelFor(key, language) {
  const labels = FIELD_LABELS[language] ?? FIELD_LABELS.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  return labels[key] ?? prompts[key] ?? key;
}

/** Words that tell the bot to fill the form now, without waiting. */
const CONFIRMATIONS =
  /^[^\p{L}\p{N}]*(?:подтверждаю|отправляй|отправляйте|отправь|отправьте|отправить|заполняй|заполни|готово|давай|поехали|confirm(?:ed)?|go|fill|send|submit|ok|okay|yes|да)[^\p{L}\p{N}]*$/iu;

/** True for a message that says "go ahead", in either language. */
export function isConfirmation(text) {
  return CONFIRMATIONS.test(String(text ?? '').trim());
}

/** Words that tell the bot not to fill: the applicant wants another look. */
const CANCELLATIONS =
  /^[^\p{L}\p{N}]*(?:стой|стоп|отмена|отменить|отмени|подожди|погоди|не\s+(?:отправляй|заполняй)|stop|cancel|wait|hold\s+on|don'?t)[^\p{L}\p{N}]*$/iu;

/**
 * True for an error that says the browser or its page has gone: Playwright
 * words it in a few ways, all of them "closed".
 */
export function browserHasGone(error) {
  return /(?:target|page|context|browser)[^.]*(?:has been |was )?closed/i.test(
    String(error?.message ?? error)
  );
}

/**
 * True for a message that is only a captcha code: the site's are six
 * letters and digits, and a code is never mistaken for a detail.
 */
export function looksLikeCaptcha(text) {
  return /^[A-Za-z0-9]{4,8}$/.test(String(text ?? '').trim());
}

/** True for a message that says "stop", in either language. */
export function isCancellation(text) {
  return CANCELLATIONS.test(String(text ?? '').trim());
}

/**
 * Picks a language from what the applicant wrote.
 *
 * Cyrillic means Russian; otherwise English. Telegram's own language setting is
 * used only when the message carries no letters to judge by.
 */
export function detectLanguage(text, telegramCode) {
  if (typeof text === 'string' && /[Ѐ-ӿ]/.test(text)) {
    return 'ru';
  }
  if (typeof text === 'string' && /[A-Za-z]/.test(text)) {
    return 'en';
  }
  return String(telegramCode ?? '').startsWith('ru') ? 'ru' : 'en';
}

/** Lists what is still needed, in the applicant's language. */
export function describeMissing(fields, language) {
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const lines = fields.map(
    (field) => `• ${prompts[field.name] ?? field.label ?? field.name}`
  );
  return `${MESSAGES[language].needed}\n${lines.join('\n')}`;
}

/**
 * Fields that need no question: mirrored from another answer, or given a
 * sensible default the applicant can change in the browser.
 */
export const NOT_ASKED = [
  'confirmEmail',
  'passportType',
  'religion',
  'purpose',
  'contactAddress',
  'entryBorderGate',
  'exitBorderGate',
  'provinceInVietnam',
  'validFrom',
  'validTo',
  'entryDate',
];

/** Fields a passport photo answers, so they are not asked for separately. */
export const FROM_PASSPORT = [
  'surname',
  'givenName',
  'dateOfBirth',
  'sex',
  'nationality',
  'passportNumber',
  'passportExpiryDate',
  'passportIssueDate',
  'placeOfBirth',
];

/** Groups the remaining details under the part of the trip they belong to. */
export const DETAIL_GROUPS = {
  en: {
    you: 'About you',
    trip: 'Your trip',
    contact: 'Contacts',
  },
  ru: {
    you: 'О вас',
    trip: 'Поездка',
    contact: 'Контакты',
  },
};

const GROUP_OF = {
  email: 'you',
  confirmEmail: 'you',
  religion: 'you',
  permanentAddress: 'you',
  contactAddress: 'you',
  phone: 'you',
  emergencyName: 'contact',
  emergencyAddress: 'contact',
  emergencyPhone: 'contact',
  emergencyRelationship: 'contact',
};

/**
 * The checklist shown at /start, as a single message.
 *
 * Everything a passport photo answers is listed under that photo, so an
 * applicant can see that sending one picture covers nine of the entries rather
 * than reading them as nine separate questions.
 */
export function describeChecklist(fields, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const groups = DETAIL_GROUPS[language] ?? DETAIL_GROUPS.en;
  const name = (field) => prompts[field.name] ?? field.label ?? field.name;

  const parts = [strings.welcome, ''];

  parts.push(`${strings.checklistDocuments}:`);
  parts.push(`• ${prompts.passportPage} — ${strings.readFromPassport}`);
  parts.push(`• ${prompts.portraitPhoto}`);

  // Anything the passport answers is covered above.
  const remaining = fields.filter(
    (field) =>
      !FROM_PASSPORT.includes(field.name) &&
      !NOT_ASKED.includes(field.name) &&
      field.name !== 'passportPage' &&
      field.name !== 'portraitPhoto'
  );

  for (const [key, heading] of Object.entries(groups)) {
    const inGroup = remaining.filter(
      (field) => (GROUP_OF[field.name] ?? 'trip') === key
    );
    if (inGroup.length) {
      parts.push('', `${heading}:`);
      parts.push(...inGroup.map((field) => `• ${name(field)}`));
    }
  }

  parts.push('', strings.checklistFooter);
  return parts.join('\n');
}

/** What each of the declaration's fields is called, to the applicant. */
const ARRIVAL_LABELS = {
  en: {
    fullName: 'full name',
    gender: 'sex',
    dateOfBirth: 'date of birth',
    nationality: 'nationality',
    passportNumber: 'passport',
    passportExpiryDate: 'passport expires',
    email: 'email',
    phone: 'phone',
    visaType: 'visa type',
    visaNumber: 'visa number',
    visaIssueDate: 'visa issued',
    visaExpiryDate: 'visa expires',
    visaIssuedPlace: 'issued by',
    arrivalDate: 'arriving on',
    departedFrom: 'flying from',
    purpose: 'purpose',
    departureDate: 'leaving Viet Nam on',
    modeOfTravel: 'travelling by',
    borderGate: 'arriving at',
    vehicleNumber: 'flight number',
    accommodationType: 'staying in',
    accommodationAddress: 'address in Viet Nam',
  },
  ru: {
    fullName: 'имя и фамилия',
    gender: 'пол',
    dateOfBirth: 'дата рождения',
    nationality: 'гражданство',
    passportNumber: 'паспорт',
    passportExpiryDate: 'паспорт действует до',
    email: 'почта',
    phone: 'телефон',
    visaType: 'тип визы',
    visaNumber: 'номер визы',
    visaIssueDate: 'виза выдана',
    visaExpiryDate: 'виза действует до',
    visaIssuedPlace: 'кем выдана',
    arrivalDate: 'дата прилёта',
    departedFrom: 'откуда летите',
    purpose: 'цель поездки',
    departureDate: 'дата вылета из Вьетнама',
    modeOfTravel: 'вид транспорта',
    borderGate: 'пункт прибытия',
    vehicleNumber: 'номер рейса',
    accommodationType: 'где остановитесь',
    accommodationAddress: 'адрес во Вьетнаме',
  },
};

// The parts of the form are named where the parts themselves are defined.
export { sectionName } from './evisa-sections.mjs';

/** Fields where a hyphen the site refuses is worth remarking on. */
const HYPHEN_NOTED = ['surname', 'givenName', 'emergencyName'];

/** The three parts a pre-arrival declaration is printed in. */
const ARRIVAL_GROUPS = {
  en: { passenger: 'Passenger', visa: 'Visa', trip: 'Trip' },
  ru: { passenger: 'Пассажир', visa: 'Виза', trip: 'Поездка' },
};

/**
 * The pre-arrival declaration as it stands: what is known, and what is not.
 *
 * The visa's own details are the usual blank, since they exist only after a
 * grant, so a declaration read before then is mostly a list of what to come
 * back for.
 */
export function describeDeclaration(values, missing, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const groups = ARRIVAL_GROUPS[language] ?? ARRIVAL_GROUPS.en;
  const labels = ARRIVAL_LABELS[language] ?? ARRIVAL_LABELS.en;
  const parts = [];
  for (const [key, heading] of Object.entries(groups)) {
    const lines = PREARRIVAL_ORDER.filter(
      (field) => field.group === key && values[field.key]
    ).map(
      (field) =>
        `• ${labels[field.key] ?? field.label}: ${escapeHtml(values[field.key])}`
    );
    if (lines.length) {
      parts.push(`<b>${heading}</b>`, ...lines, '');
    }
  }
  if (missing.length) {
    parts.push(`<b>${strings.arrivalMissing}</b>`);
    parts.push(...missing.map((key) => `• ${labels[key] ?? key}`));
  }
  return parts.join('\n').trim();
}

/** Telegram's limit on the caption under a file. */
const CAPTION_LIMIT = 1024;

/**
 * Everything there is to say about a fill, as one text: the caption under
 * the captured page.
 *
 * One message, not four. How many fields went in; how the site's own reading
 * of the passport compared, since it asks the applicant to check those;
 * which declarations were ticked, since each is made in the applicant's
 * name; what could not be filled; and either what is still needed or that
 * the form waits for their word before Next is pressed.
 */
export function describeOutcome(result, outstanding, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const parts = [strings.filled(result.filled.length)];

  if (result.agreed?.length) {
    parts.push(strings.siteAgreed(result.agreed.length));
  }
  if (result.declared?.ticked?.length) {
    parts.push(
      strings.declared(
        result.declared.ticked.map((key) => strings.declarations[key] ?? key)
      )
    );
  }
  if (result.corrected?.length) {
    parts.push('', strings.siteCorrected);
    for (const change of result.corrected) {
      parts.push(
        `• ${labelFor(change.field, language)}: "${change.was}" → "${change.now}"`
      );
    }
  }
  const failures = result.failures ?? [];
  if (failures.length) {
    parts.push('');
    for (const failure of failures.slice(0, 5)) {
      parts.push(strings.failed(failure.field, failure.error.split('\n')[0]));
    }
  }
  parts.push('');
  if (outstanding.length) {
    parts.push(describeMissing(outstanding, language), strings.thenAgain);
  } else {
    parts.push(strings.ready);
  }
  const text = parts.join('\n');
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 1)}…`
    : text;
}

/**
 * What to say under the page captured after Next: that the site took the
 * page and which stage it shows now, or that it kept the page, with the
 * form's first few messages and whatever the site said in a dialog.
 */
/** What to say under a page that the site accepted and went on from. */
function describeArrival(step, strings) {
  if (step.stage === 'declared') {
    const lines = step.dialog?.lines ?? [];
    return [
      strings.applicationIn,
      ...lines,
      '',
      strings.applicationInNext,
    ].join('\n');
  }
  if (step.stage === 'review' && step.empty) {
    return strings.reviewEmpty;
  }
  return strings.stepMoved(
    strings.stages[step.stage] ?? strings.stages.unknown
  );
}

export function describeStep(step, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  if (step.moved) {
    return describeArrival(step, strings);
  }
  const parts = [strings.stepKept];
  const errors = step.errors ?? [];
  const notices = step.notices ?? [];
  if (errors.length) {
    parts.push(
      strings.stepMessages(errors.length),
      '',
      ...errors.slice(0, 8).map((error) => `• ${error}`)
    );
  }
  for (const notice of notices) {
    parts.push(strings.siteSaid(notice));
  }
  const text = parts.join('\n');
  return text.length > CAPTION_LIMIT
    ? `${text.slice(0, CAPTION_LIMIT - 1)}…`
    : text;
}

/** The form's fields in groups, in the order a reader looks for them. */
export const SECTIONS = [
  [
    'applicant',
    [
      'surname',
      'givenName',
      'dateOfBirth',
      'sex',
      'nationality',
      'placeOfBirth',
      'religion',
    ],
  ],
  [
    'passport',
    [
      'passportNumber',
      'passportType',
      'passportIssueDate',
      'passportExpiryDate',
      'passportIssuingAuthority',
    ],
  ],
  ['contacts', ['email', 'phone', 'permanentAddress', 'contactAddress']],
  [
    'emergency',
    [
      'emergencyName',
      'emergencyRelationship',
      'emergencyPhone',
      'emergencyAddress',
    ],
  ],
  [
    'trip',
    [
      'purpose',
      'entryDate',
      'validFrom',
      'validTo',
      'stayLengthDays',
      'entryBorderGate',
      'exitBorderGate',
      'addressInVietnam',
      'provinceInVietnam',
      'wardInVietnam',
    ],
  ],
];

/** What a mirrored value follows from; true when that was given. */
function derivedFrom(key, supplied) {
  switch (key) {
    case 'contactAddress':
      return Boolean(supplied.permanentAddress);
    case 'validFrom':
      return Boolean(supplied.entryDate);
    case 'validTo':
      return true;
    default:
      return false;
  }
}

/** Makes a value safe inside Telegram HTML, where the titles are bold. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Reports everything the form was filled with, in one message, as Telegram
 * HTML: the explanation that follows the captured page.
 *
 * Forty values in one list are hard to check, so they are grouped the way
 * the form itself is: applicant, passport, contacts, emergency contact, trip.
 * A value the applicant did not give is marked, since it is a decision made
 * on their behalf that ends up on a government form. A value that follows
 * from one they did give, the contact address from the permanent one or the
 * visa's first day from the entry date, is marked with where it came from
 * instead, since calling it assumed would say their answer was ignored.
 * Only what has not been said already is listed: the second form of a
 * conversation carries the same defaults as the first, and reading them
 * twice tells the applicant nothing.
 */
export function describeSummary(
  applicant,
  supplied,
  language,
  reported = {},
  disputed = {}
) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const fresh = (key) =>
    applicant[key] && prompts[key] && reported[key] !== applicant[key];
  let assumedAny = false;

  const markFor = (key) => {
    if (supplied[key]) {
      return '';
    }
    if (strings.derived[key] && derivedFrom(key, supplied)) {
      return ` ${strings.derived[key]}`;
    }
    assumedAny = true;
    return ` ${strings.assumedMark}`;
  };

  // A name the passport hyphenates goes on the form with a space, and the
  // line says so, since the applicant will look for the hyphen. Only names:
  // a date is written one way here and another in the passport, and saying
  // so tells the applicant nothing they need.
  const noteFor = (key) => {
    if (!HYPHEN_NOTED.includes(key)) {
      return '';
    }
    const given = String(supplied[key] ?? '');
    return given.includes('-') && !String(applicant[key]).includes('-')
      ? ` ${strings.hyphenNote(escapeHtml(given))}`
      : '';
  };
  // A field the passport's readers split on has no value yet: the line
  // names the readings and asks.
  const disputedLine = (key) =>
    `• ${labelFor(key, language)}: ${strings.disputedNote(
      disputed[key].map((value) => `<b>${escapeHtml(value)}</b>`)
    )}`;
  const blocks = SECTIONS.map(([section, keys]) => {
    const lines = keys
      .filter((key) => fresh(key) || (disputed[key] && !applicant[key]))
      .map((key) =>
        disputed[key] && !applicant[key]
          ? disputedLine(key)
          : `• ${labelFor(key, language)}${markFor(key)}: ${escapeHtml(applicant[key])}${noteFor(key)}`
      );
    if (!lines.length) {
      return null;
    }
    return [`<b>${strings.sections[section]}</b>`, ...lines].join('\n');
  });
  const shown = blocks.filter(Boolean);
  if (!shown.length) {
    return null;
  }
  const parts = [strings.summary, '', shown.join('\n\n')];
  if (assumedAny) {
    parts.push('', strings.assumedNote);
  }
  return parts.join('\n');
}

/**
 * Pulls applicant details out of ordinary prose, in either language.
 *
 * This is deliberately forgiving: someone typing "паспорт 12 34 567890" or
 * "my flight lands on 5 December" should not have to learn a format.
 */
export function parseFreeText(text) {
  const found = {};
  if (typeof text !== 'string' || !text.trim()) {
    return found;
  }

  const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (email) {
    found.email = email[0];
  }

  // A passport number is a run of digits, possibly spaced in pairs.
  const passport = text.match(
    /(?:passport|паспорт)\D{0,12}((?:\d[\s-]?){8,10})/i
  );
  if (passport) {
    found.passportNumber = passport[1].replace(/[\s-]/g, '');
  }

  const days = text.match(/(\d{1,3})\s*(?:days?|дн(?:я|ей|ём)?|суток)/i);
  if (days) {
    found.stayLengthDays = days[1];
  }

  parseLines(text, found, email?.[0]);

  return found;
}

/** Words that say a phone, a name or an address belongs to the contact person. */
const CONTACT_WORDS =
  /контакт|contact|родствен|relative|экстрен|emergency|сестр|брат|мам|мать|отец|пап|муж|жен|друг|подруг|сын|доч|т[её]т[яеи]|дяд|бабушк|бабул|дедушк|дед[аеу]?\b|внук|внучк|племянни|кузен|кузин|двоюродн|партн[её]р|sister|brother|mother|father|husband|wife|son|daughter|friend|aunt|uncle|grand(?:mother|father|ma|pa|son|daughter)|niece|nephew|cousin|partner/i;

/** A line that opens the block about the contact person. */
const CONTACT_HEADING =
  /^(?:(?:экстренн\w*|emergency)\s+)?(?:контакт\w*(?:\s+лицо)?|contact(?:\s+person)?)\s*:\s*(.*)$/i;

/** How a relative is described, and the word the form gets for it. */
const RELATIONSHIPS = [
  // The longer words first: "grandmother" holds "mother", "внучка" "внук".
  [/бабушк|бабул|grandmother|grandma/i, 'Grandmother'],
  [/дедушк|дед[аеу]?\b|grandfather|grandpa/i, 'Grandfather'],
  [/внучк|granddaughter/i, 'Granddaughter'],
  [/внук|grandson/i, 'Grandson'],
  [/т[её]т[яеи]|aunt/i, 'Aunt'],
  [/дяд|uncle/i, 'Uncle'],
  [/племянниц|niece/i, 'Niece'],
  [/племянник|nephew/i, 'Nephew'],
  [/кузен|кузин|двоюродн|cousin/i, 'Cousin'],
  [/сестр|sister/i, 'Sister'],
  [/брат|brother/i, 'Brother'],
  [/мам|мать|mother/i, 'Mother'],
  [/отец|отц|пап|father/i, 'Father'],
  [/муж|husband/i, 'Husband'],
  [/жен|wife/i, 'Wife'],
  [/сын|son\b/i, 'Son'],
  [/доч|daughter/i, 'Daughter'],
  [/партн[её]р|partner/i, 'Partner'],
  [/друг|подруг|friend/i, 'Friend'],
  [/коллег|colleague/i, 'Colleague'],
  [/родствен|relative/i, 'Relative'],
];

/** Values people write with a label in front, in either language. */
const LABELLED = [
  [
    /(?:дата\s+выдачи|выдан\w*|date\s+of\s+issue|issued(?:\s+on)?)\s*:?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{4})/i,
    'passportIssueDate',
  ],
  [
    /(?:место\s+рождения|place\s+of\s+birth|born\s+in)\s*:?\s*([^,;\n]+)/i,
    'placeOfBirth',
  ],
  [
    /(?:орган|кем\s+выдан|authority|issued\s+by)\s*:?\s*([^,;\n]+)/i,
    'passportIssuingAuthority',
  ],
];

/** A short label ending in a colon, with whatever follows it on the line. */
const LABELLED_LINE = /^(\p{L}[\p{L} ]{0,30}?)\s*:\s*(.*)$/u;

/** A line that says when the applicant flies or enters. */
// "въезд" is often typed "вьезд", and the two are indistinguishable to a
// reader, so both hard and soft signs are accepted.
const GATE_WORDS =
  /\b(?:border gate|landport|land port|seaport|sea port|airport|checkpoint|погранпереход|пункт пропуска|аэропорт|порт)\b/i;

const ENTRY_WORDS =
  /билет|вылет|прил[её]т|в[ъь]езд|arriv|flight|entry|ticket|дата\s+вьезда/i;

/** Months by their opening letters, in Russian and English. */
const MONTH_STEMS = [
  /^(?:янв|jan)/i,
  /^(?:фев|feb)/i,
  /^(?:мар|mar)/i,
  /^(?:апр|apr)/i,
  /^(?:ма[йя]|may)/i,
  /^(?:июн|jun)/i,
  /^(?:июл|jul)/i,
  /^(?:авг|aug)/i,
  /^(?:сен|sep)/i,
  /^(?:окт|oct)/i,
  /^(?:ноя|nov)/i,
  /^(?:дек|dec)/i,
];

/** A date as people write it: "16 сентября 2026 года", "5 Oct 2026", "16.09.2026". */
const WRITTEN_DATE =
  /(\d{1,2})\s+(\p{L}{3,})\.?,?\s+(\d{4})|(\d{1,2})[./-](\d{1,2})[./-](\d{4})/u;

/** The relationship named in a piece of text, as the form words it. */
function relationshipIn(text) {
  return RELATIONSHIPS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/**
 * The date written in a line, as the form wants it, or null.
 *
 * A month written in words is unambiguous, so "16 сентября 2026" and
 * "16.09.2026" both give 16/09/2026.
 */
export function dateInLine(line) {
  const match = String(line ?? '').match(WRITTEN_DATE);
  if (!match) {
    return null;
  }
  const [, dayWord, monthWord, yearWord, day, month, year] = match;
  if (day) {
    return `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`;
  }
  const index = MONTH_STEMS.findIndex((stem) => stem.test(monthWord));
  if (index < 0) {
    return null;
  }
  const monthNumber = String(index + 1).padStart(2, '0');
  return `${dayWord.padStart(2, '0')}/${monthNumber}/${yearWord}`;
}

/**
 * Takes a gate a line names as both the way in and the way out, which is
 * what a single-entry visa means.
 */
function noteBorderGate(line, found) {
  const gate = borderGateInLine(line);
  if (gate) {
    found.entryBorderGate ??= gate;
    found.exitBorderGate ??= gate;
  }
}

/**
 * The border gate a line names, as the form's dropdown spells it.
 *
 * An applicant writes the gate the way the instruction page does, or the way
 * a search engine gave it: "Bo Y International Border Gate" for what the form
 * calls "Bo Y Landport". A line is only read as a gate when it resolves to
 * exactly one of the site's own options.
 */
export function borderGateInLine(line) {
  const text = String(line ?? '').trim();
  // A gate names a place and its kind, so a line with neither is not one.
  if (!GATE_WORDS.test(text) || text.length > 60) {
    return null;
  }
  const resolved = canonicalBorderGate(stripAddressLabel(text));
  return BORDER_GATES.includes(resolved) ? resolved : null;
}

/**
 * Reads a heading that opens the contact person's block.
 *
 * "Контакт:" and "Emergency contact:" open it by name; so does a relation on
 * its own, "Сестра:" or "Brother: John Smith", which also says who the
 * contact is. Whatever follows the colon is read as the first line of the
 * block.
 */
function openContactBlock(line, found) {
  const heading = line.match(CONTACT_HEADING);
  if (heading) {
    return heading[1].trim();
  }
  const labelled = line.match(LABELLED_LINE);
  if (!labelled) {
    return null;
  }
  const [, label, rest] = labelled;
  const relation = relationshipIn(label);
  if (!relation || label.trim().split(/\s+/).length > 2) {
    return null;
  }
  found.emergencyRelationship ??= relation;
  return rest.trim();
}

/** True for a line that is a person's name: two to four words of letters. */
function looksLikeName(line) {
  const words = line.trim().split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((word) => /^\p{L}[\p{L}'-]*$/u.test(word)) &&
    !CONTACT_WORDS.test(line)
  );
}

/**
 * Puts each phone on a line where it belongs.
 *
 * The words before a phone say whose it is: "телефон сестры +7..." is the
 * contact's, a bare number is the applicant's. When the applicant already
 * has one, any other is the contact's, and the words before it name the
 * relation.
 */
function parsePhones(line, found, inContact) {
  const pattern = /\+\d[\d\s()-]{7,}\d/g;
  const matches = [...line.matchAll(pattern)];
  matches.forEach((match, index) => {
    const previous = matches[index - 1];
    const next = matches[index + 1];
    const before = line.slice(
      previous ? previous.index + previous[0].length : 0,
      match.index
    );
    // A relation may also follow the number in brackets: "+7... (brother)".
    // Only the brackets count: the rest of the line after a number is about
    // whatever comes next on it.
    const after = line.slice(match.index + match[0].length, next?.index);
    const bracketed = /^\s*\(([^)]*)\)/.exec(after)?.[1] ?? '';
    const number = match[0].replace(/[\s()-]/g, '');
    const theirs =
      inContact ||
      CONTACT_WORDS.test(before) ||
      CONTACT_WORDS.test(bracketed) ||
      found.phone;
    if (theirs) {
      found.emergencyPhone ??= number;
      const relation = relationshipIn(before) ?? relationshipIn(bracketed);
      if (relation) {
        found.emergencyRelationship ??= relation;
      }
    } else {
      found.phone = number;
    }
  });
  return line.replace(pattern, ' ');
}

/**
 * Reads a message line by line, keeping track of whether the lines belong
 * to the applicant or to the contact person.
 *
 * A heading such as "Контакт:" or "Сестра:" opens the contact's block, which
 * runs to the next blank line; a name, an address or a phone inside it is
 * theirs. A label on the line itself ("Контактный адрес:", "телефон сестры")
 * decides on its own. A line about the flight or the entry gives the entry
 * date. Everything else is the applicant's.
 */
function parseLines(text, found, email) {
  let inContact = false;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) {
      inContact = false;
      continue;
    }
    const opened = openContactBlock(line, found);
    if (opened !== null) {
      inContact = true;
      line = opened;
    }
    parseLabelled(line, found);
    const entry = ENTRY_WORDS.test(line) ? dateInLine(line) : null;
    if (entry) {
      found.entryDate ??= entry;
    }
    noteBorderGate(line, found);
    line = parsePhones(line, found, inContact);
    line = line
      .replace(email ?? /$^/, ' ')
      .replace(/[\s,;-]+$/, '')
      .trim();
    if (looksLikeAddress(line)) {
      const field = addressFieldFor(line, inContact);
      found[field] ??= stripAddressNote(stripAddressLabel(line));
    } else if (line && inContact && looksLikeName(line)) {
      found.emergencyName ??= line;
    }
  }
}

/** Takes the values written with a label out of a line. */
function parseLabelled(line, found) {
  for (const [pattern, field] of LABELLED) {
    const match = line.match(pattern);
    if (match) {
      found[field] ??= match[1].trim();
    }
  }
}

/** Which address field an address line is for, by its label or its block. */
function addressFieldFor(line, inContact) {
  const label = line.includes(':') ? line.slice(0, line.indexOf(':')) : '';
  if (inContact || /экстрен|emergency|контакт(?:ное)?\s+лицо/i.test(label)) {
    return 'emergencyAddress';
  }
  return /контакт|contact/i.test(label) ? 'contactAddress' : 'permanentAddress';
}

/**
 * Holds one chat's collected values in memory.
 *
 * Nothing here is written to disk. A chat's entry lives until /reset, or
 * until the chat has been quiet for the chat lifetime and its browser is
 * closed, so an applicant can add to a form for as long as they are at it.
 */
export function createSessionStore() {
  const sessions = new Map();
  return {
    get(chatId) {
      if (!sessions.has(chatId)) {
        sessions.set(chatId, {
          data: {},
          uploads: {},
          // What has been put on the page and told to the applicant, so
          // neither is repeated on the next fill.
          uploaded: {},
          reported: {},
          language: 'en',
          lastActivity: Date.now(),
        });
      }
      return sessions.get(chatId);
    },
    /** Every chat id with a session, for sweeps. */
    ids() {
      return [...sessions.keys()];
    },
    clear(chatId) {
      sessions.delete(chatId);
    },
    get size() {
      return sessions.size;
    },
  };
}

/**
 * Writes a downloaded document to a temporary file.
 *
 * With debugging on, the file is left in place: a bad crop or a bad read can
 * only be diagnosed against the image that produced it. That means received
 * documents accumulate under the system temp directory until they are cleared,
 * so `keep` is what the operator turns off to have them removed after reading.
 *
 * Telegram serves files over HTTPS and the OCR helpers need a path, so the
 * document touches disk either way.
 */
export async function withTempFile(
  buffer,
  extension,
  use,
  { keep = false } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-bot-'));
  const file = path.join(dir, `document${extension}`);
  fs.writeFileSync(file, buffer);
  try {
    return await use(file, dir);
  } finally {
    if (!keep) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
