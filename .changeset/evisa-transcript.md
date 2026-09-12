---
'documents-processing': minor
---

Keep a transcript of every conversation, both sides.

The debug log said what the bot did; it did not say what either party said, so
diagnosing a defect meant asking the applicant to describe what they had seen.
Every message is now written to `data/transcripts/chat-<id>.jsonl` as it
happens — what arrived, what went back, the buttons under it — and every file
an applicant sends is kept beside it under its own name, so a passport that
failed to read can be read again.

Both directions pass through one place each, an api transformer and a
middleware, so nothing said can go unrecorded by being sent from somewhere new.
The typing indicator is left out, being sent every three seconds and saying
nothing.

A transcript is the applicant's own passport, address and telephone number, so
it is written only when the log is keeping values, it is swept on the same
retention as everything else the bot keeps, and it stays out of the repository.
