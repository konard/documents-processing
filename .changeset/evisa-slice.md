---
'documents-processing': minor
---

Send the filled form as readable sections beside the full page.

The application runs to some nine screens, and the capture of it is one image
thousands of pixels tall. Telegram scales such an image down to fit a message,
which leaves the text too small to check. `src/evisa-slice.mjs` cuts the page
into sections, binds them into a PDF a page each, and sends that PDF with the
same sections beside it as pictures, in albums of ten.

Cuts are placed in the blank bands between rows, found from the page's own
vertical profile, so a section never starts or ends across a line of text or
between a label and its value. Each section is held between roughly half and
one and a half times the page's width: tall enough to carry several fields, and
short enough to read on a phone. A stretch of page with no gap in it is cut at
the height limit. Paging the PDF at those same cuts keeps every field whole on
its page. A capture that cannot be cut is still sent, as the image itself.
