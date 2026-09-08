---
'documents-processing': minor
---

Fetch a filed application's documents, and draft the pre-arrival declaration.

`/documents <number>` looks an application up on the site's own search page and
sends back what it offers: the filled form, the payment receipt, and the visa
after a grant. The page asks for the number, the email and the date of birth,
all of which the chat already holds, so the captcha is the only thing a person
supplies; a wrong code is met with a fresh picture, as on the application form.
The status is reported in words that say whether to keep waiting.

`/arrival` drafts the declaration filed at prearrival.immigration.gov.vn just
before flying. Most of it the visa application already answered, so
`src/evisa-prearrival.mjs` maps each field to where its value comes from and
names what is left: the flight, the stay, and the visa's own details, which
exist only after a grant. That site gates its form behind a captcha before any
field is drawn, so driving it waits until a real declaration can be filed.

The bot now opens on a menu naming its three ways in, with buttons for the
language. A language the applicant picks stays picked: reading it afresh from
every message turned a Russian chat to English on a captcha code, which is
digits and says nothing about the language its writer speaks.
