import { describe, it, expect } from 'test-anywhere';
import { readFileSync } from 'node:fs';
import {
  matchWard,
  parseVietnamAddress,
} from '../src/evisa-vietnam-address.mjs';
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

describe('a dropdown reads its own list', () => {
  it('scopes the options to the select that was asked', () => {
    // Ant Design keeps one dropdown per select and leaves the last one in the
    // document while it fades. Reading every visible dropdown gave the ward
    // whichever list belonged to the field filled before it.
    const options = fill.slice(
      fill.indexOf('export async function selectOptions')
    );
    const body = options.slice(0, options.indexOf('\n}\n'));
    expect(body.includes('`${id}_list`')).toBe(true);
    expect(body.includes("closest('.ant-select-dropdown')")).toBe(true);
    // And no longer sweeps the whole document for anything visible.
    expect(
      body.includes('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
    ).toBe(false);
  });

  it('refuses a ward list that is really the province list', () => {
    // Filing a province as a ward is worse than filing none: the site takes
    // it, so nothing fails and nobody is told.
    const resolve = fill.slice(fill.indexOf('async function resolveWard'));
    const body = resolve.slice(0, resolve.indexOf('\n}\n'));
    const guard = body.indexOf('same(option, applicant.provinceInVietnam)');
    const match = body.indexOf('matchWard(');
    expect(guard > 0 && guard < match).toBe(true);
  });
});

describe('what the list under the form says', () => {
  it('reports the ward that went on the form, not the one asked for', () => {
    // The site no longer lists Loc Tho, so the fill puts the application in
    // the ward that replaced it. The picture showed NHA TRANG WARD and the
    // list under it said LOC THO, which reads as the bot having ignored the
    // form it had just filled.
    const fill = readFileSync('src/evisa-fill.mjs', 'utf8');
    const form = fill.slice(fill.indexOf('export async function fillForm'));
    const body = form.slice(0, form.indexOf('\n}\n'));
    // The fill reads the form back off the page, so what the applicant is
    // told is the form itself and not what the fill meant to write.
    expect(body.includes('placed: await readFilledFields(page)')).toBe(true);

    const session = readFileSync('src/evisa-session.mjs', 'utf8');
    const bySection = session.slice(
      session.indexOf('export async function fillBySection')
    );
    // And a fill done part by part gathers them across all of its parts.
    expect(
      bySection.includes('Object.assign(result.placed, from.placed ?? {})')
    ).toBe(true);

    const run = readFileSync('src/evisa-bot-run.mjs', 'utf8');
    // And the list is written from them.
    expect(run.includes('{ ...applicant, ...result.placed }')).toBe(true);
  });
});

describe('a booking that names no ward at all', () => {
  it('is still placed, since the town it is in has one', () => {
    // One booking writes "18/4 [REDACTED], Loc Tho Ward, Nha Trang" and
    // another "14 Dinh Tien Hoang 7, Nha Trang". The second names no ward,
    // and the field is one the site will not go on without.
    const parsed = parseVietnamAddress(
      '14 Đinh Tiên Hoàng 7, 650000 Нячанг, Вьетнам'
    );
    expect(parsed.wardInVietnam).toBe(null);
    expect(parsed.townInVietnam).toBe('NHA TRANG');
    // The town alone is enough to name the ward the site offers for it.
    expect(matchWard(null, AS_THE_SITE_OFFERS, parsed.townInVietnam)).toBe(
      'NHA TRANG WARD'
    );
  });

  it('asks the page for the list when only the town is known', () => {
    // The resolving stopped before it ever looked, so the field was left
    // empty on a form that requires it.
    const resolve = fill.slice(fill.indexOf('async function resolveWard'));
    const body = resolve.slice(0, resolve.indexOf('\n}\n'));
    expect(body.includes('!wanted && !applicant.townInVietnam')).toBe(true);
  });
});
