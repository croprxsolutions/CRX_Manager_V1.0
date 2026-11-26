**LOCAL CANDIDATE — NOT APPLIED.** `20270311190000_dispatch_removal_notice_keeps_held_job.sql` (SQL sha256: `4e3b86b912b923fed893dcbddf5a8942810c5f404bcdc66528760b0ae95e9b2a`) stops the Board telling an applicator a whole job was removed when they still hold another dispatched location on it.

`dispatch_location_with_notices` keeps its arguments, grants, search path, replay fingerprints and receipts. The removal notice now goes only when the outgoing applicator holds no other dispatched location on that job. It closes Taha's LOW 1 on PR #2672 and must be on staging before #2672 merges.

The registered local Docker smoke chain (`smoke-dispatch-location-notices.sql`) covers both cases on reassign and removal: an applicator who keeps another location gets no removal notice, and one who loses their last location gets it.

Roll back by restoring the function body from `20270310180000_dispatch_location_notices.sql` in a reviewed migration.
