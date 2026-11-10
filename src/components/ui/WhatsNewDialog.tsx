import { useState } from 'react';
import Modal from './Modal';
import Button from './Button';
import { releaseNotes, type ReleaseNotes } from '../../releaseNotes';

// Remembered per user and per browser: someone on two devices sees a release's notes twice.
export const seenKey = (userId: string) => `crx.whatsNew.seen.${userId}`;

function readSeen(userId: string): string | null {
  try {
    return localStorage.getItem(seenKey(userId));
  } catch {
    return null;
  }
}

/** "What's new" after a release: the release's user-facing lines, shown once per version per user. */
export default function WhatsNewDialog({ userId, notes = releaseNotes }: { userId: string | null; notes?: ReleaseNotes }) {
  // Closed for this user and version only: another user signing in on the same tab still sees it.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const showKey = `${userId}:${notes.version}`;
  const open = closedFor !== showKey && !!userId && notes.items.length > 0 && readSeen(userId) !== notes.version;

  const close = () => {
    setClosedFor(showKey);
    try {
      if (userId) localStorage.setItem(seenKey(userId), notes.version);
    } catch {
      // Private mode: it shows again next time, which is harmless.
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="What's new"
      accent={`in v${notes.version}`}
      footer={
        <div className="flex justify-end">
          <Button variant="primary" onClick={close} className="min-h-11 w-full sm:w-auto">
            Got it
          </Button>
        </div>
      }
    >
      <ul className="list-disc space-y-2 pl-5 text-sm text-secondary">
        {notes.items.map((item, i) => (
          <li key={`${i}-${item}`}>{item}</li>
        ))}
      </ul>
    </Modal>
  );
}
