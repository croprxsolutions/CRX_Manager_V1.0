## 2026-10-31 - Preserve document number digits

- The unapplied Chicago-year candidate keeps all digits after 9,999 for quote, order and rebate-claim numbers, while allocating each sequence value only once.
- The rebate claim table sorts claim numbers in numeric order across that boundary.
- If a new quote's number cannot be allocated, Quote Builder offers Retry quote number, which keeps the entered details instead of needing a page refresh.
- The disposable database proof covers 9,999, 10,000 and 10,001 for all three document types. Production is unchanged until the migration passes its release gates and is applied.
