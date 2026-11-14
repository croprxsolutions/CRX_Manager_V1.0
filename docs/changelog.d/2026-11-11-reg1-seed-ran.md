## 2026-11-11 — REG-1: EPA registrations switched on (one-time setup ran)

- Mason ran the one-time setup from the admin EPA Registration Setup page (#1768) at about 9:14 AM Central, after
  the capture-link fix (`20270102160000`, #1774) was live. No SQL or service-role run.
- Live check right after (read-only): 347 EPA registrations; 28 invoice lines captured (every line with a product);
  the seed run row records restricted-use default `no` (Mason's Q1 answer); "Sales to check" is empty.
- One captured line is on a draft invoice whose product is marked restricted use but has no EPA number: add the
  number on the product before that invoice is posted.
- The setup cannot run again. Label facts on registered products are now edited on the registration.
- Unblocked: Brand PR B step B-1b and USE-2 (both waited for the seed). DM-4 still waits for the DATA-2 review.
