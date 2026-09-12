---
'documents-processing': patch
---

Never fill or send the form twice over the same thing.

A field the site refuses stays refused, so filling the form again over it
produced the same form with the same failure, again and again. Nothing now
repeats itself:

- A fill that wrote what the fill before it wrote, and failed on the same
  fields, is not sent. The applicant is told which field will not take its
  value, once, and nothing further happens until they answer.
- An empty review page is no longer answered by filling the form again. The
  site's fetch fails now and then; the form as the applicant left it is still
  in the browser, and they are told that rather than having a guess filled in
  on their behalf.
- Anything the applicant sends clears both, so a correction is filled and
  shown as it always was.

Filling still starts from one place only: the quiet timer, armed when a
message or a document arrives.
