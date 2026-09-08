---
'documents-processing': minor
---

Add a Vietnam e-visa form filler, as a command-line tool and as a Telegram bot.

`src/evisa-apply.mjs` collects applicant data from JSON, lino, images, PDFs,
folders and zip archives, reads a passport with every OCR engine at hand in
parallel (Apple Vision, RapidOCR, PaddleOCR, Tesseract) over several
renderings of the image, settling each field by consensus between the
machine-readable zone, with its check digits, and the print above it, prepares the portrait and passport-page uploads
to the site's 4x6 cm and 2 MB rules, and fills the form at evisa.gov.vn in a
headed browser without submitting it. Values are validated first: required
fields, real calendar dates, the 90-day validity limit, and dates that have
already passed. Everyday wording such as "Tourism" or "Noi Bai Airport Border
Gate" is rewritten to the exact options the site's dropdowns accept. Russian
and Latin postal addresses are taken apart and written in one canonical
order, checked against OpenStreetMap through Photon, and two spellings of one
house are recognised as the same address.

`src/evisa-bot-run.mjs` does the same in conversation, in Russian or English:
it reads passports and details out of messages, fills the form once the
chat goes quiet, ticks the declarations under it, sends the page back as a
file, and explains what went on the form in sections. On the applicant's
word to send it presses Next, sends back the review page and its captcha,
types the code they answer with, and after a countdown of 30 seconds they
can stop presses Next again, sending back the page that follows. The bot
ships with a Dockerfile and compose file, and can run with visible browsers.

Also fixes a passport-expiry misread in `parseMrzLine2`: two-digit years were
resolved with a birth-year pivot, so a passport expiring in '32 was read as 1932. Email rendering to PDF strips active content, every PDF writer uses a
plain cross-reference table, and the release job's npm setup no longer
depends on a package evaluated at run time.
