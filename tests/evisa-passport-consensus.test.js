import { describe, it, expect } from 'test-anywhere';
import {
  fieldsFromLines,
  settle,
  consensusOf,
  CONSENSUS_FIELDS,
} from '../src/evisa-passport-consensus.mjs';

// A page as a general engine returns it, line by line, for a made-up
// passport: number 712345678, born 12 March 1987, expiring 1 January 2032,
// with the check digits that make the zone parse.
const LINE1 = 'P<RUSTRAVELLER<<JOHN<ALEX<<<<<<<<<<<<<<<<<<<';
const LINE2 = '7123456783RUS8703123M3201015<<<<<<<<<<<<<<06';
const PAGE = [
  '71№2345678',
  'РОССИЙСКАЯ ФЕДЕРАЦИЯ',
  'RUSSIAN FEDERATION',
  'Фамилия / Surname',
  'ТРАВЕЛЛЕР /',
  'TRAVELLER',
  'Имя / Given names',
  'ДЖОН-АЛЕКС /',
  'JOHN-ALEX',
  'Гражданство / Nationality',
  'RUSSIAN FEDERATION',
  'Дата рождения / Date of birth',
  '12.03.1987 Г.МОСКВА/USSR',
  'Пол / Sex',
  'M/M',
  'Дата выдачи / Date of issue',
  '01.01.2022',
  '01.01.2032',
  'Орган, выдавший документ / Authority',
  'МВД 0001',
  LINE1,
  LINE2,
];

describe('the fields read off a page', () => {
  it('come from the zone and from the print separately', () => {
    const { zone, print } = fieldsFromLines(PAGE);
    expect(zone.fields.passportNumber).toBe('712345678');
    expect(zone.fields.dateOfBirth).toBe('1987-03-12');
    expect(zone.fields.givenName).toBe('JOHN ALEX');
    expect(zone.valid.passportNumber).toBe(true);
    expect(print.passportNumber).toBe('712345678');
    expect(print.surname).toBe('TRAVELLER');
    // The print carries the hyphen the zone cannot.
    expect(print.givenName).toBe('JOHN-ALEX');
    expect(print.dateOfBirth).toBe('1987-03-12');
    expect(print.passportIssueDate).toBe('2022-01-01');
    expect(print.passportExpiryDate).toBe('2032-01-01');
    expect(print.sex).toBe('Male');
    expect(print.placeOfBirth).toBe('МОСКВА/USSR');
    expect(print.passportIssuingAuthority).toBe('МВД 0001');
  });

  it('forgive the separators and glued digits engines put in dates and numbers', () => {
    const { print } = fieldsFromLines([
      '71N:2345678',
      '1203.1987 ГОРОД МОСКВА/RUSSIA',
      '01/01.2022',
      '01.01-2032',
    ]);
    expect(print.passportNumber).toBe('712345678');
    expect(print.dateOfBirth).toBe('1987-03-12');
    expect(print.passportIssueDate).toBe('2022-01-01');
    expect(print.passportExpiryDate).toBe('2032-01-01');
    expect(print.placeOfBirth).toBe('МОСКВА/RUSSIA');
  });

  it('name the consulate that issued a passport abroad, and a slash read as L', () => {
    const { print } = fieldsFromLines([
      'Место рождения / Place of birth',
      'ИНДИЯ LINDIA',
      'Орган, выдавший документ / Authority',
      'Е/К РОССИИ, ДЕЛИ',
    ]);
    expect(print.placeOfBirth).toBe('ИНДИЯ/INDIA');
    expect(print.passportIssuingAuthority).toBe('Г/К РОССИИ, ДЕЛИ');
  });
});

describe('settling a field by votes', () => {
  const vote = (value, source, weight = 1, field = 'placeOfBirth') => ({
    field,
    value,
    source,
    weight,
  });

  it('takes the value with two votes and a clear lead', () => {
    const outcome = settle([
      vote('МОСКВА/USSR', 'a/print'),
      vote('МОСКВА/USSR', 'b/print'),
      vote('ТУЛА/USSR', 'c/print'),
    ]);
    expect(outcome.status).toBe('agreed');
    expect(outcome.value).toBe('МОСКВА/USSR');
    expect(outcome.votes).toBe(2);
  });

  it('leaves a tie disputed, and a lone reading weak', () => {
    expect(
      settle([vote('МОСКВА/USSR', 'a/print'), vote('ТУЛА/USSR', 'b/print')])
        .status
    ).toBe('disputed');
    expect(settle([vote('МОСКВА/USSR', 'a/print')]).status).toBe('weak');
    expect(settle([]).status).toBe('unread');
  });

  it('counts a reading one misread letter apart as the same, spelled by the majority', () => {
    const outcome = settle([
      vote('ОСКВА/USSR', 'a/print'),
      vote('МОСКВА/USSR', 'b/print'),
      vote('МОСКВА/USSR', 'c/print'),
    ]);
    expect(outcome.status).toBe('agreed');
    expect(outcome.value).toBe('МОСКВА/USSR');
    expect(outcome.votes).toBe(3);
  });

  it('joins a hyphenated name with its zone reading and keeps the hyphen', () => {
    const outcome = settle([
      vote('JOHN ALEX', 'a/zone', 1, 'givenName'),
      vote('JOHN ALEX', 'b/zone', 1, 'givenName'),
      vote('JOHN-ALEX', 'a/print', 1, 'givenName'),
    ]);
    expect(outcome.status).toBe('agreed');
    expect(outcome.value).toBe('JOHN-ALEX');
    expect(outcome.votes).toBe(3);
  });
});

describe('the consensus over several readings', () => {
  it('settles every field when the readings agree, doubling a checked zone value', () => {
    const one = { source: 'a/original', ...fieldsFromLines(PAGE) };
    const two = { source: 'b/original', ...fieldsFromLines(PAGE) };
    const result = consensusOf([one, two]);
    expect(result.complete).toBe(true);
    expect(result.disputed).toEqual([]);
    expect(result.unverified).toEqual([]);
    expect(result.data.givenName).toBe('JOHN-ALEX');
    expect(result.data.passportIssuingAuthority).toBe('МВД 0001');
    // Two zone readings at double weight and two print readings.
    expect(result.agreement.passportNumber.votes).toBe(6);
    expect(Object.keys(result.data).sort()).toEqual(
      [...CONSENSUS_FIELDS].sort()
    );
  });

  it('leaves a field the readings split on for a person to settle', () => {
    const one = { source: 'a/original', ...fieldsFromLines(PAGE) };
    const other = fieldsFromLines(PAGE);
    other.print.passportIssuingAuthority = 'МВД 0078';
    const two = { source: 'b/original', ...other, zone: null };
    const result = consensusOf([one, two]);
    expect(result.complete).toBe(false);
    expect(result.disputed.map((d) => d.field)).toEqual([
      'passportIssuingAuthority',
    ]);
    expect(result.data.passportIssuingAuthority).toBe(undefined);
  });
});
