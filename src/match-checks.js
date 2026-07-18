#!/usr/bin/env node
// match-checks.js
//
// Loads the per-document transcripts in transcripts/ and cross-checks every
// person's documents. Writes a report per person + a summary into match-checks/.
//
// Transcript layers per document type:
//   passport      -> <NAME>-PASSPORT.ocr.json      (tesseract MRZ + check digits)
//                 +  <NAME>-PASSPORT.visual.json   (Claude read from scan)
//   Form C        -> <NAME>-FORM-C.ocr.json  (text-layer read: EXACT, authoritative;
//                    or OCR for image-only forms) + optional <NAME>-FORM-C.visual.json
//   India ETA     -> <NAME>-INDIA-VISA.text.json   (code-extracted text)
//   India VL visa -> <NAME>-INDIA-VISA.visual.json
//   India entry   -> <NAME>-INDIA-ENTRY.visual.json
//   Vietnam ticket-> <NAME>-VIETNAM-TICKET.text.json (code-extracted text)
//
// Check groups:
//   A)  Passport OCR vs visual reconciliation (do our two reads of the same scan
//       agree? plus MRZ check-digit status).
//   A2) Form C OCR vs visual reconciliation.
//   B)  Cross-document passport details (name, number, DOB, dates, sex).
//   C)  India-visa details recorded in the Form C vs the real visa/entry stamp.
//
// Usage:  node match-checks.js [baseDir]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// Scripts live in src/; the transcripts/ and match-checks/ folders live one
// level up in the project root. Default the base there.
const baseDir = process.argv[2] || path.dirname(scriptDir);
const transcriptsDir = path.join(baseDir, 'transcripts');
const outputDir = path.join(baseDir, 'match-checks');
fs.mkdirSync(outputDir, { recursive: true });

// ---- load transcripts, grouped by person ---------------------------------

const readJson = (fileName) =>
  JSON.parse(fs.readFileSync(path.join(transcriptsDir, fileName), 'utf8'));
const transcriptsByPerson = {};
for (const fileName of fs
  .readdirSync(transcriptsDir)
  .filter((name) => name.endsWith('.json'))) {
  const parsed = fileName.match(
    /^(.+?)-(PASSPORT|FORM-C|INDIA-VISA|INDIA-ENTRY|VIETNAM-TICKET)\.(ocr|visual|text)\.json$/
  );
  if (!parsed) {
    continue;
  }
  const [, personName, documentType, layer] = parsed;
  (transcriptsByPerson[personName] ||= {})[`${documentType}.${layer}`] =
    readJson(fileName);
}

// ---- field normalizers (so format differences don't look like mismatches) --

