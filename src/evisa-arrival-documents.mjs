// evisa-arrival-documents.mjs
//
// Reading the two documents the pre-arrival declaration needs.
//
// The declaration asks for a visa number, the dates it was granted between,
// a flight number and where the flight comes from. None of it is on a
// passport, and the application form never held any of it, so it was listed
// as "known from nowhere else" and asked of the applicant by hand.
//
// Both are in fact already in the chat. The e-visa arrives as a PDF the
// moment it is granted, and the flight as an airline's e-ticket, and both
// carry their values as text. What follows reads that text.
//
// Neither is an image. The reader that ran on anything sent to the chat
// looked for an embedded picture, found a QR code or a banner, and gave up;
// the applicant was then told their visa was an unrecognisable picture. So
// these are read as documents, from the text layer, and what cannot be read
// is left unset for the declaration to ask about by name.

/** A date as an airline prints it: 16Sep2026. */
const TICKET_DATE = /\b(\d{1,2})([A-Za-z]{3})(\d{4})\b/;

const MONTHS = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/** An airline's date in the order the declaration writes one. */
export function readTicketDate(said) {
  const found = String(said ?? '').match(TICKET_DATE);
  if (!found) {
    return null;
  }
  const month = MONTHS[found[2].toLowerCase()];
  if (!month) {
    return null;
  }
  return `${found[1].padStart(2, '0')}/${month}/${found[3]}`;
}

/**
 * Whether a page of text is a granted Vietnamese e-visa.
 *
 * Both wordings are looked for, since the document is bilingual and a
 * reader that finds only one of them has probably found something else.
 */
export function looksLikeEvisa(text) {
  const said = String(text ?? '');
  return (
    /ELECTRONIC VISA/i.test(said) && /Good for entry valid from/i.test(said)
  );
}

/** Whether a page of text is an airline's e-ticket. */
export function looksLikeTicket(text) {
  const said = String(text ?? '');
  return /BOOKING REFERENCE/i.test(said) || /ELECTRONIC TICKET/i.test(said);
}

/**
 * What a granted e-visa says, in the declaration's own field names.
 *
 * The number is the one the visa calls Số, not the application code: the
 * declaration asks for the visa, and the application code names the request
 * that produced it. Both are on the page, a line apart.
 */
