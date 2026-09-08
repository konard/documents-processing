import { describe, it, expect } from 'test-anywhere';
import {
  latinAddress,
  latinPlaceOfBirth,
  looksLikeAddress,
  stripAddressLabel,
  stripAddressNote,
  addressParts,
  mapQuery,
  mapStreet,
  sameStreet,
} from '../src/evisa-home-address.mjs';
import {
  lookupAddress,
  renderVerifiedAddress,
  sameAddress,
} from '../src/evisa-geocode.mjs';
import { transliterate, toCyrillic, editDistance } from '../src/translit.mjs';
import {
  parseFreeText,
  dateInLine,
  describeSummary,
  describeOutcome,
  isConfirmation,
  isCancellation,
  IDLE_FILL_MS,
  SEND_COUNTDOWN_MS,
  describeStep,
  looksLikeCaptcha,
  NOT_ASKED,
} from '../src/evisa-bot.mjs';
import { normalizeApplicant, toFormDate } from '../src/evisa-data.mjs';

// A made-up address in the shape a Russian one takes: country, city, postal
// code, street, house, building, flat, each with its marker.
const MOSCOW = 'Россия, г. Москва, 101000, ул. Пушкина, д. 10, корп. 2, кв. 5';

// The same address as people actually type it: markers without commas, a
// remark after a dash that is not part of it.
const TYPED =
  'Россия, 101000, г. Москва ул. Пушкина, д. 10 корп. 2 кв. 5 - адрес для всех';

