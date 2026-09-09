---
'documents-processing': minor
---

Remember an applicant's language and their application between runs.

A language chosen with the buttons lived only in memory, so `/start` — which
clears the session — answered in whatever language Telegram guessed, and a
restart of the bot lost it too. It is now kept in an associative store beside
the application, in the two layers of the associative stack:

- **Links Notation** is the durable form on disk, `data/chats.lino`, a file
  anybody can read, diff and repair by hand: `(chat 42 (language ru))`.
- **Doublets** is the binary link store, built from that notation on load,
  where each word is a point and each fact a link joining a property to its
  value.

Both layers are written together and the file is replaced atomically, so a bot
killed mid-write leaves the previous file whole, and a file that will not parse
is passed over rather than costing an applicant their conversation.

The application number the site returns on registration is kept the same way,
so `/documents` still needs no argument after a restart. `/reset` forgets a
chat in the store as well as in memory, and the file holds chat ids and
application numbers, so it stays out of the repository.
