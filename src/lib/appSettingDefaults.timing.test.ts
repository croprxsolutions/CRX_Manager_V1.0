import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMING_WINDOWS, parseTimingWindows, timingWindowStart } from './appSettingDefaults';

describe('booking timing windows', () => {
  it('falls back per timing on bad settings', () => {
    expect(parseTimingWindows(null)).toEqual(DEFAULT_TIMING_WINDOWS);
    expect(parseTimingWindows('not json')).toEqual(DEFAULT_TIMING_WINDOWS);
    const w = parseTimingWindows('{"pre_plant":{"start":"02-15","end":"05-01"},"in_season":{"start":"02-30","end":"07-15"}}');
    expect(w.pre_plant).toEqual({ start: '02-15', end: '05-01' });
    expect(w.in_season).toEqual(DEFAULT_TIMING_WINDOWS.in_season);
    expect(w.late_summer).toEqual(DEFAULT_TIMING_WINDOWS.late_summer);
  });

  it('fills the next window start, or today when today is inside a window (A-R1; never a past date)', () => {
    const w = DEFAULT_TIMING_WINDOWS;
    expect(timingWindowStart(w, 'pre_plant', '2027-02-01')).toBe('2027-03-01');
    expect(timingWindowStart(w, 'pre_plant', '2027-04-10')).toBe('2027-04-10');
    expect(timingWindowStart(w, 'pre_plant', '2027-05-15')).toBe('2027-05-15');
    expect(timingWindowStart(w, 'pre_plant', '2027-03-01')).toBe('2027-03-01');
    expect(timingWindowStart(w, 'pre_plant', '2027-05-16')).toBe('2028-03-01');
    expect(timingWindowStart(w, 'late_summer', '2027-11-01')).toBe('2028-07-16');
  });

  it('handles a window that runs into the next year', () => {
    const w = { ...DEFAULT_TIMING_WINDOWS, pre_plant: { start: '11-01', end: '02-15' } };
    expect(timingWindowStart(w, 'pre_plant', '2027-01-20')).toBe('2027-01-20');
    expect(timingWindowStart(w, 'pre_plant', '2027-03-01')).toBe('2027-11-01');
  });
});
