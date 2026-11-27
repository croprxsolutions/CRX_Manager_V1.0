**LOCAL CANDIDATE — NOT APPLIED.** `20270315180000_confirmed_program_acres.sql` (SQL sha256: `98a386491270691b57fbb279c34951350484769b22f77517536f9b8633b3c81d`). Updates the shared Today and Program Tracker report to count confirmed application acres and exclude removed plans.

The reader retains its existing signature, output and active office roles. Saved as-applied records provide acreage. Ticket processing and review do not establish application acreage. Roll back with a reviewed forward migration restoring the prior reader body from `20260728182141_secdef_pricing_reads_office_only.sql`.
