#!/usr/bin/env node
// evisa-bot.mjs
//
// A Telegram bot that collects what a Vietnam e-visa application needs, in
// Russian or English, and shows the applicant the filled form.
//
// Nothing is stored. The conversation in Telegram is the only record: on each
// message the bot re-reads the chat history it has been given, works out what is
// still missing, and asks for that. Documents are read in memory and discarded.
//
// Which fields are required is read from the live form, so a change on the
// government side surfaces as a question to the applicant.
//
// Usage:
//   EVISA_BOT_TOKEN=... node src/evisa-bot.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** How long a chat may go quiet before the bot fills the form on its own. */
export const IDLE_FILL_MS = 45_000;

/** Phrases the bot uses, in the two languages it speaks. */
export const MESSAGES = {
  en: {
    welcome:
      'Hello. I can prepare your Vietnam e-visa application.\n\n' +
      'Send me your documents — a passport photo, a portrait, an old visa, a ' +
      'flight ticket, a hotel or apartment booking. Photos, PDFs and forwarded ' +
      'messages all work. You can also just type the details.\n\n' +
      'I keep nothing: this chat is the only record.',
    checklistTitle: 'Here is everything the application needs:',
    checklistDocuments: 'Documents to send',
    checklistDetails: 'Details to tell me',
    checklistFooter:
      'Send what you have, in any order. I will read what I can from the ' +
      'documents and ask only for what is left.',
    needed: 'Still needed:',
    reading: 'Reading your document...',
    filling:
      'Nothing new for a moment, so I am filling the form with what I have.',
    filled: (n) => `Filled ${n} fields. Here is the whole page:`,
    failed: (field, why) => `Could not fill ${field}: ${why}`,
    ready:
      'The form is filled but NOT submitted. Check every field, then submit it ' +
      'yourself in the browser.',
    unreadable:
      'I could not read that. Please send a sharper photo of the whole page.',
    languageSet: 'Now speaking English.',
  },
  ru: {
    welcome:
      'Здравствуйте. Я помогу подготовить заявление на электронную визу во Вьетнам.\n\n' +
      'Пришлите документы — страницу паспорта, фотографию, старую визу, ' +
      'авиабилет, бронирование отеля или квартиры. Подойдут фото, PDF и ' +
      'пересланные сообщения. Можно и просто написать данные текстом.\n\n' +
      'Я ничего не сохраняю: единственная запись — эта переписка.',
    checklistTitle: 'Вот всё, что нужно для заявления:',
    checklistDocuments: 'Документы',
    checklistDetails: 'Данные',
    checklistFooter:
      'Присылайте в любом порядке. Что смогу — прочитаю из документов, ' +
      'остальное спрошу.',
    needed: 'Ещё нужно:',
    reading: 'Читаю документ...',
    filling: 'Пауза в сообщениях, заполняю форму тем, что уже есть.',
    filled: (n) => `Заполнено полей: ${n}. Вот вся страница:`,
    failed: (field, why) => `Не удалось заполнить ${field}: ${why}`,
    ready:
      'Форма заполнена, но НЕ отправлена. Проверьте каждое поле и отправьте ' +
      'сами в браузере.',
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
 * The full checklist shown at /start, so nothing comes as a surprise later.
 *
 * Documents are listed separately from details, because one document usually
 * answers several details at once and it helps to see which.
 */
export function describeChecklist(fields, language) {
  const strings = MESSAGES[language] ?? MESSAGES.en;
  const prompts = FIELD_PROMPTS[language] ?? FIELD_PROMPTS.en;
  const isDocument = (name) =>
    name === 'portraitPhoto' || name === 'passportPage';

  const documents = fields
    .filter((field) => isDocument(field.name))
    .map((field) => `• ${prompts[field.name] ?? field.name}`);
  const details = fields
    .filter((field) => !isDocument(field.name))
    .map((field) => `• ${prompts[field.name] ?? field.label ?? field.name}`);

  const parts = [strings.checklistTitle];
  if (documents.length) {
    parts.push(`\n${strings.checklistDocuments}:\n${documents.join('\n')}`);
  }
  if (details.length) {
    parts.push(`\n${strings.checklistDetails}:\n${details.join('\n')}`);
  }
  parts.push(`\n${strings.checklistFooter}`);
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

  const phone = text.match(/\+\d[\d\s()-]{7,}\d/);
  if (phone) {
    found.phone = phone[0].replace(/[\s()-]/g, '');
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

  return found;
}

/**
 * Holds one chat's collected values for the life of the process.
 *
 * Nothing is written to disk, and a chat's entry is dropped as soon as its form
 * has been shown, so the conversation in Telegram stays the only record.
 */
export function createSessionStore() {
  const sessions = new Map();
  return {
    get(chatId) {
      if (!sessions.has(chatId)) {
        sessions.set(chatId, { data: {}, uploads: {}, language: 'en' });
      }
      return sessions.get(chatId);
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
 * The caller deletes it once read. Telegram serves files over HTTPS and the OCR
 * helpers need a path, so it touches disk briefly and only there.
 */
export async function withTempFile(buffer, extension, use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evisa-bot-'));
  const file = path.join(dir, `document${extension}`);
  fs.writeFileSync(file, buffer);
  try {
    return await use(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
