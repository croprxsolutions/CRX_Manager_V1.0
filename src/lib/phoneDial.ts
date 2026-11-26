/**
 * phoneDial — the tel: link for a phone number as typed on a customer.
 * An extension ("ext. 89", "x89") is dialed after a pause, never run into the number itself.
 */
const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*(\d+)\s*$/i;

export function phoneDialHref(phone: string): string {
  const match = phone.match(EXTENSION);
  const main = match ? phone.slice(0, match.index) : phone;
  const digits = main.replace(/\D/g, '');
  const plus = main.trim().startsWith('+') ? '+' : '';
  return `tel:${plus}${digits}${match ? `,${match[1]}` : ''}`;
}
