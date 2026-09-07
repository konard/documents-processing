import { describe, it, expect } from 'test-anywhere';
import { parseVietnamAddress, DEFAULT_ADDRESS } from '../src/evisa-address.mjs';
import { normalizeApplicant, preferEnglishHalf } from '../src/evisa-data.mjs';
import { FIELDS } from '../src/evisa-schema.mjs';

// The wards the form offers for Ho Chi Minh City, as read from the live page.
// The real list runs to 167; these are the ones the cases below reach for.
const WARDS = [
  'PHUONG TAN BINH',
  'PHUONG BAY HIEN',
  'PHUONG AN LAC',
  'PHUONG TAN SON NHAT',
  'PHUONG SAI GON',
];

describe('parseVietnamAddress', () => {
  it('splits a pasted address into the three fields the form asks for', () => {
    const parsed = parseVietnamAddress(
      '406/14 Cong Hoa, Tan Binh District, Tan Binh, Хошимин, Вьетнам',
      { wardOptions: WARDS }
    );
    expect(parsed.addressInVietnam).toBe('406/14 Cong Hoa');
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('reads a city written in Russian', () => {
    // A booking confirmation often arrives in the applicant's own language.
    const parsed = parseVietnamAddress('1 Le Loi, Хошимин', {
      wardOptions: WARDS,
    });
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
  });

  it('reads a city written in Vietnamese, with its diacritics', () => {
    const parsed = parseVietnamAddress('1 Le Loi, TP Hồ Chí Minh, Việt Nam', {
      wardOptions: WARDS,
    });
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
  });

  it('matches a ward however the applicant spells it', () => {
    // The form writes `PHUONG TAN BINH`; nobody else does.
    for (const written of [
      'Tan Binh',
      'Tân Bình',
      'Phuong Tan Binh',
      'Ward Tan Binh',
    ]) {
      const parsed = parseVietnamAddress(`1 Le Loi, ${written}, Saigon`, {
        wardOptions: WARDS,
      });
      expect(`${written}:${parsed.wardInVietnam}`).toBe(
        `${written}:PHUONG TAN BINH`
      );
    }
  });

  it('drops the country, which the form has no field for', () => {
    const parsed = parseVietnamAddress('1 Le Loi, Saigon, Vietnam', {
      wardOptions: WARDS,
    });
    expect(parsed.unmatched).toEqual([]);
  });

  it('resolves a former district to the ward that replaced it', () => {
    // Vietnam abolished district-level administration in 2025, so an address
    // naming only a district still has to reach a ward.
    const parsed = parseVietnamAddress('1 Le Loi, Tan Binh District, Saigon', {
      wardOptions: WARDS,
    });
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('reports a part it could not place, never guessing at one', () => {
    // "Ward 13" no longer exists; saying so beats selecting a neighbouring ward
    // and putting an applicant at an address they never gave.
    const parsed = parseVietnamAddress(
      '12 Le Loi, Ward 13, District 5, Saigon',
      {
        wardOptions: WARDS,
      }
    );
    expect(parsed.wardInVietnam).toBe('');
    expect(parsed.unmatched).toEqual(['Ward 13', 'District 5']);
  });

  it('leaves the ward alone when the name matches more than one', () => {
    const parsed = parseVietnamAddress('1 Le Loi, Tan Binh, Saigon', {
      wardOptions: ['PHUONG TAN BINH', 'XA TAN BINH'],
    });
    expect(parsed.wardInVietnam).toBe('');
  });

  it('keeps the house number whole', () => {
    const parsed = parseVietnamAddress('406/14 Cong Hoa, Saigon');
    expect(parsed.addressInVietnam).toBe('406/14 Cong Hoa');
  });

  it('returns empty fields for an empty address', () => {
    const parsed = parseVietnamAddress('');
    expect(parsed.addressInVietnam).toBe('');
    expect(parsed.provinceInVietnam).toBe('');
  });
});

describe('the address fields as the form renders them', () => {
  it('types the street, and selects the province and ward', () => {
    // The street field carries an .ant-select wrapper but offers no options:
    // it is an autocomplete taking free text. Treating it as a dropdown leaves
    // it empty, and the form refuses to submit with a required field blank.
    expect(FIELDS.addressInVietnam.kind).toBe('text');
    expect(FIELDS.provinceInVietnam.kind).toBe('select');
    expect(FIELDS.wardInVietnam.kind).toBe('select');
  });

  it('sets the province before the ward it decides', () => {
    // The ward list depends on the province selected, and fields are filled in
    // the order they are declared.
    const order = Object.keys(FIELDS);
    expect(
      order.indexOf('provinceInVietnam') < order.indexOf('wardInVietnam')
    ).toBe(true);
  });
});

describe('an address on the applicant record', () => {
  it('is split into the three fields when given as one line', () => {
    const out = normalizeApplicant({
      addressInVietnam:
        '406/14 Cong Hoa, Tan Binh District, Tan Binh, Хошимин, Вьетнам',
    });
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa');
    expect(out.provinceInVietnam).toBe('HO CHI MINH City');
    expect(out.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('survives the bilingual split a passport field needs', () => {
    // A house number carries a slash, and an address may carry Cyrillic, which
    // together look exactly like the <Russian>/<English> pair a passport prints.
    expect(preferEnglishHalf('406/14 Cong Hoa, Хошимин')).toBe('406');
    const out = normalizeApplicant({
      addressInVietnam: '406/14 Cong Hoa, Хошимин',
    });
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa');
  });

  it('keeps a province the applicant gave themselves', () => {
    const out = normalizeApplicant({
      addressInVietnam: '1 Le Loi, Saigon',
      provinceInVietnam: 'HA NOI City',
    });
    expect(out.provinceInVietnam).toBe('HA NOI City');
  });

  it('fills all three from the default when the applicant states no address', () => {
    // All three are required, so an applicant who has not booked anywhere still
    // has to put something down.
    const out = normalizeApplicant({});
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa');
    expect(out.provinceInVietnam).toBe('HO CHI MINH City');
    expect(out.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('offers the default as a whole address that parses to those fields', () => {
    const parsed = parseVietnamAddress(DEFAULT_ADDRESS, {
      wardOptions: WARDS,
    });
    expect(parsed.addressInVietnam).toBe('406/14 Cong Hoa');
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });
});
