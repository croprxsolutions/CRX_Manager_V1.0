## 2026-10-29 - Sol on every code change; notes skip it

- Sol's reviews showed that guessing which code is safe, from file names or changed text, kept missing real risks (a unit helper, data sent to an outside site). Mason chose structure over a perfect rule: any change to code, configuration or assets needs Sol, once, before the PR.
- A pull request of notes (`.md` files outside the agent rule documents) under 500 changed lines merges on green checks without Sol. The name lists and the diff-content scan added earlier today are removed, along with the accepted-residual-risk note they needed.
- An earlier Sol proof still covers later commits only when those commits are notes only. A pull request with a migration needs Sol of its exact head, because the migration apply gate binds the proof to the head.