/** A date the way a Russian speaker types it: "16 сентября 2026". */
function inRussian(date) {
  const months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

describe('rendering a home address in Latin letters', () => {
  it('translates the markers and names the country and city in English', () => {
    expect(latinAddress(MOSCOW)).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
  });

  it('keeps a street type, since it is part of the name', () => {
    expect(latinAddress('ул. Ленина, д. 5, кв. 12')).toBe(
      'ul. Lenina, 5, apt. 12'
    );
    expect(latinAddress('Санкт-Петербург, Невский пр., 28')).toBe(
      'Saint Petersburg, Nevskii prospekt, 28'
    );
  });

  it('names a region and a district', () => {
    expect(latinAddress('Московская обл., Одинцовский р-н, п. Лесной')).toBe(
      'Moskovskaia oblast, Odintsovskii district, Lesnoi'
    );
  });

  it('does not take a word that merely starts like a marker for one', () => {
    // "Гагарина" is not "г. агарина", and "Облонская" is not a region.
    expect(latinAddress('Гагарина 5, Облонская ул., 3')).toBe(
      'Gagarina, 5, Oblonskaia ul., 3'
    );
  });

  it('keeps an address already in Latin letters, in one way of writing', () => {
    expect(latinAddress('12 Baker Street, London, UK')).toBe(
      '12 Baker Street, London, United Kingdom'
    );
    expect(
      latinAddress('RUSSIAN FEDERATION, GOGOLEVSKII BULVAR 3A, APARTMENT 16')
    ).toBe('Russian Federation, Gogolevskii bulvar, 3A, apt. 16');
    expect(latinAddress('russia, rostov-on-don, ul. mira 5, apt. 7')).toBe(
      'Russian Federation, Rostov-on-Don, ul. Mira, 5, apt. 7'
    );
  });

  it('drops the label people write in front', () => {
    expect(stripAddressLabel('Адрес регистрации: г. Тула')).toBe('г. Тула');
    expect(stripAddressLabel('Permanent address - 1 Main St')).toBe(
      '1 Main St'
    );
    expect(latinAddress('Адрес: г. Тула, ул. Мира, 1')).toBe(
      'Tula, ul. Mira, 1'
    );
  });

  it('drops a remark after the address and splits units written without commas', () => {
    expect(stripAddressNote('ул. Мира, 1 - адрес для всех')).toBe(
      'ул. Мира, 1'
    );
    expect(stripAddressNote('ул. Мира, 1 (прописка)')).toBe('ул. Мира, 1');
    expect(latinAddress(TYPED)).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
  });

  it('keeps one street type when a name carries its own', () => {
    expect(latinAddress('ул. Гоголевский б-р, д. 3')).toBe(
      'Gogolevskii bulvar, 3'
    );
  });

  it('takes an address apart and asks the map for it in Cyrillic', () => {
    const parts = addressParts(TYPED);
    expect(parts.country).toBe('Russian Federation');
    expect(parts.postalCode).toBe('101000');
    expect(parts.city).toBe('Moscow');
    expect(parts.house).toBe('10');
    expect(parts.building).toBe('2');
    expect(parts.flat).toBe('5');
    expect(mapQuery(parts)).toBe(
      'Россия, 101000, Москва, улица Пушкина, 10 к2'
    );
    // Typed in Latin letters, the same house is asked for in Cyrillic, near
    // enough for the map to find it.
    const latin = addressParts(
      'Russian Federation, Moscow, Pushkina street 10, apt. 5'
    );
    expect(mapQuery(latin)).toBe('Россия, Москва, Пушкина улица, 10');
    expect(sameStreet(mapStreet(latin), 'улица Пушкина')).toBe(true);
    // A street on its own unit, its type word telling it from a city.
    const rendered = addressParts(
      'Russian Federation, Gogolevskii bulvar, 3A, apt. 16'
    );
    expect(rendered.city).toBe('');
    expect(rendered.street).toBe('Gogolevskii bulvar');
    expect(mapQuery(rendered)).toBe('Россия, Гоголевскии бульвар, 3А');
    expect(sameStreet('Гоголевскии бульвар', 'Гоголевский бульвар')).toBe(true);
    expect(sameStreet('Гоголевскии бульвар', 'Верх-Исетский бульвар')).toBe(
      false
    );
    expect(toCyrillic('Gogolevskii')).toBe('Гоголевскии');
  });
});

describe('a place of birth as a passport prints it', () => {
  it('names the city in English and keeps the country as printed', () => {
    expect(latinPlaceOfBirth('Г.МОСКВА/USSR')).toBe('Moscow, USSR');
    expect(latinPlaceOfBirth('г. Химки/RUSSIA')).toBe(
      'Khimki, Russian Federation'
    );
  });

  it('gives a country a single time when both halves name it', () => {
    expect(latinPlaceOfBirth('ИНДИЯ/INDIA')).toBe('India');
  });

  it('forgives one misread letter in a known city', () => {
    expect(latinPlaceOfBirth('МОСКВЕ/USSR')).toBe('Moscow, USSR');
    expect(editDistance('москве', 'москва')).toBe(1);
  });

  it('writes a Latin value the way an address is written', () => {
    expect(latinPlaceOfBirth('INDIA')).toBe('India');
  });

  it('reaches the form rendered whole', () => {
    const applicant = normalizeApplicant({ placeOfBirth: 'Г.МОСКВА/USSR' });
    expect(applicant.placeOfBirth).toBe('Moscow, USSR');
  });
});

describe('checking an address against the map', () => {
  // A stand-in for the map service, answering as Photon does.
  const answer = (features) => async () => ({
    ok: true,
    json: async () => ({ features }),
  });
  const house = {
    properties: {
      osm_type: 'W',
      osm_id: 1,
      type: 'house',
      housenumber: '10 к2',
      street: 'улица Пушкина',
      city: 'Moscow',
      postcode: '101000',
      country: 'Russia',
      countrycode: 'ru',
    },
  };

  it('confirms the house and renders from the map, keeping the flat', async () => {
    const found = await lookupAddress(TYPED, { fetchImpl: answer([house]) });
    expect(found.houseMatches).toBe(true);
    expect(found.postalCodeMatches).toBe(true);
    expect(renderVerifiedAddress(TYPED, found)).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
  });

  it('finds the same house from the Latin spelling, and knows it is the same', async () => {
    const latin = 'RUSSIAN FEDERATION, PUSHKINA STREET 10, APARTMENT 5';
    const one = await lookupAddress(TYPED, { fetchImpl: answer([house]) });
    const two = await lookupAddress(latin, { fetchImpl: answer([house]) });
    expect(renderVerifiedAddress(latin, two)).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, apt. 5'
    );
    expect(sameAddress(one, two)).toBe(true);
    const otherFlat = await lookupAddress(latin.replace('5', '6'), {
      fetchImpl: answer([house]),
    });
    expect(sameAddress(one, otherFlat)).toBe(false);
  });

  it('does not take a house of the right number on another street', async () => {
    const elsewhere = {
      properties: { ...house.properties, osm_id: 2, street: 'улица Ленина' },
    };
    const found = await lookupAddress(TYPED, {
      fetchImpl: answer([elsewhere]),
    });
    expect(found.houseMatches).toBe(false);
    expect(renderVerifiedAddress(TYPED, found)).toBe(null);
  });

  it('does not build on a different house or a contradicted postal code', async () => {
    const other = { properties: { ...house.properties, housenumber: '12' } };
    const found = await lookupAddress(TYPED, { fetchImpl: answer([other]) });
    expect(found.houseMatches).toBe(false);
    expect(renderVerifiedAddress(TYPED, found)).toBe(null);

    const elsewhere = {
      properties: { ...house.properties, postcode: '101999' },
    };
    const wrong = await lookupAddress(TYPED, {
      fetchImpl: answer([elsewhere]),
    });
    expect(wrong.postalCodeMatches).toBe(false);
    expect(renderVerifiedAddress(TYPED, wrong)).toBe(null);
  });

  it('gives nothing when the service cannot be reached', async () => {
    const failing = async () => {
      throw new Error('network down');
    };
    expect(await lookupAddress(TYPED, { fetchImpl: failing })).toBe(null);
  });
});

