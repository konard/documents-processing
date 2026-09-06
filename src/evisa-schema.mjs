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
  addressInVietnam: { id: 'basic_ttcdDcTamTru', kind: 'select' },
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
export const AIR_BORDER_GATES = [
  'Cam Ranh Int Airport (Khanh Hoa)',
  'Can Tho International Airport',
  'Cat Bi Int Airport (Hai Phong)',
  'Chu Lai Airport Border Gate',
  'Da Nang International Airport',
  'Dong Hoi Int Airport (Quang Binh)',
  'Lien Khuong International Airport',
  'Noi Bai Int Airport',
  'Phu Bai Int Airport',
  'Phu Cat Int Airport',
  'Phu Quoc International Airport',
  'Tan Son Nhat Int Airport (Ho Chi Minh City)',
  'Van Don Int Airport',
  'Vinh Airport Border Gate',
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
