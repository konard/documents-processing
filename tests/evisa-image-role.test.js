import { describe, it, expect } from 'test-anywhere';
import { decideRole } from '../src/evisa-image-role.mjs';

describe('deciding what a picture is', () => {
  it('calls a page with a readable zone the passport', () => {
    const seen = decideRole({ hasZone: true, faces: [], lines: [] });
    expect(seen.role).toBe('passportPage');
  });

  it('calls a face filling the frame the portrait', () => {
    const seen = decideRole({ faces: [{ area: 0.21 }], lines: [] });
    expect(seen.role).toBe('portrait');
  });

  it('calls a booking screenshot a booking, not a portrait', () => {
    // This is the picture that went into the portrait upload and had the
    // site answer "no face detected".
    const seen = decideRole({
      faces: [],
      lines: ['Apartments for rent', 'Заезд', '19 сент.', '1 номер'],
    });
    expect(seen.role).toBe('booking');
  });

  it('calls a small face on a page of print a data page', () => {
    const seen = decideRole({
      faces: [{ area: 0.02 }],
      lines: Array.from({ length: 30 }, (_, at) => `line ${at}`),
    });
    expect(seen.role).toBe('passportPage');
  });

  it('admits when it cannot tell', () => {
    const seen = decideRole({ faces: [], lines: ['a receipt for coffee'] });
    expect(seen.role).toBe('unknown');
  });

  it('says why, so the chat can explain itself', () => {
    expect(decideRole({ faces: [{ area: 0.3 }], lines: [] }).why).toContain(
      '30%'
    );
  });
});
