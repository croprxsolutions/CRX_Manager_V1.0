## 2026-11-24 - Check the owner hold before Claude merges

Claude’s guarded merge command now refuses a pull request whose title carries `[HOLD FOR MASON]`. The refusal occurs before the command claims the branch and reminds the lander to verify Mason’s approval against the current commit before clearing the marker.
