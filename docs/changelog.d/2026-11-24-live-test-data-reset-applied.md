## 2026-11-24 - Live test-data reset applied

- `20270301100000_live_test_data_reset` ran on live at 07:09:16 UTC (ledger `20261124070916`), with Taha's OK and Mason's approval of the counts. Its record now starts `APPLIED LIVE`.
- It cleared quotes and bookings, orders, deliveries, invoices, payments, prepay, commissions, purchasing, stock history, the field side and the app's backup snapshots. Stock and prepay are 0, and numbering restarts at 0001. Products, pricing, customers, vendors, users and settings are unchanged.
- The removed rows are kept in `reset_backup_20261123` until Mason confirms.
