## 2026-11-09 - Luna can be told which findings are already settled

`node scripts/luna-review.mjs --settled <file>` hands Luna a short list of findings an earlier round raised
and the author refuted or deferred, each with its reason. Luna gets it as untrusted data inside the trust
boundary, still reads the whole diff and echoes the tail canary, and re-reports a listed item only with new
evidence that it must name. On PR #1688 Luna re-raised one refuted finding in 4 of 8 rounds (retro item 1).
The file is capped at 8 KB and refused whole if larger or empty. Without the flag the prompt is
byte-identical to before. Sol never sees the list: `--settled` with `--sol` is refused, and the proof
wrapper, gates and pinned models are unchanged.