export function readEvisa(text) {
  const said = String(text ?? '');
  const found = {};

  const number =
    said.match(/Số:\s*([0-9]+\/EV)/i) ?? said.match(/\b(\d{6,}\/EV)\b/);
  if (number) {
    found.visaNumber = number[1];
  }
  // "valid from 16/09/2026 until 14/12/2026", printed on one line with the
  // Vietnamese above it and the English label beneath.
  const window = said.match(
    /GIÁ TRỊ TỪ NGÀY\s*(\d{2}\/\d{2}\/\d{4})\s*ĐẾN NGÀY\s*(\d{2}\/\d{2}\/\d{4})/i
  );
  if (window) {
    found.visaIssueDate = window[1];
    found.visaExpiryDate = window[2];
  }
  const name = said.match(/HỌ TÊN:\s*(.+)/);
  if (name) {
    found.fullName = name[1].trim();
  }
  const born = said.match(/NGÀY THÁNG NĂM SINH:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (born) {
    found.dateOfBirth = born[1];
  }
  const passport = said.match(/SỐ HỘ CHIẾU:\s*([A-Z0-9]+)/i);
  if (passport) {
    found.passportNumber = passport[1];
  }
  const expiry = said.match(/THỜI HẠN ĐẾN:\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (expiry) {
    found.passportExpiryDate = expiry[1];
  }
  const purpose = said.match(/MỤC ĐÍCH NHẬP CẢNH:\s*(.+)/i);
  if (purpose) {
    found.purpose = purpose[1].trim();
  }
  // The application code, kept so a lookup can be offered without the
  // applicant copying it out of their email again.
  const code = said.match(/Mã:\s*(E\d{6}[A-Z]{3}\d+)/i);
  if (code) {
    found.applicationNumber = code[1].toUpperCase();
  }
  return found;
}

/** The airports an itinerary names, in the order they are flown. */
const VIETNAM =
  /VIET\s?NAM|HO CHI MINH|HANOI|HA NOI|DA NANG|NHA TRANG|CAM RANH|PHU QUOC/i;

/**
 * The legs of an itinerary: where each goes, on what flight, on what day.
 *
 * An e-ticket lays a leg out across several lines, the airports and flight
 * number on one and the dates beneath. They are read together, since a
 * flight number without its date says nothing about when somebody arrives.
 */
export function readLegs(text) {
  const lines = String(text ?? '').split('\n');
  const legs = [];
  for (let at = 0; at < lines.length; at += 1) {
    const flight = lines[at].match(/\b([A-Z]{2}\d{3,4})\b/);
    if (!flight) {
      continue;
    }
    const before = lines[at].slice(0, flight.index).trim();
    if (!before) {
      continue;
    }
    // The date sits on this line or the next few, depending on how the
    // airline wrapped the columns.
    const near = lines.slice(at, at + 4).join(' ');
    legs.push({
      flightNumber: flight[1],
      route: before.replace(/\s{2,}/g, ' | '),
      date: readTicketDate(near),
    });
  }
  return legs;
}

/**
 * What an e-ticket says about arriving in Viet Nam.
 *
 * A traveller may change planes twice before they land, and it is the leg
 * that ends in Viet Nam that the declaration asks about: that flight's
 * number, that day, and the airport it lands at. Where the journey began is
 * the first leg's origin, which is what "first point of departure if
 * transiting through multiple country" means.
 */
export function readTicket(text) {
  const legs = readLegs(text);
  if (!legs.length) {
    return {};
  }
  const found = {};
  const arriving = legs.find((leg) => VIETNAM.test(leg.route));
  if (arriving) {
    found.flightNumber = arriving.flightNumber;
    found.vehicleNumber = arriving.flightNumber;
    if (arriving.date) {
      found.arrivalDate = arriving.date;
    }
  }
  // Where the whole journey started, which is not where the last leg did.
  const first = legs[0].route.split(' | ')[0]?.trim();
  if (first && arriving && legs[0] !== arriving) {
    found.departedFrom = first;
  }
  const reference = String(text ?? '').match(
    /BOOKING REFERENCE:\s*([A-Z0-9]+)/i
  );
  if (reference) {
    found.bookingReference = reference[1];
  }
  return found;
}

/**
 * Reads whichever of the two a document is, and says which it was.
 *
 * Telling them apart is the document's own job: both are PDFs, both name
 * the traveller, and asking the applicant which they just sent is a
 * question their own file already answers.
 */
export function readArrivalDocument(text) {
  if (looksLikeEvisa(text)) {
    return { kind: 'evisa', values: readEvisa(text) };
  }
  if (looksLikeTicket(text)) {
    return { kind: 'ticket', values: readTicket(text) };
  }
  return { kind: null, values: {} };
}

/**
 * Wires the two readers to a chat.
 *
 * Says whether it took the document, so anything it does not recognise goes
 * on to be read as a passport, which is what a PDF in this chat usually is.
 */
export function createArrivalDocuments({
  sessions,
  MESSAGES,
  log,
  describeFields,
}) {
  return async function tookArrivalDocument(ctx, chatId, local) {
    const session = sessions.get(chatId);
    const { pdfText } = await import('./pdf-to-lino.mjs');
    let text;
    try {
      text = pdfText(local);
    } catch (error) {
      log(chatId, `could not read the PDF as text: ${error.message}`);
      return false;
    }
    const { kind, values } = readArrivalDocument(text);
    if (!kind) {
      return false;
    }
    if (!Object.keys(values).length) {
      log(chatId, `read a ${kind} but nothing on it could be made out`);
      return false;
    }
    Object.assign(session.data, values);
    log(chatId, `read the ${kind}: ${describeFields(values)}`);
    const strings = MESSAGES[session.language];
    await ctx.reply(
      kind === 'evisa' ? strings.readEvisa(values) : strings.readTicket(values)
    );
    return true;
  };
}
