---
'documents-processing': minor
---

One fill for everything an applicant sends, however they send it.

Forwarding documents lands them all in the same second, and the timer that
grouped them could be defeated in two ways: a message arriving during a fill
started a second fill beside the first, typing into a page already being typed
into; and a reading still running when the window passed let the form go up
without the passport on it.

`src/evisa-batch.mjs` replaces the timer with one runner per chat. Work
arriving pushes the quiet window out and starts that runner if it is not going;
the runner waits for the window to pass with nothing new arrived and nothing
still being read, then fills, once. A fill is never started while one is
running, and anything that lands during a fill gets a window of its own
afterwards, so nothing an applicant sends is lost and nothing is filled twice.

Documents are still read as they arrive, each on its own worker, so a batch
takes as long as its slowest reading. Tests cover a forwarded batch of ten, a
reading that fails, a fill that throws, two chats at once, a stopped chat, and
a message landing mid-fill.
