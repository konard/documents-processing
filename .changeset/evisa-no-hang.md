---
'documents-processing': patch
---

Never leave an applicant waiting on a step that has stalled.

A form was filled and then never sent: the log stopped at the fill, and the
chat waited seven hours with no message and no error. Every step that calls
out to something else can stall without ever failing — a browser that stops
answering `page.evaluate`, an upload that never completes — and none of them
had a deadline.

Each now has one. Telegram calls are given ninety seconds, so an upload that
stalls is abandoned rather than waited on. The measurements taken from the page
are given twenty, and the form is sent without them if the browser will not
answer. A picture that will not upload costs its own place and nothing more.
And a fill that has not finished in ten minutes is given up on, so the chat is
free for the next thing the applicant sends.

The timers behind all of this are cleared or unreferenced, so a step that
finished in time does not hold a process open waiting for its own deadline.