describe('telling an address from other text', () => {
  it('recognizes one by its markers and postal code', () => {
    expect(looksLikeAddress(MOSCOW)).toBe(true);
    expect(looksLikeAddress('ул. Ленина, д. 5')).toBe(true);
    expect(looksLikeAddress('12 Baker Street, London, UK')).toBe(true);
  });

  it('does not take a name, a phone or a sentence for one', () => {
    expect(looksLikeAddress('Иван Петров')).toBe(false);
    expect(looksLikeAddress('телефон +7 999 123 45 67')).toBe(false);
    expect(looksLikeAddress('Дмитровское шоссе 10')).toBe(false);
    expect(looksLikeAddress('')).toBe(false);
  });
});

describe('a capital opening a word', () => {
  it('maps to one capital, so a city name reads as a name', () => {
    expect(transliterate('Химки')).toBe('Khimki');
    expect(transliterate('Юрий')).toBe('Iurii');
    expect(transliterate('ХИМКИ')).toBe('KHIMKI');
  });
});

describe('an address in a chat message', () => {
  it('is read as the permanent address, along with the phone', () => {
    const found = parseFreeText(`${MOSCOW}\n+7 999 123-45-67`);
    expect(found.permanentAddress).toBe(MOSCOW);
    expect(found.phone).toBe('+79991234567');
  });

  it('is read off the same line as the phone', () => {
    const found = parseFreeText(`${MOSCOW}, +7 999 123-45-67`);
    expect(found.permanentAddress).toBe(MOSCOW);
  });

  it('goes to the field its label names', () => {
    const found = parseFreeText(
      `Contact address: 12 Baker Street, London, UK\nАдрес: ${MOSCOW}`
    );
    expect(found.contactAddress).toBe('12 Baker Street, London, UK');
    expect(found.permanentAddress).toBe(MOSCOW);
  });

  it('reaches the form in Latin letters, and serves as the contact address', () => {
    const applicant = normalizeApplicant({ permanentAddress: MOSCOW });
    expect(applicant.permanentAddress).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
    expect(applicant.contactAddress).toBe(applicant.permanentAddress);
    expect(applicant.purpose).toBe('Tourist');
    expect(NOT_ASKED).toContain('purpose');
    expect(NOT_ASKED).toContain('contactAddress');
  });

  it('loses the remark written after it', () => {
    expect(parseFreeText(TYPED).permanentAddress).toBe(
      'Россия, 101000, г. Москва ул. Пушкина, д. 10 корп. 2 кв. 5'
    );
  });
});

