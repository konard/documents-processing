import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import { matchWard } from '../src/evisa-vietnam-address.mjs';
import { FIELD_SECTIONS, groupBySection } from '../src/evisa-sections.mjs';

const fill = readFileSync('src/evisa-fill.mjs', 'utf8');

// The wards the live form offers for KHANH HOA, read off the page. Viet Nam
// merged its wards, so LOC THO — which a booking still names — is not among
// them; it ended up in the city's own ward.
const AS_THE_SITE_OFFERS = [
  'KHANH HOA',
  'PHUONG HOA THANG',
  'PHUONG DONG NINH HOA',
  'BA NGOI WARD',
  'BAO AN WARD',
  'BAC CAM RANH WARD',
  'BAC NHA TRANG WARD',
  'CAM LINH WARD',
  'CAM RANH WARD',
  'NAM NHA TRANG WARD',
  'NHA TRANG WARD',
];

describe('a ward the site no longer lists', () => {
  it('is placed in the town´s own ward when the town is known', () => {
    expect(matchWard('LOC THO', AS_THE_SITE_OFFERS, 'NHA TRANG')).toBe(
      'NHA TRANG WARD'
    );
  });

  it('cannot be placed without the town', () => {
    // Which is why the town has to be filled in the same breath as the ward.
    expect(matchWard('LOC THO', AS_THE_SITE_OFFERS, undefined)).toBe(null);
  });

  it('keeps the town with the ward, so the two are filled together', () => {
    // The town is not a field on the form, so it had no part of its own and
    // fell to the end — filled after the ward it was needed for. The ward was
    // then dropped for want of anything to place it against.
    expect(FIELD_SECTIONS.townInVietnam).toBe(FIELD_SECTIONS.wardInVietnam);
    const parts = groupBySection({
      provinceInVietnam: 'KHANH HOA',
      wardInVietnam: 'LOC THO',
      townInVietnam: 'NHA TRANG',
    });
    expect(parts.length).toBe(1);
    expect(Object.keys(parts[0].fields).sort()).toEqual([
      'provinceInVietnam',
      'townInVietnam',
      'wardInVietnam',
    ]);
  });

  it('is reported when it cannot be placed at all', () => {
    // Dropping it left a required field empty and showing an error while the
    // fill said nothing had failed. It is kept, so the attempt fails on it and
    // the applicant is told which ward it was.
    const resolve = fill.slice(fill.indexOf('async function resolveWard'));
    const body = resolve.slice(0, resolve.indexOf('\n}\n'));
    expect(body.includes('wardInVietnam: placed ?? undefined')).toBe(false);
    const unplaced = body.slice(body.indexOf('if (!placed)'));
    expect(unplaced.slice(0, 400).includes('return applicant')).toBe(true);
  });
});
