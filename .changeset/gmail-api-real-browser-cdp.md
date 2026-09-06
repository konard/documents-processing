---
'documents-processing': minor
---

Add Gmail API setup driven through real Chrome over CDP, with fully scripted OAuth consent and no manual clicks. Emails are now deduped by RFC `Message-ID` instead of content hash, repeated macOS Keychain prompts are fixed, and email PDFs render on a single page by growing the page rather than clipping content. Adds an FRRO-exhibit builder.
