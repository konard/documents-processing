import { describe, it, expect } from 'test-anywhere';
import {
  latinAddress,
  latinPlaceOfBirth,
  looksLikeAddress,
  stripAddressLabel,
  stripAddressNote,
  addressParts,
} from '../src/evisa-home-address.mjs';
import { lookupAddress, renderVerifiedAddress } from '../src/evisa-geocode.mjs';
import { transliterate, editDistance } from '../src/translit.mjs';
import { parseFreeText, NOT_ASKED } from '../src/evisa-bot.mjs';
import { normalizeApplicant } from '../src/evisa-data.mjs';

// A made-up address in the shape a Russian one takes: country, city, postal
// code, street, house, building, flat, each with its marker.
const MOSCOW = 'Россия, г. Москва, 101000, ул. Пушкина, д. 10, корп. 2, кв. 5';

// The same address as people actually type it: markers without commas, a
// remark after a dash that is not part of it.
const TYPED =
  'Россия, 101000, г. Москва ул. Пушкина, д. 10 корп. 2 кв. 5 - адрес для всех';

describe('rendering a home address in Latin letters', () => {
  it('translates the markers and names the country and city in English', () => {
    expect(latinAddress(MOSCOW)).toBe(
      'Russia, Moscow, 101000, ul. Pushkina, 10, bld. 2, apt. 5'
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
      'Gagarina 5, Oblonskaia ul., 3'
    );
  });

  it('leaves an address already in Latin letters alone', () => {
    expect(latinAddress('12 Baker Street, London, UK')).toBe(
      '12 Baker Street, London, UK'
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
      'Russia, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
  });

  it('keeps one street type when a name carries its own', () => {
    expect(latinAddress('ул. Гоголевский б-р, д. 3')).toBe(
      'Gogolevskii bulvar, 3'
    );
  });

  it('takes an address apart for a map lookup, without the flat', () => {
    const parts = addressParts(TYPED);
    expect(parts.country).toBe('Russia');
    expect(parts.postalCode).toBe('101000');
    expect(parts.city).toBe('Moscow');
    expect(parts.written).toEqual([
      'Россия',
      '101000',
      'г. Москва',
      'ул. Пушкина',
      '10',
      'корп. 2',
    ]);
  });
});

describe('a place of birth as a passport prints it', () => {
  it('names the city in English and keeps the country as printed', () => {
    expect(latinPlaceOfBirth('Г.МОСКВА/USSR')).toBe('Moscow, USSR');
    expect(latinPlaceOfBirth('г. Химки/RUSSIA')).toBe('Khimki, RUSSIA');
  });

  it('gives a country a single time when both halves name it', () => {
    expect(latinPlaceOfBirth('ИНДИЯ/INDIA')).toBe('India');
  });

  it('forgives one misread letter in a known city', () => {
    expect(latinPlaceOfBirth('МОСКВЕ/USSR')).toBe('Moscow, USSR');
    expect(editDistance('москве', 'москва')).toBe(1);
  });

  it('leaves a Latin value alone', () => {
    expect(latinPlaceOfBirth('INDIA')).toBe('INDIA');
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
      'Russia, 101000, Moscow, ul. Pushkina, 10, bld. 2, apt. 5'
    );
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
      'Russia, Moscow, 101000, ul. Pushkina, 10, bld. 2, apt. 5'
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

  it('reads the passport details people type with a label', () => {
    const found = parseFreeText(
      'дата выдачи 17.02.2020, место рождения: Тула, орган: МВД 0001'
    );
    expect(found.passportIssueDate).toBe('17.02.2020');
    expect(found.placeOfBirth).toBe('Тула');
    expect(found.passportIssuingAuthority).toBe('МВД 0001');
  });
});
