import { describe, it, expect } from 'test-anywhere';
import { meaningOf, STATUSES, SEARCH_URL } from '../src/evisa-download.mjs';

describe('what the site says about an application', () => {
  it('searches on the page that actually holds the form', () => {
    expect(SEARCH_URL).toBe('https://evisa.gov.vn/e-visa/search');
  });

  it('reads the wordings the site uses', () => {
    expect(meaningOf('Processing')).toBe('waiting');
    expect(meaningOf('Approved')).toBe('granted');
    expect(meaningOf('Rejected')).toBe('refused');
  });

  it('ignores the case and the space around it', () => {
    expect(meaningOf('  PROCESSING  ')).toBe('waiting');
    expect(meaningOf('approved')).toBe('granted');
  });

  it('reads a wording that carries more than the status', () => {
    expect(meaningOf('Application status: Processing')).toBe('waiting');
  });

  it('admits when it does not recognise a wording', () => {
    // A status the site invents later must not be reported as anything
    // definite, least of all as granted.
    expect(meaningOf('Under further review')).toBe('unknown');
    expect(meaningOf('')).toBe('unknown');
    expect(meaningOf(null)).toBe('unknown');
    expect(meaningOf(undefined)).toBe('unknown');
  });

  it('maps every wording it knows to a meaning a person understands', () => {
    for (const meaning of Object.values(STATUSES)) {
      expect(
        ['waiting', 'unpaid', 'granted', 'refused'].includes(meaning)
      ).toBe(true);
    }
  });
});
