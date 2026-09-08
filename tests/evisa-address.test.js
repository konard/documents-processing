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
    // The address box asks for the whole address, so it holds the ward and the
    // city too; the dropdowns beside it repeat those two.
    expect(parsed.addressInVietnam).toBe(
      '406/14 Cong Hoa, Tan Binh, Ho Chi Minh'
    );
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it("writes the address the way the site's own example does", () => {
    // The tooltip on the field reads: Daewoo Hotel, 360 Kim Ma, Ba Dinh, Ha Noi
    const parsed = parseVietnamAddress(
      'Daewoo Hotel, 360 Kim Ma, Ba Dinh, Ha Noi',
      { wardOptions: ['PHUONG BA DINH'] }
    );
    expect(parsed.addressInVietnam).toBe(
      'Daewoo Hotel, 360 Kim Ma, Ba Dinh, Ha Noi'
    );
  });

  it('keeps the premises named before the street', () => {
    // A hotel name is the part that actually locates someone, and the site's
    // example leads with one.
    const parsed = parseVietnamAddress('Daewoo Hotel, 360 Kim Ma, Ha Noi');
    expect(parsed.premises).toEqual(['Daewoo Hotel', '360 Kim Ma']);
  });

  it('puts the parts in the order the site asks for, whatever order they came in', () => {
    // A city named in the middle of an address still ends up last.
    const parsed = parseVietnamAddress('Хошимин, Tan Binh, 406/14 Cong Hoa', {
      wardOptions: WARDS,
    });
    expect(parsed.addressInVietnam).toBe(
      '406/14 Cong Hoa, Tan Binh, Ho Chi Minh'
    );
  });

  it('reads back what it wrote, unchanged', () => {
    // A record passes through normalization repeatedly, so a composed address
    // has to survive being parsed again.
    const once = parseVietnamAddress(DEFAULT_ADDRESS, { wardOptions: WARDS });
    const twice = parseVietnamAddress(once.addressInVietnam, {
      wardOptions: WARDS,
    });
    expect(twice.addressInVietnam).toBe(once.addressInVietnam);
    expect(twice.wardInVietnam).toBe(once.wardInVietnam);
    expect(twice.provinceInVietnam).toBe(once.provinceInVietnam);
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
    expect(parsed.addressInVietnam).toBe('1 Le Loi, Ho Chi Minh');
  });

  it('resolves a former district to the ward that replaced it', () => {
    // Vietnam abolished district-level administration in 2025, so an address
    // naming only a district still has to reach a ward.
    const parsed = parseVietnamAddress('1 Le Loi, Tan Binh District, Saigon', {
      wardOptions: WARDS,
    });
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('never guesses at a ward it cannot place', () => {
    // "Ward 13" no longer exists. Selecting a neighbouring ward would put an
    // applicant at an address they never gave.
    const parsed = parseVietnamAddress(
      '12 Le Loi, Ward 13, District 5, Saigon',
      {
        wardOptions: WARDS,
      }
    );
    expect(parsed.wardInVietnam).toBe('');
  });

  it('keeps a part it could not place in the address line', () => {
    // The dropdown has nowhere for "Ward 13", but the address box does, and an
    // officer reading it is better served by the applicant's own wording.
    const parsed = parseVietnamAddress(
      '12 Le Loi, Ward 13, District 5, Saigon',
      {
        wardOptions: WARDS,
      }
    );
    expect(parsed.addressInVietnam).toBe(
      '12 Le Loi, Ward 13, District 5, Ho Chi Minh'
    );
  });

  it('leaves the ward alone when the name matches more than one', () => {
    const parsed = parseVietnamAddress('1 Le Loi, Tan Binh, Saigon', {
      wardOptions: ['PHUONG TAN BINH', 'XA TAN BINH'],
    });
    expect(parsed.wardInVietnam).toBe('');
  });

  it('keeps the house number whole', () => {
    const parsed = parseVietnamAddress('406/14 Cong Hoa, Saigon');
    expect(parsed.premises).toEqual(['406/14 Cong Hoa']);
    expect(parsed.addressInVietnam).toBe('406/14 Cong Hoa, Ho Chi Minh');
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

describe('a name on the applicant record', () => {
  it('gets a space for a hyphen, as the site and the zone want it', () => {
    const out = normalizeApplicant({ givenName: 'JOHN-ALEX', surname: 'DOE' });
    expect(out.givenName).toBe('JOHN ALEX');
    expect(out.surname).toBe('DOE');
  });
});

describe('an address on the applicant record', () => {
  it('is split into the three fields when given as one line', () => {
    const out = normalizeApplicant({
      addressInVietnam:
        '406/14 Cong Hoa, Tan Binh District, Tan Binh, Хошимин, Вьетнам',
    });
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa, Tan Binh, Ho Chi Minh');
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
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa, Ho Chi Minh');
  });

  it('leaves the ward empty when the applicant named another city', () => {
    // A ward belongs to one city, so the default's would place them in Saigon
    // when they said Ha Noi.
    const out = normalizeApplicant({
      addressInVietnam: 'Daewoo Hotel, 360 Kim Ma, Ba Dinh, Ha Noi',
    });
    expect(out.provinceInVietnam).toBe('HA NOI City');
    expect(out.wardInVietnam).toBe('');
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
    expect(out.addressInVietnam).toBe('406/14 Cong Hoa, Tan Binh, Ho Chi Minh');
    expect(out.provinceInVietnam).toBe('HO CHI MINH City');
    expect(out.wardInVietnam).toBe('PHUONG TAN BINH');
  });

  it('offers the default as a whole address that parses to those fields', () => {
    const parsed = parseVietnamAddress(DEFAULT_ADDRESS, {
      wardOptions: WARDS,
    });
    expect(parsed.addressInVietnam).toBe(
      '406/14 Cong Hoa, Tan Binh, Ho Chi Minh'
    );
    expect(parsed.provinceInVietnam).toBe('HO CHI MINH City');
    expect(parsed.wardInVietnam).toBe('PHUONG TAN BINH');
  });
});