describe('the contact person in a chat message', () => {
  it('gets the second phone, and the relation named before it', () => {
    const found = parseFreeText(
      '+7 999 111-22-33 - мой (и телефон родственника на всякий случай - сестра - +7 999 444-55-66)'
    );
    expect(found.phone).toBe('+79991112233');
    expect(found.emergencyPhone).toBe('+79994445566');
    expect(found.emergencyRelationship).toBe('Sister');
  });

  it('gets a phone labelled as the contact’s, even on its own', () => {
    expect(parseFreeText('Номер контакта +79994445566')).toEqual({
      emergencyPhone: '+79994445566',
    });
  });

  it('gets the name, address and phone under a "Контакт:" heading', () => {
    const found = parseFreeText(
      `${MOSCOW}, +7 999 111-22-33\n\nКонтакт:\nANNA IVANOVA\nRUSSIAN FEDERATION, PUSHKINA STREET 10, APARTMENT 7\n\nНомер контакта +79994445566`
    );
    expect(found.phone).toBe('+79991112233');
    expect(found.permanentAddress).toBe(MOSCOW);
    expect(found.emergencyName).toBe('ANNA IVANOVA');
    expect(found.emergencyAddress).toBe(
      'RUSSIAN FEDERATION, PUSHKINA STREET 10, APARTMENT 7'
    );
    expect(found.emergencyPhone).toBe('+79994445566');
  });

  it('reads a relation written after the phone, in English', () => {
    const found = parseFreeText(
      'Emergency contact: John Smith\n+44 20 7946 0958 (brother)'
    );
    expect(found.emergencyName).toBe('John Smith');
    expect(found.emergencyPhone).toBe('+442079460958');
    expect(found.emergencyRelationship).toBe('Brother');
  });

  it('reads a date written in words or in digits', () => {
    expect(dateInLine('Дата билетов на самолёт: 16 сентября 2026 года')).toBe(
      '16/09/2026'
    );
    expect(dateInLine('прилёт 5 мая 2027')).toBe('05/05/2027');
    expect(dateInLine('flight on 5 Oct 2026')).toBe('05/10/2026');
    expect(dateInLine('въезд 16.09.2026')).toBe('16/09/2026');
    expect(dateInLine('no date here')).toBe(null);
  });

  it('reads one message with the email, the flight date, both addresses and the sister', () => {
    // The shape of a message sent alongside the passport and the portrait,
    // with made-up names, numbers and addresses.
    const flight = new Date();
    flight.setUTCDate(flight.getUTCDate() + 40);
    const found = parseFreeText(
      [
        'someone@example.com',
        '',
        `Дата билетов на самолёт: ${inRussian(flight)} года`,
        '',
        'Россия, 101000, г. Москва ул. Пушкина, д. 10 корп. 2 кв. 5',
        '+7 999 111-22-33',
        '',
        'Сестра: ',
        'JANE DOE',
        'RUSSIAN FEDERATION, PUSHKINA STREET 10, BUILDING 2, APARTMENT 5',
        '+79994445566',
      ].join('\n')
    );
    expect(found).toEqual({
      email: 'someone@example.com',
      entryDate: toFormDate(flight),
      permanentAddress:
        'Россия, 101000, г. Москва ул. Пушкина, д. 10 корп. 2 кв. 5',
      phone: '+79991112233',
      emergencyRelationship: 'Sister',
      emergencyName: 'JANE DOE',
      emergencyAddress:
        'RUSSIAN FEDERATION, PUSHKINA STREET 10, BUILDING 2, APARTMENT 5',
      emergencyPhone: '+79994445566',
    });
    // On the form, both addresses come out the same way, and the flight date
    // is the entry date.
    const applicant = normalizeApplicant(found);
    expect(applicant.entryDate).toBe(toFormDate(flight));
    expect(applicant.permanentAddress).toBe(
      'Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
    expect(applicant.emergencyAddress).toBe(
      'Russian Federation, Pushkina Street, 10, bld. 2, apt. 5'
    );
    expect(applicant.emergencyName).toBe('JANE DOE');
    expect(applicant.emergencyRelationship).toBe('Sister');
    expect(applicant.purpose).toBe('Tourist');
  });

  it('reads the passport details people type with a label', () => {
    const found = parseFreeText(
      'дата выдачи 17.02.2020, место рождения: Тула, орган: МВД 0001'
    );
    expect(found.passportIssueDate).toBe('17.02.2020');
    expect(found.placeOfBirth).toBe('Тула');
    expect(found.passportIssuingAuthority).toBe('МВД 0001');
  });
});

describe('what the bot says about a form', () => {
  it('is summarised in sections, with what was assumed marked', () => {
    const supplied = { surname: 'DOE', phone: '+79991112233' };
    const applicant = {
      surname: 'DOE',
      phone: '+79991112233',
      purpose: 'Tourist',
      contactAddress: 'Tula, ul. Mira, 1 <flat 2>',
    };
    const summary = describeSummary(applicant, supplied, 'ru');
    expect(summary).toBe(
      [
        'Что я вписал в анкету:',
        '',
        '<b>Заявитель</b>',
        '• фамилия: DOE',
        '',
        '<b>Контакты</b>',
        '• телефон: +79991112233',
        '• контактный адрес (по умолчанию): Tula, ul. Mira, 1 &lt;flat 2&gt;',
        '',
        '<b>Поездка</b>',
        '• цель поездки (по умолчанию): Tourist',
        '',
        'Помеченное «(по умолчанию)» вы не указывали, я подставил сам. Если ' +
          'что-то не так, пришлите нужное значение.',
      ].join('\n')
    );
    // Said once: the next form of the conversation repeats none of it.
    expect(describeSummary(applicant, supplied, 'ru', applicant)).toBe(null);
    const english = describeSummary({ surname: 'DOE' }, supplied, 'en');
    expect(english).toBe(
      'What I put on the form:\n\n<b>Applicant</b>\n• surname: DOE'
    );
  });

  it('names the source of a mirrored value', () => {
    // The applicant gave an address and an entry date; the contact address
    // and the visa's first day follow from those, and the last day is the
    // 90-day maximum.
    const supplied = { permanentAddress: MOSCOW, entryDate: '16/09/2026' };
    const applicant = normalizeApplicant(supplied);
    const summary = describeSummary(applicant, supplied, 'ru');
    expect(summary).toContain(
      '• контактный адрес (как адрес регистрации): Russian Federation, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
    expect(summary).toContain('• дата въезда: 16/09/2026');
    expect(summary).toContain('• виза с (день въезда): 16/09/2026');
    expect(summary).toContain(
      '• виза по (90 дней, максимум для электронной визы): 14/12/2026'
    );
    expect(summary).toContain('• цель поездки (по умолчанию): Tourist');
    expect(summary).toContain('Помеченное «(по умолчанию)»');
    // Nothing assumed: no note about assumptions either.
    const given = { surname: 'DOE' };
    expect(describeSummary(given, given, 'en')).not.toContain('assumed');
  });

  it('reports a fill under the captured page as one message', () => {
    const result = {
      filled: new Array(41).fill('x'),
      agreed: [1, 2, 3, 4, 5, 6, 7],
      corrected: [{ field: 'phone', was: '+7999111223', now: '+79991112233' }],
      failures: [],
    };
    expect(describeOutcome(result, [], 'ru')).toBe(
      [
        'Заполнено полей: 41.',
        'Из них 7 сайт сам распознал с паспорта, и они совпали.',
        '',
        'Исправил то, что сайт распознал иначе:',
        '• телефон: "+7999111223" → "+79991112233"',
        '',
        'Проверьте анкету. Если всё верно, напишите «отправляй», и я нажму «Next»: сайт покажет анкету на проверку. Если нет, пришлите исправление.',
      ].join('\n')
    );
    const missing = [{ name: 'phone' }];
    expect(describeOutcome({ filled: [], failures: [] }, missing, 'en')).toBe(
      [
        'Filled 0 fields.',
        '',
        'Still needed:',
        '• your phone number',
        'Once you send it, I fill the form again and show it.',
      ].join('\n')
    );
  });

  it('names the declarations it ticked, since each is made in their name', () => {
    const result = {
      filled: [],
      failures: [],
      declared: {
        ticked: ['truthful', 'compliance'],
        already: [],
        missing: [],
      },
    };
    expect(describeOutcome(result, [], 'ru')).toContain(
      'Поставил галочки под анкетой: достоверность сведений, соблюдение законов Вьетнама при въезде.'
    );
    const again = {
      ...result,
      declared: { ticked: [], already: ['truthful'] },
    };
    expect(describeOutcome(again, [], 'en')).not.toContain('Ticked');
  });
});

describe('what the bot says after Next, and what it hears', () => {
  it('describes the page after Next: the stage reached, or the page kept', () => {
    expect(
      describeStep({ moved: true, stage: 'review', errors: [] }, 'ru')
    ).toBe(
      'Нажал «Next», сайт принял страницу. Шаг: проверка анкеты. Вот вся страница.'
    );
    expect(
      describeStep(
        {
          moved: false,
          stage: 'form',
          errors: ['Please enter First name', 'Please enter Sex'],
          notices: [],
        },
        'en'
      )
    ).toBe(
      [
        'Pressed Next, but the site kept the page.',
        '2 messages on it. Send the corrections.',
        '',
        '• Please enter First name',
        '• Please enter Sex',
      ].join('\n')
    );
    // A refused captcha comes as a dialog, not a message on a field.
    expect(
      describeStep(
        {
          moved: false,
          stage: 'review',
          errors: [],
          notices: ['Notification Captcha invalid'],
        },
        'ru'
      )
    ).toBe(
      'Нажал «Next», но сайт оставил страницу.\nСайт ответил: «Notification Captcha invalid».'
    );
  });

  it("relays the site's dialog when the application is registered", () => {
    const step = {
      moved: true,
      stage: 'declared',
      errors: [],
      notices: [],
      dialog: {
        lines: [
          'DECLARATION COMPLETED',
          'Electronic document code: E000000XXX00000000000',
          'Date of apply: 08/09/2026',
        ],
        buttons: ['Print', 'Confirm'],
      },
    };
    expect(describeStep(step, 'ru')).toBe(
      [
        'Сайт принял код и зарегистрировал заявление. В его окне написано:',
        'DECLARATION COMPLETED',
        'Electronic document code: E000000XXX00000000000',
        'Date of apply: 08/09/2026',
        '',
        'Запишите код электронного документа: по нему потом проверяют статус. Дальше в окне браузера: нажмите там «Confirm» и пройдите оплату сами. В этом окне я ничего не нажимаю.',
      ].join('\n')
    );
  });

  it('tells a captcha code from a detail', () => {
    expect(looksLikeCaptcha('3A0101')).toBe(true);
    expect(looksLikeCaptcha(' 031368 ')).toBe(true);
    expect(looksLikeCaptcha('да')).toBe(false);
    expect(looksLikeCaptcha('+79991112233')).toBe(false);
    expect(looksLikeCaptcha(MOSCOW)).toBe(false);
  });

  it('knows an aunt, and the other relatives people name', () => {
    const found = parseFreeText(
      `${MOSCOW}, +7 999 111-22-33\n\nТётя:\nJANE DOE\nRUSSIAN FEDERATION, PUSHKINA STREET 10, APARTMENT 7\n+79994445566`
    );
    expect(found.emergencyRelationship).toBe('Aunt');
    expect(found.emergencyName).toBe('JANE DOE');
    expect(found.emergencyPhone).toBe('+79994445566');
    expect(found.phone).toBe('+79991112233');
    expect(found.emergencyAddress).toBe(
      'RUSSIAN FEDERATION, PUSHKINA STREET 10, APARTMENT 7'
    );
    expect(parseFreeText('Aunt:\nJANE DOE\n+79994445566')).toEqual({
      emergencyRelationship: 'Aunt',
      emergencyName: 'JANE DOE',
      emergencyPhone: '+79994445566',
    });
    expect(parseFreeText('тетя +79994445566').emergencyRelationship).toBe(
      'Aunt'
    );
    for (const [word, relation] of [
      ['Дядя', 'Uncle'],
      ['Бабушка', 'Grandmother'],
      ['Grandfather', 'Grandfather'],
      ['Племянница', 'Niece'],
      ['Cousin', 'Cousin'],
      ['Partner', 'Partner'],
      ['Grandmother', 'Grandmother'],
    ]) {
      expect(
        parseFreeText(`${word}:\nJANE DOE\n+79994445566`).emergencyRelationship
      ).toBe(relation);
    }
  });

  it('takes a word of confirmation as the signal to fill now', () => {
    expect(isConfirmation('Подтверждаю')).toBe(true);
    expect(isConfirmation('отправляй!')).toBe(true);
    expect(isConfirmation('Отправь.')).toBe(true);
    expect(isConfirmation('send')).toBe(true);
    expect(isConfirmation('go')).toBe(true);
    expect(isConfirmation('да, адрес: Тула')).toBe(false);
    expect(isConfirmation(MOSCOW)).toBe(false);
  });

  it('takes a word of refusal as the signal not to fill', () => {
    expect(isCancellation('Стой')).toBe(true);
    expect(isCancellation('стоп!')).toBe(true);
    expect(isCancellation('отмена')).toBe(true);
    expect(isCancellation('не отправляй')).toBe(true);
    expect(isCancellation('stop')).toBe(true);
    expect(isCancellation('стой, адрес другой: Тула')).toBe(false);
    expect(isCancellation('отправляй')).toBe(false);
    // The quiet window ends in a fill, with no pause to read a list over
    // first; the one countdown is before Next, the step hard to take back.
    expect(IDLE_FILL_MS).toBe(20_000);
    expect(SEND_COUNTDOWN_MS).toBe(30_000);
  });
});
