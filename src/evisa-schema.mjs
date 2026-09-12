// evisa-schema.mjs
//
// The field map for the Vietnam e-visa application form at
// https://evisa.gov.vn/e-visa/foreigners
//
// The form is an Angular + Ant Design app. Text inputs carry stable `basic_*`
// element ids, so those are the primary selectors. Radio groups carry no ids at
// all, so they are addressed by the question text rendered above them.
//
// Field semantics follow https://evisa.gov.vn/instruction: everything is
// declared in English, dates are DD/MM/YYYY, and an e-visa is valid for at most
// 90 days.

/** Maximum e-visa validity, in days, per the Immigration Department. */
export const MAX_EVISA_DAYS = 90;

/** Photo rules quoted from the instruction page (step 1 of the declaration). */
export const PHOTO_RULES = {
  sizeCm: '4x6',
  formats: ['jpg', 'jpeg'],
  maxBytes: 2 * 1024 * 1024,
  requirements: [
    'front-facing',
    'no hat',
    'no glasses',
    'formal attire',
    'white background',
  ],
};

/** Both upload inputs accept these MIME types (read off the live form). */
export const UPLOAD_ACCEPT = ['image/png', 'image/jpg', 'image/jpeg'];

/**
 * Text, date and typeahead fields, keyed by the name used in input documents.
 *
 * `kind` drives how the filler types the value:
 *   text   - plain input, typed directly
 *   date   - DD/MM/YYYY input, typed then confirmed with Escape
 *   select - Ant Design typeahead; typing filters an overlay list that must be
 *            clicked, so these need option text that matches the site's wording
 */
export const FIELDS = {
  surname: { id: 'basic_ttcnHo', kind: 'text', max: 50, required: true },
  givenName: {
    id: 'basic_ttcnDemVaTen',
    kind: 'text',
    max: 50,
    required: true,
  },
  dateOfBirth: {
    id: 'basic_ttcnNgayThangNamSinhStr',
    kind: 'date',
    required: true,
  },
  sex: { id: 'basic_ttcnGioiTinh', kind: 'select', required: true },
  nationality: { id: 'basic_ttcnMaQt', kind: 'select', required: true },
  identityCard: { id: 'basic_ttcnCccd', kind: 'text', max: 20 },
  email: { id: 'basic_ttcnEmail', kind: 'text', max: 100, required: true },
  confirmEmail: {
    id: 'basic_ttcnConfirmEmail',
    kind: 'text',
    max: 100,
    required: true,
  },
  religion: { id: 'basic_ttcnTonGiao', kind: 'text', max: 50 },
  placeOfBirth: { id: 'basic_ttcnNoiSinh', kind: 'text', max: 255 },

  validFrom: { id: 'basic_nddnTtdtTuNgayStr', kind: 'date', required: true },
  validTo: { id: 'basic_nddnTtdtDenNgayStr', kind: 'date', required: true },

  passportNumber: { id: 'basic_hcSo', kind: 'text', max: 20, required: true },
  passportIssuingAuthority: { id: 'basic_hcNoiCap', kind: 'text', max: 100 },
  passportType: { id: 'basic_hcLoai', kind: 'select' },
  passportIssueDate: { id: 'basic_hcNgayCapStr', kind: 'date' },
  passportExpiryDate: {
    id: 'basic_hcGiaTriDenStr',
    kind: 'date',
    required: true,
  },

  permanentAddress: { id: 'basic_ttllDcThuongTru', kind: 'text', max: 255 },
  contactAddress: { id: 'basic_ttllDcLienHe', kind: 'text', max: 255 },
  phone: { id: 'basic_ttllSdt', kind: 'text', max: 50 },
  emergencyName: { id: 'basic_ttllLlHoTen', kind: 'text', max: 100 },
  emergencyAddress: { id: 'basic_ttllLlNoiOHienTai', kind: 'text', max: 255 },
  emergencyPhone: { id: 'basic_ttllLlSdt', kind: 'text', max: 50 },
  emergencyRelationship: { id: 'basic_ttllLlQuanHe', kind: 'text', max: 50 },

  occupation: { id: 'basic_nnNgheNghiep', kind: 'select' },
  occupationInfo: { id: 'basic_nnNgheNghiepHienTai', kind: 'text', max: 50 },
  employerName: { id: 'basic_nnTenCtyCq', kind: 'text', max: 100 },
  position: { id: 'basic_nnChucVu', kind: 'text', max: 50 },
  employerAddress: { id: 'basic_nnDiaChi', kind: 'text', max: 255 },
  employerPhone: { id: 'basic_nnSdt', kind: 'text', max: 50 },

  purpose: { id: 'basic_ttcdMucDich', kind: 'select', required: true },
  entryDate: { id: 'basic_ttcdThoiGianNcStr', kind: 'date', required: true },
  stayLengthDays: { id: 'basic_ttcdSoNgayTamTru', kind: 'text', max: 20 },
  phoneInVietnam: { id: 'basic_ttcdSdt', kind: 'text', max: 50 },
  // An autocomplete that offers no options: it takes the house number and
  // street as typed, so it is filled as text. The two beside it are true
  // dropdowns, and the ward list depends on the province selected.
  addressInVietnam: { id: 'basic_ttcdDcTamTru', kind: 'text', max: 255 },
  provinceInVietnam: { id: 'basic_ttcdTinhTp', kind: 'select' },
  wardInVietnam: { id: 'basic_ttcdPhuongXa', kind: 'select' },
  entryBorderGate: {
    id: 'basic_ttcdNcCuaKhau',
    kind: 'select',
    required: true,
  },
  exitBorderGate: { id: 'basic_ttcdXcCuaKhau', kind: 'select', required: true },

  intendedExpenses: { id: 'basic_kpbhDuTinh', kind: 'text', max: 20 },
  hasInsurance: { id: 'basic_kpbhMuaBaoHiem', kind: 'select' },
  expensesCoveredBy: { id: 'basic_kpbhNguoiDamBao', kind: 'select' },
};

