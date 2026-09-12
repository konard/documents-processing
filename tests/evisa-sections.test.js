import { describe, it, expect } from 'test-anywhere';
import {
  groupBySection,
  sectionNumber,
  SECTION_ORDER,
  FIELD_SECTIONS,
} from '../src/evisa-sections.mjs';

describe('the form as its own parts', () => {
  it('names the parts in the order the site prints them', () => {
    expect(SECTION_ORDER[1]).toBe('1. PERSONAL INFORMATION');
    expect(SECTION_ORDER[6]).toBe('6. INFORMATION ABOUT THE TRIP');
  });

  it('reads the number a heading opens with', () => {
    expect(sectionNumber('3. PASSPORT INFORMATION')).toBe(3);
    expect(sectionNumber("FOREIGNER'S IMAGES")).toBe(null);
  });

  it('puts each value in the part it belongs to', () => {
    // Read off the live form: the name is personal, the passport is its own
    // part, and the trip is the part after the occupation.
    expect(FIELD_SECTIONS.surname).toBe(1);
    expect(FIELD_SECTIONS.passportNumber).toBe(3);
    expect(FIELD_SECTIONS.entryDate).toBe(6);
  });

  it('groups values into parts, in printed order', () => {
    const parts = groupBySection({
      entryDate: '16/09/2026',
      surname: 'TRAVELLER',
      passportNumber: '712345678',
    });
    expect(parts.map((part) => part.at)).toEqual([1, 3, 6]);
    expect(parts[0].fields).toEqual({ surname: 'TRAVELLER' });
    expect(parts[0].title).toBe('1. PERSONAL INFORMATION');
  });

  it('prefers what the page says over the fallback', () => {
    // A form that has been rearranged is filled in its own order.
    const values = { phone: '+10000000001' };
    const parts = groupBySection(values, { phone: '2. REQUESTED INFORMATION' });
    // The fallback puts a telephone number in part four; the page says two.
    expect(FIELD_SECTIONS.phone).toBe(4);
    expect(parts[0].at).toBe(2);
  });

  it('leaves a value it cannot place until last', () => {
    const parts = groupBySection({ surname: 'TRAVELLER', invented: 'x' });
    expect(parts[parts.length - 1].fields).toEqual({ invented: 'x' });
  });

  it('gives nothing for nothing', () => {
    expect(groupBySection({})).toEqual([]);
  });
});
