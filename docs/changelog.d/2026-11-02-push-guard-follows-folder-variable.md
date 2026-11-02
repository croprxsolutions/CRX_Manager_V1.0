## 2026-11-02 - Push guard follows a folder variable

`codex-push-guard.mjs` now reads `W="C:/repo"; git -C "$W" push` the same as `git -C "C:/repo" push`. Five harmless pushes were denied on 2026-11-02 because the guard took `$W` as a folder name. It only does this when the command's first statement sets the variable to a plain literal and nothing later changes it; reassigned, computed, unset or never-assigned variables, `cd` forms and GIT_DIR/GIT_WORK_TREE forms are still denied. Main-branch, proof and force-push checks are unchanged.
