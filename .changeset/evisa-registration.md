---
'documents-processing': minor
---

Keep the application's details when the site registers it, and watch for the
payment.

The dialog the site shows on accepting an application is the only place the
electronic document code appears in the browser, and it goes as soon as the
applicant presses Confirm. `readRegistration` takes the code, the email, the
date of birth and the passport number out of that dialog, which is everything
the search page later asks for, so `/documents` needs no argument and the
applicant never copies a code out of a chat.

From that moment the bot watches the applicant's own browser window, once a
minute for an hour, for the page the site draws when a payment goes through.
Seeing it, the bot opens the lookup itself and asks only for the captcha, so
the form and the receipt arrive as soon as they exist.

The after-the-application steps now live in `src/evisa-documents.mjs`, built
against the bot's own sessions and browsers, which keeps the runner within its
size limit.
