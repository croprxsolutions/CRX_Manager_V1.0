# Excess-quantity receiving notices

Add database support for Purchase Order Detail. An authorized receipt that takes a line above its ordered quantity creates an alert for active admins. The signed-in receiver remains the sender. The message uses the recorded receipt quantity and the purchase-order line's ordered and previously received totals. Current damage alerts, other receiving screens, receipt reversal and broad Notification permissions keep their existing paths.

Use the existing receive operation and the same durable key and input fingerprint. A fresh call runs that operation first, then works from the returned receiving records while the existing locks are still held. A repeated line is evaluated at each saved row in submission order. A retry returns the original result without moving stock or sending a second notice. Sales reps can still receive normal quantities and cannot override the ordered quantity.

Handle a notice insertion error separately and write a failed-notice record where possible. A cancelled database statement rolls back the receipt and the notice together. Deploy the database operation before switching the one screen. Revert that screen before retiring the operation.

Prove the saved receipt, exact stock, recipient, signed-in sender, ordinary receipts, repeat lines, denied over-receipts, old and new receipt-key compatibility, failure logging, and notice count in local Docker with invented data. Prove the old app replay through its existing pending receipt and confirm reversal still works.
