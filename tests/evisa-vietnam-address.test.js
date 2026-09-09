import { describe, it, expect } from 'test-anywhere';
import {
  parseVietnamAddress,
  findVietnamAddress,
  provinceOf,
  wardOf,
} from '../src/evisa-vietnam-address.mjs';

describe('the address in Viet Nam, off a booking', () => {
  it('takes a line the booking wrote in two languages', () => {
    // A booking names the street in Vietnamese and the city in the
    // applicant's own language.
    const parsed = parseVietnamAddress(
      '25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам'
    );
    // The whole temporary address, in English, as the site's example gives it.
    expect(parsed.addressInVietnam).toBe(
      '25/7 Tran Phu, Vinh Hai Ward, Nha Trang'
    );
    expect(parsed.provinceInVietnam).toBe('KHANH HOA');
    expect(parsed.wardInVietnam).toBe('VINH HAI');
  });

  it('takes the ward name bare, for matching against the site', () => {
    expect(wardOf('Vinh Hai Ward')).toBe('VINH HAI');
    expect(wardOf('Phuong Tan Binh')).toBe('TAN BINH');
    expect(wardOf('Tran Phu')).toBe(null);
  });

  it('places a merged ward on the city it was absorbed into', async () => {
    const { matchWard } = await import('../src/evisa-vietnam-address.mjs');
    // Viet Nam merged its wards: a booking may still name one the form has
    // dropped, and the city's own ward is where it ended up.
    const offered = ['NHA TRANG WARD', 'BAC NHA TRANG WARD', 'CAM RANH WARD'];
    expect(matchWard('VAN THANH', offered, 'NHA TRANG')).toBe('NHA TRANG WARD');
    // A ward still listed is matched by its own name.
    expect(matchWard('CAM RANH', offered, 'NHA TRANG')).toBe('CAM RANH WARD');
    // Nothing to place it on gives nothing, so no unfillable value is set.
    expect(matchWard('VAN THANH', offered, null)).toBe(null);
  });

  it('knows a city by either language', () => {
    expect(provinceOf('Nha Trang')).toBe('KHANH HOA');
    expect(provinceOf('Нячанг')).toBe('KHANH HOA');
    expect(provinceOf('Ho Chi Minh')).toBe('HO CHI MINH City');
    expect(provinceOf('Somewhere else')).toBe(null);
  });

  it('leaves the country and the city out of the street', () => {
    const parsed = parseVietnamAddress('12 Some Street, Da Nang, Vietnam');
    expect(parsed.addressInVietnam).toBe('12 Some Street, Da Nang');
    expect(parsed.provinceInVietnam).toBe('DA NANG City');
  });

  it('gives nothing for a line that says nothing', () => {
    const parsed = parseVietnamAddress('');
    expect(parsed.addressInVietnam).toBe(null);
    expect(parsed.provinceInVietnam).toBe(null);
  });
});

describe('finding the address on a page of a booking', () => {
  // The lines as an OCR engine reads a booking screenshot.
  const LINES = [
    '18:48',
    'Seaside Apartments for rent',
    '9,0',
    '25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам',
    'Заезд',
    '19 сент., сб',
    '1 номер, 1 взрослый, 0 детей',
  ];

  it('picks the line with the address on it', () => {
    expect(findVietnamAddress(LINES)).toBe(
      '25/7 Tran Phu, Vinh Hai Ward, Нячанг, Вьетнам'
    );
  });

  it('finds nothing on a page with no address', () => {
    expect(findVietnamAddress(['Заезд', '19 сент., сб', '9,0'])).toBe(null);
  });
});
