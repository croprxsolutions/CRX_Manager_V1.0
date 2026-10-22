import { describe, it, expect } from 'vitest';
import {
  countLeftAtSitePhotos, countOrdinaryPhotos, countPaperTicketPhotos, hasLeftAtSitePhoto, hasPaperTicketPhoto,
  LEFT_AT_SITE_PHOTO_CAPTION, PAPER_TICKET_PHOTO_CAPTION,
} from './paperTicket';
import { latestEvidencePhoto, signatureImagePathFor } from './deliveryEvidence';
import { sanitizeError } from './errorSanitizer';

// The captions and the signature path must match complete_delivery's evidence check
// (migration 20261022010000) exactly, or every photo or signature completion is refused.
describe('Goal 5 completion evidence', () => {
  it('uses the exact captions and the per-attempt signature path the server recomputes', async () => {
    expect(PAPER_TICKET_PHOTO_CAPTION).toBe('Signed paper delivery ticket');
    expect(LEFT_AT_SITE_PHOTO_CAPTION).toBe('Left at site — drop location');
    // left(encode(sha256(convert_to('abc', 'UTF8')), 'hex'), 32) in PostgreSQL.
    expect(await signatureImagePathFor('d-1', 'abc')).toBe('signatures/d-1/ba7816bf8f01cfea414140de5dae2223.png');
    expect(await signatureImagePathFor('d-1', 'abc:complete')).not.toBe(await signatureImagePathFor('d-1', 'abc'));
  });

  it('sends the newest saved photo with the caption', () => {
    const photos = [
      { id: 'a', caption: PAPER_TICKET_PHOTO_CAPTION }, { id: 'b', caption: null }, { id: 'c', caption: PAPER_TICKET_PHOTO_CAPTION },
    ];
    expect(latestEvidencePhoto(photos, PAPER_TICKET_PHOTO_CAPTION)?.id).toBe('c');
    expect(latestEvidencePhoto(photos, LEFT_AT_SITE_PHOTO_CAPTION)).toBeUndefined();
  });

  it('counts evidence photos apart from the 10 ordinary photos', () => {
    const photos = [
      { caption: null }, { caption: 'Pallet by the shed' },
      { caption: PAPER_TICKET_PHOTO_CAPTION }, { caption: LEFT_AT_SITE_PHOTO_CAPTION }, { caption: LEFT_AT_SITE_PHOTO_CAPTION },
    ];
    expect(countOrdinaryPhotos(photos)).toBe(2);
    expect(countPaperTicketPhotos(photos)).toBe(1);
    expect(countLeftAtSitePhotos(photos)).toBe(2);
    expect(hasPaperTicketPhoto(photos)).toBe(true);
    expect(hasLeftAtSitePhoto([{ caption: PAPER_TICKET_PHOTO_CAPTION }])).toBe(false);
  });

  it('explains each server refusal in plain English', () => {
    for (const code of ['SIGNATURE_IMAGE_MISSING', 'PAPER_TICKET_PHOTO_MISSING', 'LEFT_AT_SITE_PHOTO_MISSING']) {
      const message = sanitizeError({ code: '23514', message: `${code}: detail` });
      expect(message).toMatch(/^The delivery was not completed \(no stock or invoice change\)/);
      expect(message).not.toContain(code);
    }
    // An old app may be retrying a completion that already went through: never claim nothing happened.
    const outdated = sanitizeError({ code: '22023', message: 'COMPLETION_EVIDENCE_REQUIRED: detail' });
    expect(outdated).toMatch(/check whether it is already completed/);
    expect(outdated).not.toMatch(/nothing was saved/i);
  });
});
