---
'documents-processing': patch
---

Fill once when several messages arrive together, and show the form as one
readable run.

The loop had a single cause, visible in the log as `sent the form` followed by
`filling with` in the same second: fills are queued on a promise chain, and a
quiet timer that fires while a fill is running adds another to that chain.
Three messages sent together — a passport, a booking and the details — each
armed a timer, and the passport took forty seconds to read, so all three
timers fired mid-fill and three forms were filled and sent for one set of
documents. A fill asked for while one is already queued now joins that one,
since both would read the same data. Every fill also says in the log what
asked for it, so a stray one can be traced to its cause.

What the applicant is sent changed with it:

- The sections come first, one message each, and the whole page follows as the
  file to keep. Reading the chat downwards is now reading the form downwards.
- The site's banner and its ministry footer are left off, since neither holds
  anything to check; the form's own band is measured from the page.
- The declaration checkbox and the Cancel and Next buttons stay with the last
  section, which is where the applicant is about to act.
- An address read off a booking is no longer announced on its own. The summary
  under the form already lists every value that went on it.
