import { ApplicatorPhoneContractPendingError } from './applicatorPhoneApi';
import type {
  ApplicatorLoadChoice,
  WorkEntrySegmentDraft,
} from './applicatorPhoneApi';

export interface SegmentInput {
  choiceIndex: string;
  acres: string;
}

export type ResourceState = 'loading' | 'ready' | 'pending' | 'failed';

export function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function centralSprayDate(dateTimeValue: string): string | null {
  if (!dateTimeValue) return null;
  const instant = new Date(dateTimeValue);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${month}/${day}/${year}` : date;
}

export function displayError(error: unknown, fallback: string): string {
  return error instanceof ApplicatorPhoneContractPendingError ? error.message : fallback;
}

export function errorState(error: unknown): ResourceState {
  return error instanceof ApplicatorPhoneContractPendingError ? 'pending' : 'failed';
}

export function helperFor(state: ResourceState, readyText: string, pendingText: string, failedText: string): string {
  if (state === 'ready') return readyText;
  if (state === 'pending') return pendingText;
  if (state === 'failed') return failedText;
  return 'Loading…';
}

export function formatSegmentAcres(segments: SegmentInput[]): string | null {
  const values = segments.map((segment) => Number(segment.acres)).filter((value) => Number.isFinite(value));
  if (values.length === 0 || values.length !== segments.length || segments.some((segment) => segment.acres.trim() === '')) return null;
  return values.reduce((sum, value) => sum + value, 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function areSegmentsReady(segments: SegmentInput[], loadChoices: ApplicatorLoadChoice[]): boolean {
  return segments.length > 0 && segments.every((segment) => {
    const choiceIndex = Number(segment.choiceIndex);
    return segment.choiceIndex !== '' && Number.isInteger(choiceIndex) && Boolean(loadChoices[choiceIndex]) && segment.acres.trim() !== '';
  });
}

export function getSegmentDrafts(segments: SegmentInput[], loadChoices: ApplicatorLoadChoice[]): WorkEntrySegmentDraft[] {
  return segments.flatMap((segment) => {
    const choiceIndex = Number(segment.choiceIndex);
    const choice = loadChoices[choiceIndex];
    return choice ? [{ loadId: choice.loadId, revisionId: choice.revisionId, acres: segment.acres }] : [];
  });
}
