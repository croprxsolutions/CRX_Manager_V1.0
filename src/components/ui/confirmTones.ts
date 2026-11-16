import { AlertTriangle, Trash2, ClipboardCheck, type LucideIcon } from 'lucide-react';

/** The three confirm tones ConfirmModal and ReasonModal share. */
export type ConfirmTone = 'danger' | 'warning' | 'info';

export const toneIconStyles: Record<ConfirmTone, string> = {
  danger: 'bg-red-50 text-red-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-crx-green-light text-crx-green',
};

export const toneIcons: Record<ConfirmTone, LucideIcon> = {
  danger: Trash2,
  warning: AlertTriangle,
  info: ClipboardCheck,
};

// Warnings keep a red main button (Taha, 2026-11-11): many warning confirms cancel, reject or
// discard (Cancel Order, Discard edits, Reject). Only info confirms go green.
export const toneButton = (tone: ConfirmTone): 'danger' | 'primary' => (tone === 'info' ? 'primary' : 'danger');