/**
 * Yes/No and either/or radio groups. They have no ids, so each is located by
 * the question text of its surrounding block; `options` are the visible labels.
 */
export const RADIO_GROUPS = {
  dateOfBirthPrecision: {
    question: 'Date of birth',
    options: ['Full', 'Only year is known'],
    default: 'Full',
  },
  usedOtherPassportsToVietnam: {
    question: 'Have you ever used any other passports to enter into Viet Nam?',
    options: ['No', 'Yes'],
    default: 'No',
  },
  multipleNationalities: {
    question: 'Do you have multiple nationalities?',
    options: ['No', 'Yes'],
    default: 'No',
  },
  violatedVietnameseLaw: {
    question: 'Violation of the Vietnamese laws/regulations (if any)',
    options: ['No', 'Yes'],
    default: 'No',
  },
  entryType: {
    question: 'Single-entry',
    options: ['Single-entry', 'Multiple-entry'],
    default: 'Single-entry',
  },
  holdsOtherValidPassports: {
    question: 'Do you hold any other valid passports',
    options: ['No', 'Yes'],
    default: 'No',
  },
  contactsAgencyInVietnam: {
    question:
      'Agency/Organization/Individual that the applicant plans to contact when enter into Viet Nam?',
    options: ['No', 'Yes'],
    default: 'No',
  },
  visitedVietnamLastYear: {
    question: 'Have you been to Viet Nam in the last 01 year?',
    options: ['No', 'Yes'],
    default: 'No',
  },
  hasRelativesInVietnam: {
    question: 'Do you have relatives who currently reside in Viet Nam?',
    options: ['No', 'Yes'],
    default: 'No',
  },
};

/** File upload inputs. The portrait must be uploaded before the passport page. */
export const UPLOADS = {
  portraitPhoto: { id: 'basic_anhMat', label: 'Portrait photography' },
  passportPage: { id: 'basic_anhHoChieu', label: 'Passport data page image' },
};

/**
 * Air border gates exactly as the form's dropdown spells them.
 *
 * These differ from the wording on the instruction page — the site lists
 * "Noi Bai Int Airport" where the instructions say "Noi Bai Airport Border
 * Gate" — and the dropdown only accepts its own spelling, so this list is
 * taken from the live form.
 */
