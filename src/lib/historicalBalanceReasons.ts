// Why a balance report (AR Aging, Customer Balance Listing) cannot show a customer as of a past
// date: the reason codes the database returns in unavailable_reason (KI-95), in plain words.
const UNAVAILABLE_REASONS: Record<string, string> = {
  HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE: 'a payment, prepay or write-off was entered after this date',
  HISTORICAL_VOID_RECONSTRUCTION_UNAVAILABLE: 'an invoice was voided after this date',
  HISTORICAL_UNPOST_RECONSTRUCTION_UNAVAILABLE: 'an invoice was unposted after this date',
  HISTORICAL_POSTING_RECONSTRUCTION_UNAVAILABLE: "an invoice's posting history has two changes recorded at the same moment",
};

export function unavailableReasonText(code: string | null | undefined): string {
  return UNAVAILABLE_REASONS[code ?? ''] ?? 'later activity changed this balance';
}
