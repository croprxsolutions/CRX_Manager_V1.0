## 2026-11-21 - Order totals must be a real number under the report limit

- New migration `20270208100000_orders_total_price_finite.sql` adds a database check so an order's booked total is always a real number in whole cents below 1e15, the limit the profit reports already use. The existing check (total at or above $0) let NaN, Infinity and absurdly large totals through.
- Why: Sol's review of release #2189 found that the new profit-report commission split (`20270206110000`) treats such a total as unknown and counts the whole commission on the first partial invoice; Sol's second round added whole cents, since a part-cent total also skews that split. Every writer sums order lines that are already whole cents. No live or staging order has such a value today; the check keeps it that way.
