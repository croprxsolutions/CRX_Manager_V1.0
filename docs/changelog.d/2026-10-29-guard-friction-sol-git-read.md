## 2026-10-29 - Plain-read shortcut no longer vouches for git

- **Agent guards (Sol, PR #1193).** The new rule that lets a plain double-quoted read of a guard file through without a warning now leaves `git` out, alongside `node`, `gh` and `find`, because a git setting given on the command line can start another program. Such git commands fall back to the older, stricter reading.
