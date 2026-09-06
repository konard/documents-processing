---
'documents-processing': minor
---

Add a Vietnam e-visa form filler. `src/evisa-apply.mjs` collects applicant data
from JSON, lino, images, PDFs, folders and zip archives, reads a passport's
machine-readable zone with check-digit verification, prepares the portrait and
passport-page uploads to the site's 4x6 cm and 2 MB rules, and fills the form at
evisa.gov.vn in a headed browser without submitting it. Values are validated
first — required fields, real calendar dates, the 90-day validity limit, and
dates that have already passed — and everyday wording such as "Tourism" or
"Noi Bai Airport Border Gate" is rewritten to the exact options the site's
dropdowns accept.

Also fixes a passport-expiry misread in `parseMrzLine2`: two-digit years were
resolved with a birth-year pivot, so a passport expiring in '32 was read as 1932.
