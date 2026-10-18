/**
 * Goal 5 paper fallback (Mason, 2026-10-15): with no signal at the customer, the
 * driver gets a paper delivery ticket signed on site. Back in signal, the driver
 * completes the delivery in the app with a photo of that signed ticket in place
 * of the on-screen signature. The app never captures a signature after the fact.
 *
 * The ticket photo is an ordinary delivery photo carrying this caption, so it is
 * stored, protected and shown exactly like every other delivery photo.
 */
export const PAPER_TICKET_PHOTO_CAPTION = 'Signed paper delivery ticket';

export function hasPaperTicketPhoto(photos: ReadonlyArray<{ caption?: string | null }>): boolean {
  return photos.some((photo) => photo.caption === PAPER_TICKET_PHOTO_CAPTION);
}
