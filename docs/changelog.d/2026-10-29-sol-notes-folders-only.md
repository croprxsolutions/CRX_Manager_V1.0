## 2026-10-29 - Only the notes folders skip Sol

- Sol found that "any `.md` file is a note" let rule-bearing documents (for example the SQL security patterns in `docs/reference/`) merge without review. Only `.md` files in the documentation exemption's notes folders (plans, manual, changelog, reports, audits, handoffs, research) now count as notes; every other file needs Sol.
- An earlier Sol proof covers later commits only when those commits stay inside the notes folders.
