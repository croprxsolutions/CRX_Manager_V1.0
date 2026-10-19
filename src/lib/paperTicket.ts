/**
 * Goal 5 paper fallback (Mason, 2026-10-15): with no signal at the customer, the
 * driver gets a paper delivery ticket signed on site. Back in signal, the driver
 * completes the delivery in the app with a photo of that signed ticket in place
 * of the on-screen signature. The app never captures a signature after the fact.
 *
 * The ticket photo is an ordinary delivery photo carrying this caption, so it is
 * stored, protected and shown exactly like every other delivery photo.
 */
import { todayInBusinessTz } from './dateUtils';

export const PAPER_TICKET_PHOTO_CAPTION = 'Signed paper delivery ticket';

// A paper-ticket delivery is completed later, once back in signal, so the driver
// records the day it really happened. That day becomes the delivery and invoice date.
// The ticket date is required on the paper path and can never be in the future.
// "Today" is the business day in America/Chicago, the day the server dates the delivery.
export function isValidPaperDeliveredOn(deliveredOn: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(deliveredOn) && deliveredOn <= todayInBusinessTz();
}

// The server takes the delivery and invoice date from the completion time in
// America/Chicago. 17:00 UTC is midday in Chicago (12:00 CDT, 11:00 CST), so the
// chosen YYYY-MM-DD lands on that same Chicago day whatever time zone the phone is set to.
export function completedAtForDeliveredOn(deliveredOn: string): string {
  return `${deliveredOn}T17:00:00.000Z`;
}

export function paperDeliveredAt(deliveredOn: string): string | undefined {
  if (!deliveredOn || deliveredOn === todayInBusinessTz()) return undefined;
  return completedAtForDeliveredOn(deliveredOn);
}

// Ticket photos do not count toward the 10-photo limit, so a delivery that already has
// 10 ordinary photos can still be completed on the paper-ticket path.
export const MAX_ORDINARY_DELIVERY_PHOTOS = 10;

export function countOrdinaryPhotos(photos: ReadonlyArray<{ caption?: string | null }>): number {
  return photos.filter((photo) => photo.caption !== PAPER_TICKET_PHOTO_CAPTION).length;
}

// Ticket photos are bounded on their own: a front and a back is enough.
export const MAX_PAPER_TICKET_PHOTOS = 2;

export function countPaperTicketPhotos(photos: ReadonlyArray<{ caption?: string | null }>): number {
  return photos.filter((photo) => photo.caption === PAPER_TICKET_PHOTO_CAPTION).length;
}

export function hasPaperTicketPhoto(photos: ReadonlyArray<{ caption?: string | null }>): boolean {
  return photos.some((photo) => photo.caption === PAPER_TICKET_PHOTO_CAPTION);
}
