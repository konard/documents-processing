import { describe, it, expect } from 'test-anywhere';
import {
  decideRole,
  findFaces,
  sortUnreadableImage,
} from '../src/evisa-image-role.mjs';

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

  it('never calls an image a portrait when classification itself failed', async () => {
    const replies = [];
    const issues = [];
    let keptPortrait = false;
    const session = { data: {}, uploads: {} };

    await sortUnreadableImage({
      ctx: { reply: async (said) => replies.push(said) },
      chatId: 1,
      session,
      read: null,
      local: '/not/read/by/the/test.jpg',
      extension: '.jpg',
      log: () => {},
      shown: String,
      keepPortrait: () => {
        keptPortrait = true;
      },
      keepForUpload: () => '/tmp/passport.jpg',
      strings: {},
      classify: async () => {
        throw new Error('classifier unavailable');
      },
      noteIssue: (issue) => issues.push(issue),
    });

    expect(keptPortrait).toBe(false);
    expect(issues).toEqual(['unknownImage']);
    expect(replies).toEqual([]);
  });

  it('falls back when macOS Vision cannot start its face model', async () => {
    const called = [];
    const faces = await findFaces('/portrait.jpg', {
      run: async (engine) => {
        called.push(engine);
        return engine === 'vision-faces.py'
          ? { error: 'could not create network' }
          : { faces: [{ area: 0.2 }] };
      },
    });
    expect(called).toEqual(['vision-faces.py', 'opencv-faces.py']);
    expect(faces).toEqual([{ area: 0.2 }]);
  });

  it('trusts a successful no-face result without inventing one', async () => {
    const called = [];
    const faces = await findFaces('/not-a-portrait.jpg', {
      run: async (engine) => {
        called.push(engine);
        return { faces: [] };
      },
    });
    expect(called).toEqual(['vision-faces.py']);
    expect(faces).toEqual([]);
  });
});
