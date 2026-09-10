---
'documents-processing': patch
---

Wait for the form to be ready, and make the wait legible.

A capture taken while the site was still checking a field showed a red border
against a value the site went on to accept: the applicant saw an error that was
not there in their own browser. Settling now waits for the form's checks to
finish, and counts the errors showing as part of the page, so a page that is
about to clear one is not yet settled.

The site's navigation sticks to the top of the window, and a full-page capture
draws it again at every scroll position, so it landed in the middle of the
occupation section. Anything that follows the window is held still for the
capture and released after it.

`/visa` answers at once. The checklist is built from the fields the form is
known to require, and the browser opens behind that reply, which is also read
for anything the form has started asking for since. The window opens behind
whatever the applicant is doing and comes forward when the form is filled, not
before.

The typing indicator now starts when the fill starts. While the quiet window is
open the applicant is still sending, and a bot that appears to be typing the
whole time says nothing about when it began.

Section headings are sent as their own message before each picture, in the
applicant's language: Telegram draws a caption under a picture, and the site
writes its headings in English whatever language it is showing.

What arrives during a fill is put on the form before the result is sent, twice
at most, so a correction reaches the same form the applicant is about to read.