// Uppercase, strip punctuation, then sort the name tokens so that ordering or
// surname/given-name arrangement differences between documents don't look like
// a mismatch. (Names glued together without a space should be split upstream,
// e.g. via split-tickets.js --glued.)
const normalizeName = (value) =>
  (value || '')
    .toUpperCase()
    .replace(/[^A-Z ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
const normalizePassportNumber = (value) =>
  (value || '').toUpperCase().replace(/[^0-9]/g, '');
const normalizeVisaNumber = (value) =>
  (value || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0');
const normalizeNationality = (value) =>
  (value || '').toUpperCase().replace(/[^A-Z]/g, '');
const normalizeSex = (value) => (value || '').toUpperCase()[0] || '';

const MONTH_NUMBER = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};
function normalizeDate(value) {
  if (!value) {
    return '';
  }
  const text = String(value).trim().toUpperCase();
  let match;
  if ((match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return `${match[1]}${match[2]}${match[3]}`;
  } // ISO yyyy-mm-dd
  if ((match = text.match(/^(\d{1,2})[./ ]([A-Z]{3})[./ ](\d{4})$/))) {
    return `${match[3]}${MONTH_NUMBER[match[2]] || '??'}${match[1].padStart(2, '0')}`;
  } // 13/AUG/2024
  if ((match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/))) {
    return `${match[3]}${match[2].padStart(2, '0')}${match[1].padStart(2, '0')}`;
  } // dd.mm.yyyy
  return text;
}

// ---- one comparison across >=2 documents ----------------------------------

// `sources` is an array of { source, value }. Returns { label, status, sources }
// where status is MATCH / MISMATCH / INFO (fewer than two values present).
function compareField(label, sources, normalizer) {
  const present = sources.filter(
    (entry) =>
      entry.value !== null && entry.value !== undefined && entry.value !== ''
  );
  if (present.length < 2) {
    return { label, status: 'INFO', sources: present };
  }
  const withNormalized = present.map((entry) => ({
    ...entry,
    normalized: normalizer(entry.value),
  }));
  const distinctValues = [
    ...new Set(withNormalized.map((entry) => entry.normalized)),
  ];
  return {
    label,
    status: distinctValues.length === 1 ? 'MATCH' : 'MISMATCH',
    sources: withNormalized,
  };
}

// ---- build every check for one person -------------------------------------

// complex by nature: enumerates the full cross-document check matrix inline;
// each check is short but there are many, and keeping them together documents
// the whole comparison contract in one place.
/* eslint-disable-next-line complexity, max-lines-per-function */
function buildChecks(documents) {
  const passportOcr = documents['PASSPORT.ocr'];
  const passportVisual = documents['PASSPORT.visual'];
  const formCVisual = documents['FORM-C.visual'];
  const formCOcr = documents['FORM-C.ocr'];
  const indiaVisaText = documents['INDIA-VISA.text'];
  const indiaVisaVisual = documents['INDIA-VISA.visual'];
  const indiaVisa = indiaVisaText || indiaVisaVisual; // ETA text or VL sticker visual
  const entryStamp = documents['INDIA-ENTRY.visual'];
  const ticket = documents['VIETNAM-TICKET.text'];

  // The Form C transcript (`FORM-C.ocr`) can now come from two sources:
  //   - "text": read exactly from the PDF's text layer (Form C) — authoritative.
  //   - "OCR":  machine-read from a scan/photo (no text layer) — the visual read
  //             stays authoritative and OCR is only the cross-check.
  const formCIsText = !!(
    formCOcr &&
    typeof formCOcr._source === 'string' &&
    formCOcr._source.startsWith('text')
  );
  // Authoritative Form C for cross-document checks (B/C): text if we have it,
  // otherwise the visual read (image documents).
  const formC = formCIsText ? formCOcr : formCVisual;

  // A) Passport OCR vs visual (same scan, two reads).
  const passportReconciliation = [];
  if (passportOcr && passportVisual) {
    passportReconciliation.push(
      compareField(
        'Passport №: OCR vs visual',
        [
          { source: 'OCR', value: passportOcr.number },
          { source: 'visual', value: passportVisual.number },
        ],
        normalizePassportNumber
      )
    );
    passportReconciliation.push(
      compareField(
        'DOB: OCR vs visual',
        [
          { source: 'OCR', value: passportOcr.dob },
          { source: 'visual', value: passportVisual.dob },
        ],
        normalizeDate
      )
    );
    passportReconciliation.push(
      compareField(
        'Surname: OCR vs visual',
        [
          { source: 'OCR', value: passportOcr.surname },
          { source: 'visual', value: passportVisual.surname },
        ],
        normalizeName
      )
    );
    passportReconciliation.push(
      compareField(
        'Given name: OCR vs visual',
        [
          { source: 'OCR', value: passportOcr.given },
          { source: 'visual', value: passportVisual.given },
        ],
        normalizeName
      )
    );
    passportReconciliation.push(
      compareField(
        'Expiry: OCR vs visual',
        [
          { source: 'OCR', value: passportOcr.expiry },
          { source: 'visual', value: passportVisual.expiry },
        ],
        normalizeDate
      )
    );
    // Issue date is the one field not in the MRZ — read via keepBlack+consensus
    // (or filled from an override). Reconcile it against the visual read too.
    passportReconciliation.push(
      compareField(
        'Issue date: OCR vs visual',
        [
          {
            source:
              passportOcr._issueSource &&
              passportOcr._issueSource.startsWith('override')
                ? 'override'
                : 'OCR',
            value: passportOcr.issue,
          },
          { source: 'visual', value: passportVisual.issue },
        ],
        normalizeDate
      )
    );
  }
  const mrzCheckDigits =
    passportOcr && passportOcr._checkDigits ? passportOcr._checkDigits : null;

  // A2) Form C machine read vs visual read of the same document.
  //   - text source: this confirms our earlier visual read against the exact text.
  //   - OCR source:  this is the usual OCR-vs-visual reconciliation.
  const formCMachineLabel = formCIsText ? 'text' : 'OCR';
  const formCReconciliation = [];
  if (formCOcr && formCVisual) {
    formCReconciliation.push(
      compareField(
        `Form C surname: ${formCMachineLabel} vs visual`,
        [
          { source: formCMachineLabel, value: formCOcr.surname },
          { source: 'visual', value: formCVisual.surname },
        ],
        normalizeName
      )
    );
    formCReconciliation.push(
      compareField(
        `Form C DOB: ${formCMachineLabel} vs visual`,
        [
          { source: formCMachineLabel, value: formCOcr.dob },
          { source: 'visual', value: formCVisual.dob },
        ],
        normalizeDate
      )
    );
    formCReconciliation.push(
      compareField(
        `Form C passport-issue: ${formCMachineLabel} vs visual`,
        [
          { source: formCMachineLabel, value: formCOcr.passportIssue },
          { source: 'visual', value: formCVisual.passportIssue },
        ],
        normalizeDate
      )
    );
    formCReconciliation.push(
      compareField(
        `Form C visa number: ${formCMachineLabel} vs visual`,
        [
          { source: formCMachineLabel, value: formCOcr.visaNumber },
          { source: 'visual', value: formCVisual.visaNumber },
        ],
        normalizeVisaNumber
      )
    );
  }

  // Passport-derived truth: prefer the visual read, fall back to OCR.
  const passportNumber =
    (passportVisual && passportVisual.number) ||
    (passportOcr && passportOcr.number);
  const passportName = passportVisual
    ? `${passportVisual.surname} ${passportVisual.given}`
    : passportOcr
      ? `${passportOcr.surname} ${passportOcr.given}`
      : null;
  const passportDob =
    (passportVisual && passportVisual.dob) || (passportOcr && passportOcr.dob);
  const passportNationality =
    (passportVisual && passportVisual.nationality) ||
    (passportOcr && passportOcr.nationality);
  const passportSex =
    (passportVisual && passportVisual.sex) || (passportOcr && passportOcr.sex);
  const passportExpiry =
    (passportVisual && passportVisual.expiry) ||
    (passportOcr && passportOcr.expiry);
  const passportIssue =
    passportVisual &&
    passportVisual.issue &&
    !String(passportVisual.issue).includes('?')
      ? passportVisual.issue
      : null;

  // B) Passport details across all documents. The Form C source (`formC`) is the
  // exact text when available, else the visual read.
  const passportDetails = [];
  passportDetails.push(
    compareField(
      'Full name',
      [
        { source: 'passport', value: passportName },
        { source: 'formC', value: formC && `${formC.surname} ${formC.given}` },
        { source: 'india-visa', value: indiaVisa && indiaVisa.name },
        { source: 'ticket', value: ticket && ticket.passenger },
      ],
      normalizeName
    )
  );
  passportDetails.push(
    compareField(
      'Passport number',
      [
        { source: 'passport', value: passportNumber },
        { source: 'formC', value: formC && formC.passport },
        { source: 'india-visa', value: indiaVisa && indiaVisa.passport },
        {
          source: 'india-entry-stamp',
          value: entryStamp && entryStamp.passportOnPage,
        },
        { source: 'ticket', value: ticket && ticket.passport },
      ],
      normalizePassportNumber
    )
  );
  passportDetails.push(
    compareField(
      'Date of birth',
      [
        { source: 'passport', value: passportDob },
        { source: 'formC', value: formC && formC.dob },
        { source: 'ticket', value: ticket && ticket.dob },
      ],
      normalizeDate
    )
  );
  passportDetails.push(
    compareField(
      'Nationality',
      [
        { source: 'passport', value: passportNationality },
        { source: 'formC', value: formC && formC.nationality },
        { source: 'india-visa', value: indiaVisa && indiaVisa.nationality },
      ],
      normalizeNationality
    )
  );
  passportDetails.push(
    compareField(
      'Sex',
      [
        { source: 'passport', value: passportSex },
        { source: 'formC', value: formC && formC.sex },
      ],
      normalizeSex
    )
  );
  passportDetails.push(
    compareField(
      'Passport issue date',
      [
        { source: 'passport', value: passportIssue },
        { source: 'formC', value: formC && formC.passportIssue },
      ],
      normalizeDate
    )
  );
  passportDetails.push(
    compareField(
      'Passport expiry date',
      [
        { source: 'passport', value: passportExpiry },
        { source: 'formC', value: formC && formC.passportExpiry },
      ],
      normalizeDate
    )
  );

  // C) India-visa details recorded in the Form C vs the real visa / entry stamp.
  const visaDetails = [];
  visaDetails.push(
    compareField(
      'India visa/ETA number (Form C vs visa vs entry)',
      [
        { source: 'formC', value: formC && formC.visaNumber },
        {
          source: 'india-visa',
          value: indiaVisa && (indiaVisa.eta || indiaVisa.visaNo),
        },
        { source: 'india-entry-stamp', value: entryStamp && entryStamp.visaNo },
      ],
      normalizeVisaNumber
    )
  );
  visaDetails.push(
    compareField(
      'India visa issue date (Form C vs visa)',
      [
        { source: 'formC', value: formC && formC.visaIssue },
        { source: 'india-visa', value: indiaVisa && indiaVisa.issue },
      ],
      normalizeDate
    )
  );
  visaDetails.push(
    compareField(
      'India visa valid-till/expiry (Form C vs visa)',
      [
        { source: 'formC', value: formC && formC.visaValidTill },
        { source: 'india-visa', value: indiaVisa && indiaVisa.expiry },
      ],
      normalizeDate
    )
  );

  return {
    passportReconciliation,
    formCReconciliation,
    mrzCheckDigits,
    passportDetails,
    visaDetails,
    formCMachineLabel,
    available: {
      passportOcr: !!passportOcr,
      passportVisual: !!passportVisual,
      formCOcr: !!formCOcr,
      formC: !!formC,
      formCSource: formC ? (formCIsText ? 'text' : 'visual') : null,
      indiaVisa: !!indiaVisa,
      indiaVisaType: indiaVisaText ? 'ETA' : indiaVisaVisual ? 'VL' : null,
      entryStamp: !!entryStamp,
      ticket: !!ticket,
    },
  };
}

// ---- render one person's report to Markdown -------------------------------

const statusIcon = (status) =>
  status === 'MATCH'
    ? '✅ MATCH'
    : status === 'MISMATCH'
      ? '❌ MISMATCH'
      : 'ℹ️ n/a';
const valuesCell = (check) =>
  check.sources.length
    ? check.sources
        .map((entry) => `${entry.source}: \`${entry.value}\``)
        .join('<br>')
    : '—';

// complex by nature: one pass building the whole Markdown report layout;
// splitting it would scatter closely-coupled formatting decisions.
// eslint-disable-next-line complexity
function renderReport(personName, checks) {
  const lines = [];
  lines.push(`# Match check — ${personName}`, '');

  const documentList = [
    checks.available.passportOcr && checks.available.passportVisual
      ? 'passport (OCR + visual)'
      : checks.available.passportVisual
        ? 'passport (visual)'
        : null,
    checks.available.formC
      ? `Form C (${checks.available.formCSource})`
      : '⚠️ no Form C',
    checks.available.indiaVisa
      ? `India ${checks.available.indiaVisaType === 'ETA' ? 'ETA (text)' : 'VL visa (visual)'}`
      : null,
    checks.available.entryStamp ? 'India entry stamp (visual)' : null,
    checks.available.ticket ? 'Vietnam ticket (text)' : null,
  ].filter(Boolean);
  lines.push(`Documents on file: ${documentList.join(', ')}.`, '');

  const renderTable = (checkList) => {
    lines.push('| Field | Result | Values |', '|---|---|---|');
    for (const check of checkList) {
      lines.push(
        `| ${check.label} | ${statusIcon(check.status)} | ${valuesCell(check)} |`
      );
    }
    lines.push('');
  };

  lines.push('## A) Passport OCR vs visual reconciliation');
  if (checks.mrzCheckDigits) {
    const digits = checks.mrzCheckDigits;
    const summary = `passport ${digits.passport ? '✓' : '✗'}, DOB ${digits.dob ? '✓' : '✗'}, expiry ${digits.expiry ? '✓' : '✗'}`;
    const allValid = digits.passport && digits.dob && digits.expiry;
    lines.push(
      `MRZ check digits: ${summary}${allValid ? ' — all valid' : ' — ⚠️ some failed (OCR imperfect on that field; visual read is authoritative)'}`,
      ''
    );
  }
  renderTable(checks.passportReconciliation);

  if (checks.formCReconciliation.length) {
    if (checks.formCMachineLabel === 'text') {
      lines.push('## A2) Form C text vs visual reconciliation');
      lines.push(
        'The Form C is read EXACTLY from its embedded text layer (pdf.js). This table confirms our earlier visual read against that exact text — any mismatch here is a stale visual note, not a document problem (the text is authoritative).'
      );
    } else {
      lines.push('## A2) Form C OCR vs visual reconciliation');
      lines.push(
        'Independent OCR of the Form C (a scan/photo — no text layer) vs the visual read; the visual read is authoritative.'
      );
    }
    renderTable(checks.formCReconciliation);
  }

  lines.push('## B) Passport details across all documents');
  renderTable(checks.passportDetails);

  lines.push(
    '## C) India visa details recorded in the Form C vs the actual visa/entry'
  );
  renderTable(checks.visaDetails);

  // Separate genuine document discrepancies (B/C) from OCR-quality notes (A/A2).
  const documentDiscrepancies = [
    ...checks.passportDetails,
    ...checks.visaDetails,
  ].filter((check) => check.status === 'MISMATCH');
  const ocrNotes = [
    ...checks.passportReconciliation,
    ...checks.formCReconciliation,
  ].filter((check) => check.status === 'MISMATCH');

  if (documentDiscrepancies.length) {
    lines.push('## ⚠️ Document discrepancies (need attention)');
    for (const check of documentDiscrepancies) {
      lines.push(
        `- **${check.label}**: ${check.sources.map((entry) => `${entry.source}=\`${entry.value}\``).join(' vs ')}`
      );
    }
    lines.push('');
  } else {
    lines.push(
      '## ✅ No document discrepancies — all documents agree on every cross-checked field.',
      ''
    );
  }
  if (ocrNotes.length) {
    lines.push('## ℹ️ OCR-quality notes (not document problems)');
    lines.push(
      'The OCR and the visual read of the same scan differ on these fields (MRZ check digits confirm which is right; the visual read is authoritative). No action needed on the document itself.'
    );
    for (const check of ocrNotes) {
      lines.push(
        `- **${check.label}**: ${check.sources.map((entry) => `${entry.source}=\`${entry.value}\``).join(' vs ')}`
      );
    }
    lines.push('');
  }

  return {
    markdown: lines.join('\n'),
    documentDiscrepancies: documentDiscrepancies.map((check) => check.label),
    ocrNotes: ocrNotes.map((check) => check.label),
  };
}

// ---- run over everyone -----------------------------------------------------

const summaryRows = [];
for (const [personName, documents] of Object.entries(
  transcriptsByPerson
).sort()) {
  const checks = buildChecks(documents);
  const { markdown, documentDiscrepancies, ocrNotes } = renderReport(
    personName,
    checks
  );
  fs.writeFileSync(path.join(outputDir, `${personName}.md`), markdown);
  summaryRows.push({
    personName,
    documentDiscrepancies,
    ocrNotes,
    missingFormC: !checks.available.formC,
  });
  const headline = documentDiscrepancies.length
    ? `❌ ${documentDiscrepancies.length} document discrepancy: ${documentDiscrepancies.join(', ')}`
    : '✅ documents consistent';
  console.log(
    `✓ ${personName}: ${headline}${ocrNotes.length ? `  (+${ocrNotes.length} OCR note)` : ''}`
  );
}

const summaryLines = [
  '# Match checks — summary',
  '',
  "Every document has a persisted transcript in `transcripts/` (passports: OCR **and** visual; Form C: visual + OCR; VL visa / entry stamp: visual; ETA / ticket: code-extracted text). This report reconciles the OCR vs visual reads, then cross-checks passport details and the Form C's India-visa details against the real documents.",
  '',
  '**Document discrepancies** = different documents disagree about a fact (need attention). **OCR notes** = our OCR and visual read of the same scan differ (OCR limitation, not a document problem).',
  '',
  '| Person | Documents | Document discrepancies | OCR notes |',
  '|---|---|---|---|',
];
for (const row of summaryRows) {
  const result = row.documentDiscrepancies.length
    ? `❌ ${row.documentDiscrepancies.length}`
    : '✅ consistent';
  summaryLines.push(
    `| ${row.personName} | ${result} | ${row.documentDiscrepancies.join('; ') || '—'}${row.missingFormC ? ' _(no Form C on file)_' : ''} | ${row.ocrNotes.length || '—'} |`
  );
}
const totalDiscrepancies = summaryRows.reduce(
  (sum, row) => sum + row.documentDiscrepancies.length,
  0
);
summaryLines.push(
  '',
  `**Bottom line:** ${totalDiscrepancies === 0 ? 'no document discrepancies found.' : `${totalDiscrepancies} document discrepancy(ies) found — see below.`}`,
  ''
);
for (const row of summaryRows.filter(
  (entry) => entry.documentDiscrepancies.length
)) {
  summaryLines.push(
    `- **${row.personName}**: ${row.documentDiscrepancies.join('; ')}`
  );
}
summaryLines.push(
  '',
  'See each `<PERSON>.md` for the full field-by-field tables (sections A/A2/B/C).',
  ''
);
fs.writeFileSync(path.join(outputDir, 'SUMMARY.md'), summaryLines.join('\n'));
console.log(`\nReports written to: ${outputDir}`);
