## 2026-10-29 - Sol risk check reads the changed code, not just file names

- After the file names pass, the Sol risk check fetches the pull request's diff from GitHub and runs the push gate's money, permission and data-write content patterns over it. A match in any non-`.md` file means Sol is needed, whatever the file is called; a diff GitHub cannot return also means Sol is needed.
- Notes (`.md` files) are skipped by the content scan because plans mention prices and inventory without changing app behaviour; agent rule documents still need Sol by path.
