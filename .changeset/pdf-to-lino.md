---
'documents-processing': minor
---

Read a text-bearing PDF back into links notation with `pdf-to-lino`.

The Vietnam e-visa site hands back the finished application as a PDF, and that
PDF is the only record of what was actually submitted. `src/pdf-to-lino.mjs`
reads one into a record whose keys match the applicant schema the rest of the
toolkit uses, so a submitted form can be diffed against the passport and the
data it was built from.

The form is printed in two columns, which `pdftotext -layout` preserves with
padding. Each value is therefore read from its own label to where the next
label on that line begins, so the right-hand column never joins the left-hand
value, and a value long enough to wrap is followed onto the lines below at its
own indent. Both border gates are separated even when a single space stands
between the left value and the right label.

An unfamiliar document is read with `--form auto`, which takes every
`Label: value` pair the page holds and drops any section numbering from the
key. A PDF with no text in it is a scan, and that is reported as an error
naming OCR as the tool for it.
