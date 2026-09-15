---
'documents-processing': minor
---

Add a complete Vietnam e-visa workflow for the command line and Telegram.

The form filler accepts JSON, Links Notation, images, PDFs, directories and
archives. It reads passports with several OCR engines and MRZ checks, prepares
the required photographs, validates dates and required values, normalizes
addresses and border gates to the site's options, and fills a visible browser
without submitting. OCR can also run as an explicitly read-only operation.

The bilingual Telegram bot collects documents and free-text corrections,
keeps their arrival order while reading files concurrently, and fills exactly
once after the batch becomes quiet. It classifies passport pages, portraits,
bookings, granted e-visas and tickets; extracts trip and visa details; matches
current Vietnamese provinces and wards; and reports one consistent result for
the whole batch. Repeated fills, stale review retries, stalled browser calls,
duplicate warnings and other loops now stop with an actionable explanation.

Filled forms are read back from the live page, settled before capture, and
shown as readable sections plus a full-page file. Pre-arrival declarations
likewise return one combined image containing every visited page, with both
passenger and trip summaries. The site's selected Hotel and filled address are
accepted, optional departure and workplace fields are not reported missing,
and focus is removed before screenshots. Corrections restart cleanly when the
site requires a new CAPTCHA. Nothing is submitted without the traveller's
explicit confirmation.

The bot can retrieve filed application documents, remember registration data,
watch for payment completion, and draft the pre-arrival declaration using the
application, granted visa and ticket. Captchas are routed to the correct live
browser, and retries are deliberately limited on the government sites.

Application state, diagnostic logs and optional transcripts survive restarts
in the configured data volume and are removed by retention sweeps. A filed
application PDF can be converted back to Links Notation for comparison. The
package also includes Docker deployment, privacy checks, safer PDF generation,
sanitized email-to-PDF rendering, and corrected passport-expiry year handling.
