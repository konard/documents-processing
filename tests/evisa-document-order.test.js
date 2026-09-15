import { describe, it, expect } from 'test-anywhere';
import { reserveDocumentCommit } from '../src/evisa-document-order.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('documents finishing out of order', () => {
  it('applies their readings in message-arrival order', async () => {
    const session = { data: {} };
    const firstMayFinish = deferred();
    const firstCommit = reserveDocumentCommit(session);
    const secondCommit = reserveDocumentCommit(session);

    const first = (async () => {
      await firstMayFinish.promise;
      await firstCommit(() => {
        session.data.passportNumber = 'OLDER';
      });
    })();
    const second = secondCommit(() => {
      session.data.passportNumber = 'NEWER';
    });

    await Promise.resolve();
    expect(session.data.passportNumber).toBe(undefined);
    firstMayFinish.resolve();
    await Promise.all([first, second]);
    expect(session.data.passportNumber).toBe('NEWER');
  });

  it('releases the following document even when a reading has nothing to apply', async () => {
    const session = { data: {} };
    const firstCommit = reserveDocumentCommit(session);
    const secondCommit = reserveDocumentCommit(session);
    await firstCommit();
    await secondCommit(() => {
      session.data.arrivalDate = '17/09/2026';
    });
    expect(session.data.arrivalDate).toBe('17/09/2026');
  });
});
