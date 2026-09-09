---
'documents-processing': patch
---

Keep the log beside the application, and sweep every working directory.

The log was written under the system's temporary directory, which macOS empties
on a schedule and a container loses altogether. It now lives beside the
application, where it survives a restart and the days it takes for a defect to
be noticed. `EVISA_BOT_LOG` still overrides it, and a tree that cannot be
written to falls back to the old place.

The sweep that clears kept documents named four directory prefixes out of the
eleven the tool creates, so working directories from cropping, slicing, OCR and
the captured steps were never removed: 426 of them had accumulated on one
machine, holding pages of passports. Every prefix is now named, and the test
that guards the sweep checks each one rather than the old pattern.

A fill that had to write a field twice now logs which fields, so a control that
empties itself after being set can be recognised from the log alone.
