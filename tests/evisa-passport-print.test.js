import { describe, it, expect } from 'test-anywhere';
import { cleanConsularAuthority } from '../src/evisa-passport.mjs';

describe('the authority line of a passport issued abroad', () => {
  it('names the consulate general and its city, through misread letters', () => {
    // The pattern behind the print turns "Г/К" into stray letters glued to
    // the next word; the word РОССИИ and the city after it survive.
    expect(cleanConsularAuthority('О ТИКРОССИИ, ДЕЛИ >')).toBe(
      'Г/К РОССИИ, ДЕЛИ'
    );
    expect(cleanConsularAuthority('Г/К РОССИИ, ДЕЛИ')).toBe('Г/К РОССИИ, ДЕЛИ');
  });

  it('names an embassy as one', () => {
    expect(cleanConsularAuthority('ПОСОЛЬСТВО РОССИИ В ДЕЛИ')).toBe(
      'ПОСОЛЬСТВО РОССИИ, ДЕЛИ'
    );
  });

  it('yields nothing for a body with a code, or for noise', () => {
    expect(cleanConsularAuthority('МВД 0001')).toBe(null);
    expect(cleanConsularAuthority('р t')).toBe(null);
    // A consulate with no city named is not a reading.
    expect(cleanConsularAuthority('Г/К РОССИИ')).toBe(null);
  });
});
