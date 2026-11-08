// Completion toast when a receipt was asked for but the customer has no email on file. Since KI-25 the receipt
// itself is recorded with the completion and emailed by the server (send-delivery-receipts); a receipt with no
// address goes to the office's Receipts to check list instead.
export const RECEIPT_NO_EMAIL_ON_FILE_MESSAGE = 'No customer email on file, so no receipt was sent. It is on the office list to follow up.';