export const BORDER_GATES = [
  'An Thoi Port Border Gate, An Giang province',
  'Ben Luc Port Border Gate, Tay Ninh province',
  'Ben Thuy Port Border Gate, Nghe An province',
  'Binh Hiep international border gate, Tay Ninh province',
  'Bo Y Landport',
  'Ca Na Port Border Gate, Khanh Hoa province',
  'Cam Pha Seaport',
  'Cam Ranh Int Airport (Khanh Hoa)',
  'Can Tho International Airport',
  'Cat Bi Int Airport (Hai Phong)',
  'Cau Treo Landport',
  'Cha Lo Landport',
  'Chan May Seaport',
  'Chu Lai Airport Border Gate',
  'Cua Viet Port Border Gate, Quang Tri province',
  'Da Nang International Airport',
  'Da Nang Seaport',
  'Diem Dien Port Border Gate, Hung Yen province',
  'Dinh Ba international border gate, Dong Thap province',
  'Dong Dang international border gate, Lang Son province',
  'Dong Hoi Int Airport (Quang Binh)',
  'Dong Thap Port Border Gate, Dong Thap province',
  'Dung Quat Seaport',
  'Duong Dong Seaport',
  'Gianh Port Border Gate, Quang Tri province',
  'Giao Long Port Border Gate, Vinh Long province',
  'Ha Tien Landport',
  'Hai Phong Seaport',
  'Hai Thinh Port Border Gate, Ninh Binh province',
  'Ho Chi Minh City Seaport',
  'Hon Chong Port Border Gate, An Giang province',
  'Hon Gai Seaport',
  'Hon La Port Border Gate, Quang Tri province',
  'Huu Nghi Landport',
  'Ky Ha Port Border Gate, Da Nang province',
  'La Lay Landport',
  'Lao Bao Landport',
  'Lao Cai Landport',
  'Lao Cai international border gate (Railway), Lao Cai province',
  'Le Thanh international border gate, Gia Lai province',
  'Lien Huong Port Border Gate, Lam Dong province',
  'Lien Khuong International Airport',
  'Long Sap international border gate, Son La province',
  'Moc Bai Landport',
  'Mong Cai Landport',
  'My Thoi Port Border Gate, An Giang province',
  'Na Meo Landport',
  'Nam Can Landport',
  'Nam Can Port Border Gate, Ca Mau province',
  'Nam Giang international border gate, Da Nang province',
  'Nghi Son Seaport',
  'Nha Trang Seaport',
  'Ninh Chu Port Border Gate, Khanh Hoa province',
  'Ninh Phuc Port Border Gate, Ninh Binh province',
  'Noi Bai Int Airport',
  'Phu Bai Int Airport',
  'Phu Cat Int Airport',
  'Phu Quoc International Airport',
  'Phu Quy Port Border Gate, Lam Dong province',
  'Quy Nhon Seaport',
  'Sa Ky Port Border Gate, Quang Ngai province',
  'Soai Riep - Hiep Phuoc Port Border Gate, Dong Thap province',
  'Son Duong Port Border Gate Ha Tinh province',
  'Tan Nam international border gate, Tay Ninh province',
  'Tan Son Nhat Int Airport (Ho Chi Minh City)',
  'Tay Trang Landport',
  'Thanh Thuy international border gate, Tuyen Quang province',
  'Thuan An Port Border Gate, Hue City',
  'Thuong Phuoc international border gate, Dong Thap province',
  'Tinh Bien Landport',
  'Tra Linh international border gate, Cao Bang province',
  'Truong Long Hoa Port Border Gate, Vinh Long province',
  'Van Don Int Airport',
  'Van Gia Port Border Gate, Quang Ninh province',
  'Vinh Airport Border Gate',
  'Vinh Xuong Landport',
  'Vung Ro Port Border Gate Dak Lak province',
  'Vung Tau Seaport',
  'Xa Mat Landport',
];

/** The air gates among them, which is what most applicants arrive through. */
export const AIR_BORDER_GATES = BORDER_GATES.filter((gate) =>
  /airport/i.test(gate)
);

/**
 * Values assumed when an applicant does not supply them.
 *
 * Both fields are required, and both have an answer that fits the overwhelming
 * majority of applicants, so asking for them adds a step without adding
 * information. They are ordinary form entries and remain editable in the
 * browser before submission.
 */
export const FIELD_DEFAULTS = {
  passportType: 'Ordinary passport',
  religion: 'Christianity',
  // Nearly everyone applying for an e-visa is going on holiday, and the
  // other purposes need papers from the Vietnamese side that a tourist
  // does not have.
  purpose: 'Tourist',
  // Ho Chi Minh City takes the most international traffic, and its airport is
  // the busiest approved gate. The wording is taken from the form's own
  // dropdowns, which spell the city differently in each of them.
  entryBorderGate: 'Tan Son Nhat Int Airport (Ho Chi Minh City)',
  exitBorderGate: 'Tan Son Nhat Int Airport (Ho Chi Minh City)',
  // The three address fields are required, so an applicant who has not booked
  // anywhere yet still has to enter one. They stay editable in the browser.
  // The whole address, in the order the site's own example gives, since that
  // box asks for the complete temporary address and not just the street.
  addressInVietnam: '406/14 Cong Hoa, Tan Binh, Ho Chi Minh',
  provinceInVietnam: 'HO CHI MINH City',
  wardInVietnam: 'PHUONG TAN BINH',
};

/** Passport-type options, as worded in the form's dropdown. */
export const PASSPORT_TYPES = [
  'Ordinary passport',
  'Diplomatic passport',
  'Official passport',
  'Other',
];

/** Purpose-of-entry options, as worded in the form's dropdown. */
export const PURPOSES = [
  'Tourist',
  'Visiting relatives',
  'Working',
  'Business',
  'Other',
];

/** Every field name the tool understands, for input validation. */
export const KNOWN_KEYS = new Set([
  ...Object.keys(FIELDS),
  ...Object.keys(RADIO_GROUPS),
  ...Object.keys(UPLOADS),
]);

/** ISO 3166 alpha-3 codes for the nationalities seen most often in this repo. */
const COUNTRY_NAMES = {
  RUS: 'Russia',
  UKR: 'Ukraine',
  BLR: 'Belarus',
  KAZ: 'Kazakhstan',
  USA: 'United States of America',
  GBR: 'United Kingdom',
  DEU: 'Germany',
  FRA: 'France',
  IND: 'India',
  CHN: 'China',
};

/** Expands an alpha-3 code to the country name the form's dropdown lists. */
export function countryName(code) {
  if (!code) {
    return null;
  }
  return COUNTRY_NAMES[code.toUpperCase()] ?? code.toUpperCase();
}

/** Maps an MRZ sex character to the form's wording. */
export function sexLabel(code) {
  if (code === 'M') {
    return 'Male';
  }
  if (code === 'F') {
    return 'Female';
  }
  return null;
}
