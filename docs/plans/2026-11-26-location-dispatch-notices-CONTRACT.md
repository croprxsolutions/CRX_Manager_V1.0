# Database-owned location dispatch notices

Keep the existing office-only dispatch and removal behavior. Move the Wizard and Board notices for saved location changes into an additive database operation. The caller supplies the real dispatch inputs and the screen mode. The operation derives the recipient, sender and message from the signed-in actor, current job and saved dispatch. Crews receive no notice. Automated status changes and whole-job actions use their current paths.

- The Wizard groups the incoming notice by applicator and job, even on a takeover. It sends no notice to the previous applicator.
- A Board reassignment covers one location and sends an incoming notice for a changed applicator plus a removal for any different outgoing applicator with an active prior dispatch. A same-assignee retry with a fresh key sends no notice.
- A Board removal covers one location and notifies the previous applicator only if an active dispatch actually becomes cancelled.
- A notice failure leaves the dispatch saved and records the failed send where possible. The signed-in dispatcher remains the sender.

Check role and the original actor-bound receipt before locking. A key identifies the assignment change across both screens and the existing operations. The first committed call determines the notices. A retry from another screen or an older client returns the saved result and sends nothing. A fresh call locks the affected jobs and checks field membership, locks active incoming recipients and covers concurrent deletion of outgoing recipients, then locks and reads the existing dispatch rows. The existing dispatch operations apply their own validation and store the result.

Existing clients keep their current operations and notifications during staging and release. Deploy the new operation before switching the two location dispatch clients. Restore the old app before removing the new operation if rollback is needed. Wider notification permissions and whole-job notification delivery need separate changes.

Proof runs on a local walkthrough with invented data. When role, mode or request state differs, verify saved assignment, sender, recipient and count. When a replay crosses the old and new operation, verify there is no second notice. When deactivation and dispatch compete, verify both orders using two sessions. When a send fails, verify the dispatch and failure record.
