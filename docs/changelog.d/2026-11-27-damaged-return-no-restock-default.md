## 2026-11-27 — A damaged or opened return line no longer defaults to Restock (decision 17)

- New Return screen: choosing the condition Damaged or Opened on a line clears its Restock tick, so damaged goods don't go back to stock by default. Staff can tick it again. Unopened and Expired leave the tick as it is. Screen only: the server already treats a missing tick as "don't restock", and receive restocks only ticked lines, so no migration (Mason's decision 17, 25 Nov).
- Test: `src/pages/Returns.race.test.tsx` ("clears the restock tick when a line is marked Damaged or Opened").
