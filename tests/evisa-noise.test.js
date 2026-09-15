import { describe, it, expect } from 'test-anywhere';
import { isSiteNoise, countNoise } from '../src/evisa-noise.mjs';

describe('telling the site´s own noise from a real fault', () => {
  it('knows the site´s broken policy headers', () => {
    expect(
      isSiteNoise(
        'The source list for the Content Security Policy directive ' +
          "'worker-src' contains an invalid source: 'https://*.*.forter.com'."
      )
    ).toBe(true);
  });

  it('knows the account probe that answers 401 on every page', () => {
    // The e-visa flow is public: there is no account, so the site asking
    // for one and being refused says nothing about the application.
    expect(
      isSiteNoise('https://api.evisa.gov.vn/user-service/user/get-user-info')
    ).toBe(true);
  });

  it('knows the trackers', () => {
    expect(isSiteNoise('https://www.google-analytics.com/g/collect?v=2')).toBe(
      true
    );
    expect(isSiteNoise('https://h.online-metrix.net/fp/tags.js')).toBe(true);
  });

  it('never silences something about the application itself', () => {
    // The whole point of the log is explaining a form that would not fill.
    expect(isSiteNoise('https://evisa.gov.vn/e-visa/foreigners')).toBe(false);
    expect(
      isSiteNoise('https://api.evisa.gov.vn/visa-service/application/submit')
    ).toBe(false);
    expect(isSiteNoise('Uncaught TypeError: cannot read properties')).toBe(
      false
    );
    expect(isSiteNoise('')).toBe(false);
    expect(isSiteNoise(undefined)).toBe(false);
  });

  it('counts what it filters, per chat', () => {
    const noise = countNoise();
    expect(noise.filter(7, 'https://www.google-analytics.com/g/collect')).toBe(
      true
    );
    expect(noise.filter(7, 'Content Security Policy directive')).toBe(true);
    expect(noise.filter(7, 'https://evisa.gov.vn/e-visa/foreigners')).toBe(
      false
    );
    expect(noise.countFor(7)).toBe(2);
    expect(noise.countFor(8)).toBe(0);
    noise.forget(7);
    expect(noise.countFor(7)).toBe(0);
  });
});
