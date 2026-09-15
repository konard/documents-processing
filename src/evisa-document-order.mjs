// evisa-document-order.mjs
//
// Documents are expensive to read and therefore run together. Their facts,
// however, must reach a chat in the same order as their messages: where two
// documents name the same fact, the later document is the correction.

/**
 * Reserves one ordered commit as soon as a document message arrives.
 *
 * Reading stays concurrent. Only the short mutation at its end waits for
 * earlier messages, so a quick newer document cannot be overwritten when a
 * slower older document finally finishes.
 */
export function reserveDocumentCommit(session) {
  const before = session.documentCommitTail ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  session.documentCommitTail = turn;
  let committed = false;

  return async function commit(work = () => {}) {
    if (committed) {
      return;
    }
    committed = true;
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  };
}
