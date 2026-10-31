## 2026-10-31 - Retire the old payment overload on record

- New migration `20261029160150_retire_allocate_payment_old_overload.sql` drops the February eight-argument `allocate_payment` overload if it exists. The migration reviewer's overload rule requires this because no migration on file removes it.
- A live read-only check on 2026-10-31 found only the ten-argument overload, so the migration changes nothing on production. The payment-date migration itself stays byte-identical.
- This branch also takes current main, so the final reviews cover the head that lands.
