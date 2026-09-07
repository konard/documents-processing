import { describe, it, expect } from 'test-anywhere';
import {
  latinAddress,
  looksLikeAddress,
  stripAddressLabel,
} from '../src/evisa-home-address.mjs';
import { transliterate } from '../src/translit.mjs';
import { parseFreeText } from '../src/evisa-bot.mjs';
import { normalizeApplicant } from '../src/evisa-data.mjs';

// A made-up address in the shape a Russian one takes: country, city, postal
// code, street, house, building, flat, each with its marker.
const MOSCOW =
  'Россия, г. Москва, 115551, [REDACTED] шоссе, д. 94, корп. 3, кв. 389';

describe('rendering a home address in Latin letters', () => {
  it('translates the markers and names the country and city in English', () => {
    expect(latinAddress(MOSCOW)).toBe(
      'Russia, Moscow, 115551, [REDACTED] shosse, 94, bld. 3, apt. 389'
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

  it('reaches the form in Latin letters', () => {
    const applicant = normalizeApplicant({ permanentAddress: MOSCOW });
    expect(applicant.permanentAddress).toBe(
      'Russia, Moscow, 115551, [REDACTED] shosse, 94, bld. 3, apt. 389'
    );
  });
});
