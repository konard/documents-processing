import { describe, it, expect } from 'test-anywhere';
import {
  readTicketDate,
  looksLikeEvisa,
  looksLikeTicket,
  readEvisa,
  readLegs,
  readTicket,
  readArrivalDocument,
} from '../src/evisa-arrival-documents.mjs';

/** An e-visa as the site prints one, with nobody's details on it. */
const EVISA = `
               CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM
                    SOCIALIST REPUBLIC OF VIET NAM
                           THỊ THỰC ĐIỆN TỬ
                           ELECTRONIC VISA
                             Số: 10000000/EV
                             Mã: E260908XXX0000000000
THỊ THỰC CÓ GIÁ TRỊ TỪ NGÀY 16/09/2026         ĐẾN NGÀY 14/12/2026
Good for entry valid from                      until
HỌ TÊN: TRAVELLER SAMPLE
NGÀY THÁNG NĂM SINH: 01/02/1990
SỐ HỘ CHIẾU: 712345678                         THỜI HẠN ĐẾN: 29/11/2027
Passport number                                Date of expiry
MỤC ĐÍCH NHẬP CẢNH: Tourist
`;

/** An itinerary that changes planes once before reaching Viet Nam. */
const TICKET = `
    PASSENGER: TRAVELLER SAMPLE MR (ADT)
    BOOKING REFERENCE: AAAAAA
    ELECTRONIC TICKET ITINERARY / RECEIPT
    From                          To                         Flight    Departure
    GOA MOPA AIRPORT              DELHI INDIRA GANDHI INTL   XX9999   00:35
                                  Terminal: 1                         16Sep2026
    DELHI INDIRA GANDHI INTL HO CHI MINH CITY TAN SON NHAT XX1111
    Terminal: 3              INTL
    16Sep2026
`;

describe('telling the two documents apart', () => {
  it('knows a granted e-visa', () => {
    expect(looksLikeEvisa(EVISA)).toBe(true);
    expect(looksLikeEvisa(TICKET)).toBe(false);
  });

  it('knows an airline ticket', () => {
    expect(looksLikeTicket(TICKET)).toBe(true);
    expect(looksLikeTicket(EVISA)).toBe(false);
  });

  it('claims neither for something else', () => {
    // A passport scan is a PDF too, and taking one for a visa would put its
    // number in the declaration as a visa number.
    expect(readArrivalDocument('RUSSIAN FEDERATION PASSPORT').kind).toBe(null);
    expect(readArrivalDocument('').kind).toBe(null);
  });
});

describe('reading a granted e-visa', () => {
  it('takes the visa number, not the application code', () => {
    // Both are on the page a line apart. The declaration asks for the visa;
    // the code names the request that produced it.
    const found = readEvisa(EVISA);
    expect(found.visaNumber).toBe('10000000/EV');
    expect(found.applicationNumber).toBe('E260908XXX0000000000');
  });

  it('takes the window the visa is good for', () => {
    const found = readEvisa(EVISA);
    expect(found.visaIssueDate).toBe('16/09/2026');
    expect(found.visaExpiryDate).toBe('14/12/2026');
  });

  it('takes the traveller as the visa prints them', () => {
    const found = readEvisa(EVISA);
    expect(found.fullName).toBe('TRAVELLER SAMPLE');
    expect(found.dateOfBirth).toBe('01/02/1990');
    expect(found.passportNumber).toBe('712345678');
    expect(found.passportExpiryDate).toBe('29/11/2027');
    expect(found.purpose).toBe('Tourist');
  });
});

describe('reading a flight out of a ticket', () => {
  it('reads a date in the order the declaration wants', () => {
    expect(readTicketDate('16Sep2026')).toBe('16/09/2026');
    expect(readTicketDate('1Jan2027')).toBe('01/01/2027');
  });

  it('refuses a month that is not one', () => {
    expect(readTicketDate('16Xyz2026')).toBe(null);
    expect(readTicketDate('nothing here')).toBe(null);
  });

  it('finds every leg of the journey', () => {
    const legs = readLegs(TICKET);
    expect(legs.length).toBe(2);
    expect(legs[0].flightNumber).toBe('XX9999');
    expect(legs[1].flightNumber).toBe('XX1111');
  });

  it('takes the leg that lands in Viet Nam, not the first one', () => {
    // A traveller may change planes twice before they arrive, and the
    // declaration asks about the flight that brings them in.
    const found = readTicket(TICKET);
    expect(found.flightNumber).toBe('XX1111');
    expect(found.vehicleNumber).toBe('XX1111');
    expect(found.arrivalDate).toBe('16/09/2026');
  });

  it('takes where the journey began, not where the last leg did', () => {
    // "First point of departure if transiting through multiple country" is
    // the question, so the answer is the origin, not the place they changed.
    expect(readTicket(TICKET).departedFrom).toBe('GOA MOPA AIRPORT');
  });

  it('says nothing about a flight that goes nowhere near Viet Nam', () => {
    const elsewhere =
      'BOOKING REFERENCE: BBBBBB\nPARIS CDG  BERLIN BER XX2222\n1Jan2027';
    const found = readTicket(elsewhere);
    expect(found.flightNumber).toBe(undefined);
    expect(found.arrivalDate).toBe(undefined);
  });
});

describe('reading whichever document arrived', () => {
  it('says which it was, so the chat can say so too', () => {
    expect(readArrivalDocument(EVISA).kind).toBe('evisa');
    expect(readArrivalDocument(TICKET).kind).toBe('ticket');
  });

  it('fills the fields the declaration had no source for', () => {
    // These were listed as knowable from nowhere else and asked of the
    // applicant by hand, while sitting in a file they had already sent.
    const { values } = readArrivalDocument(EVISA);
    expect(values.visaNumber).toBeTruthy();
    expect(values.visaIssueDate).toBeTruthy();
    expect(values.visaExpiryDate).toBeTruthy();
  });
});
