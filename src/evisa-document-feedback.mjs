// evisa-document-feedback.mjs
//
// Problems found while a forwarded batch is being read.
//
// A batch can contain four or five Telegram messages, but it has one answer:
// the filled form. File-level advice accumulates here and accompanies that
// answer as one compact, deduplicated account.

/** Records one occurrence without putting words in the chat yet. */
export function noteDocumentIssue(session, issue) {
  session.documentIssues ??= {};
  session.documentIssues[issue] = (session.documentIssues[issue] ?? 0) + 1;
}

/** The compact, localised account that accompanies the batch result. */
export function describeDocumentIssues(session, strings) {
  const issues = session?.documentIssues ?? session ?? {};
  const lines = Object.entries(issues)
    .filter(([, count]) => count > 0)
    .map(([issue, count]) => strings.documentIssues?.[issue]?.(count))
    .filter(Boolean);
  return lines.length
    ? [`<b>${strings.documentIssuesHeading}</b>`, ...lines].join('\n')
    : '';
}

/** Clears feedback after—and only after—the consolidated answer was sent. */
export function clearDocumentIssues(session) {
  delete session.documentIssues;
}

/**
 * Detaches the warnings already placed in an outgoing answer.
 *
 * A later attachment can finish while Telegram is still accepting that
 * answer. Giving it a fresh collection means a successful send retires only
 * what it actually said, never the warning that arrived in the meantime.
 */
export function takeDocumentIssues(session) {
  const taken = session.documentIssues ?? {};
  delete session.documentIssues;
  return taken;
}

/** Puts an undelivered snapshot back beside anything learned meanwhile. */
export function restoreDocumentIssues(session, unsent = {}) {
  for (const [issue, count] of Object.entries(unsent)) {
    if (count > 0) {
      session.documentIssues ??= {};
      session.documentIssues[issue] =
        (session.documentIssues[issue] ?? 0) + count;
    }
  }
}
