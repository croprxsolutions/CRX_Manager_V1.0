## 2026-11-02 - Ship procedure spells out how to verify a deploy

`.claude/commands/ship.md` step 6 now spells out "verify the deploy". The steps are: wait for a new production bundle, force the signed-in tab past the service worker's old copy, exercise the change without saving anything, then check Sentry. Two Product Master landings on 2026-11-02 needed exactly these steps by hand.
