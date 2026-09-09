---
'documents-processing': minor
---

Read a passport without opening a browser.

`--ocr` was a modifier, not a mode: a run given it read the passport and then
went on to open a browser on the application form, which is a surprise when
the reading was the whole request. It now reads and reports, and `--fill` is
what asks for the browser. `--read-only` says the same thing explicitly, and
an ordinary fill is unaffected.
