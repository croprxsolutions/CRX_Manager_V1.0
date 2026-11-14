// Completion toast when a receipt was asked for but the customer has no email on file. Since KI-25 the receipt
// itself is recorded with the completion and emailed by the server (send-delivery-receipts); a receipt with no
// address goes to the office's Receipts to check list instead.
// Shown whenever this screen sees no address: its customer data can be hidden or stale, so it says what it saw.
export const RECEIPT_NO_EMAIL_ON_FILE_MESSAGE = 'No customer email was found here. If none is on file, no receipt is sent and it goes on the office list to follow up.';

// An earlier attempt completed the delivery; a receipt it asked for was recorded with it and the server sends it.
export const RECEIPT_COMPLETED_BY_EARLIER_ATTEMPT_MESSAGE =
  'This delivery is completed (an earlier attempt went through). If that attempt asked for a receipt, the server sends it; check "Customer receipts to check" before using Email Confirmation.';
