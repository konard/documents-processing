// flight-relevance.mjs — score an email's metadata for how likely it is to be a
// genuine flight cancellation / schedule-change / refund original, so a curated
// export keeps only the mail that can substantiate a cancellation (e.g. for an
// FRRO submission) and drops noise (social mail, promos, mail you sent
// yourself).
//
// Scoring is deliberately transparent: each rule contributes points and a
// reason string, so the decision can be shown to the user and overridden.

// Senders that issue authoritative flight notices (public airline and
// booking-agent domains, plus generic travel-mail cues). Extra domains can be
// added via the FLIGHT_SENDERS env var (comma-separated) without editing code.
const AIRLINE_SENDER_PATTERNS = [
  /airindia\.com$/i,
  /goindigo\.in$/i,
  /indigo\.[a-z.]+$/i,
  /aviakassa\.com$/i,
  /\bamadeus\b/i,
  /\bsabre\b/i,
  /travel|tickets?|booking|reservation|eticket|itinerary/i,
  ...(process.env.FLIGHT_SENDERS || '')
    .split(',')
    .map((domain) => domain.trim())
    .filter(Boolean)
    .map((domain) => new RegExp(`${domain.replace(/\./g, '\\.')}$`, 'i')),
];

// Obvious non-flight senders to reject outright.
const NOISE_SENDER_PATTERNS = [
  /redditmail\.com$/i,
  /reddit\.com$/i,
  /facebook|instagram|twitter|linkedin|x\.com$/i,
  /newsletter|noreply@medium|digest/i,
];

// Subject cues that a message is about a cancellation / change / refund.
const POSITIVE_SUBJECT = [
  /cancel/i,
  /cancell?ed/i,
  /change in itinerary/i,
  /itinerary change/i,
  /schedule change/i,
  /reschedul/i,
  /refund/i,
  /изменени/i, // RU: change
  /отмен/i, // RU: cancellation
  /возврат/i, // RU: refund
  /бронировани/i, // RU: booking (aviakassa change notices)
  /билет/i, // RU: ticket
  /flight.*(chang|cancel)/i,
];

// Subject cues for booking proof (e-tickets / itineraries / confirmations).
// These do not themselves announce a cancellation, but from an airline/agent
// they are the underlying booking a cancellation refers to — worth keeping as
// supporting evidence for an FRRO submission.
const SUPPORTING_SUBJECT = [
  /e-?ticket/i,
  /itinerary/i,
  /booking confirmation/i,
  /confirmation.*booking/i,
  /web booking/i,
  /билет/i, // RU: ticket
  // Airline/agent support correspondence about a specific booking (e.g. a
  // "Re: [Ticket#…] <booking-number>" reply) is relevant to a cancellation.
  /ticket\s*#?\s*\d/i,
  /^re:\s.*\d{6,}/i,
  /\b\d{9,}\b/, // a bare long booking/order reference in the subject
];

// Subject cues that a message is promotional / not an authoritative notice.
const NEGATIVE_SUBJECT = [
  /sale|offer|deal|discount|upgrade your|earn|miles reward/i,
  /survey|feedback|rate your/i,
  /newsletter|unsubscribe/i,
];

function anyMatch(patterns, value) {
  return patterns.some((pattern) => pattern.test(value || ''));
}

// Reason a message should be dropped outright, or null if it survives to
// scoring. Handles mail to self and known non-flight senders.
function rejectReason(from, selfAddresses) {
  const fromLower = from.toLowerCase();
  if (selfAddresses.some((self) => fromLower.includes(self))) {
    return 'from self — dropped';
  }
  if (anyMatch(NOISE_SENDER_PATTERNS, from)) {
    return 'non-flight sender — dropped';
  }
  return null;
}

// Score one message's metadata. Returns { score, relevant, reasons, from,
// subject }. `selfAddresses` (lowercased) are treated as noise (mail to self).
export function scoreMessage(meta, selfAddresses = []) {
  const from = (meta.fromEmail || meta.fromName || '').toString();
  const subject = (meta.subject || '').toString();
  const reasons = [];
  let score = 0;

  const rejected = rejectReason(from, selfAddresses);
  if (rejected) {
    reasons.push(rejected);
    return { score: -100, relevant: false, reasons, from, subject };
  }

  const airlineSender = anyMatch(AIRLINE_SENDER_PATTERNS, from);
  const cancellationSubject = anyMatch(POSITIVE_SUBJECT, subject);
  const supportingSubject = anyMatch(SUPPORTING_SUBJECT, subject);
  const promotional = anyMatch(NEGATIVE_SUBJECT, subject);

  if (airlineSender) {
    score += 3;
    reasons.push('airline/agent sender');
  }
  if (cancellationSubject) {
    score += 3;
    reasons.push('cancellation/change subject');
  }
  if (supportingSubject && !cancellationSubject) {
    score += 1;
    reasons.push('booking proof (supporting)');
  }
  if (promotional) {
    score -= 4;
    reasons.push('promotional subject');
  }

  // Auto-include when the sender is an airline/agent AND the subject is either a
  // cancellation notice or booking proof — but never when it is promotional.
  // (A bare keyword match in unrelated mail lacks a plausible sender, so it is
  // left out.)
  const relevant =
    !promotional && airlineSender && (cancellationSubject || supportingSubject);
  const tier = cancellationSubject ? 'cancellation' : 'supporting';
  return { score, relevant, tier, reasons, from, subject };
}

// Curate a list of metadata rows: returns { chosen, skipped }, each entry
// carrying its threadId, from, subject and the scoring reasons.
export function curate(rows, selfAddresses = []) {
  const chosen = [];
  const skipped = [];
  for (const row of rows) {
    const verdict = scoreMessage(row, selfAddresses);
    const entry = { ...row, ...verdict };
    (verdict.relevant ? chosen : skipped).push(entry);
  }
  return { chosen, skipped };
}
