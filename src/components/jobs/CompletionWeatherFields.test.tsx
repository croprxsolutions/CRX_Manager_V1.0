import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

const H = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as unknown,
  reads: [] as { table: string; calls: string[] }[],
  toast: vi.fn(),
}));

function query(table: string) {
  const read = { table, calls: [] as string[] };
  H.reads.push(read);
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'in', 'gte', 'or', 'order', 'limit']) {
    q[m] = (...args: unknown[]) => { read.calls.push(`${m} ${JSON.stringify(args)}`); return q; };
  }
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(
    H.error ? { data: null, error: H.error } : { data: H.rows, error: null },
  ).then(resolve);
  return q;
}

vi.mock('../../lib/db', () => ({ supabase: { from: (table: string) => query(table) } }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));

import CompletionWeatherFields, { type WeatherValues } from './CompletionWeatherFields';

const OTHER_JOBS = [{ job_id: 'job-a', job_number: 'J-100' }, { job_id: 'job-b', job_number: 'J-101' }];

function Harness({ initial, otherJobs = OTHER_JOBS }: { initial?: Partial<WeatherValues>; otherJobs?: typeof OTHER_JOBS }) {
  const [value, setValue] = useState<WeatherValues>({
    wind_speed: '', wind_direction: '', temperature: '', humidity: '', ...initial,
  });
  return (
    <>
      <CompletionWeatherFields value={value} onChange={(p) => setValue((v) => ({ ...v, ...p }))} otherJobs={otherJobs} />
      <output data-testid="saved">{JSON.stringify(value)}</output>
    </>
  );
}

const saved = () => JSON.parse(screen.getByTestId('saved').textContent || '{}') as WeatherValues;

describe('CompletionWeatherFields', () => {
  beforeEach(() => {
    H.rows = [];
    H.error = null;
    H.reads = [];
    H.toast.mockReset();
  });

  it('opens the number pad for wind speed, temperature and humidity', () => {
    render(<Harness />);
    for (const label of ['Wind Speed (mph)', 'Temperature (°F)', 'Humidity (%)']) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('inputMode', 'decimal');
      expect(input).toHaveAttribute('type', 'number');
    }
  });

  it('a compass tap writes the same short string the typed box did, and typing still works', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'NW' }));
    expect(saved().wind_direction).toBe('NW');
    expect(screen.getByRole('button', { name: 'NW' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByLabelText('Wind direction (type another)'), { target: { value: 'NNW' } });
    expect(saved().wind_direction).toBe('NNW');
    expect(screen.getByRole('button', { name: 'NW' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('never reads or fills last weather until the button is tapped', async () => {
    H.rows = [{ job_id: 'job-a', wind_speed: 7, wind_direction: 'SW', temperature: 68, humidity: 55, updated_at: '2026-11-24T15:00:00Z' }];
    render(<Harness />);
    await Promise.resolve();
    expect(H.reads).toHaveLength(0);
    expect(saved()).toEqual({ wind_speed: '', wind_direction: '', temperature: '', humidity: '' });
  });

  it('fills from the newest weather saved today on the other jobs when tapped, leaving it editable', async () => {
    H.rows = [{ job_id: 'job-a', wind_speed: 7, wind_direction: 'SW', temperature: 68.5, humidity: null, updated_at: '2026-11-24T15:00:00Z' }];
    render(<Harness initial={{ humidity: '60' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use last weather' }));
    await waitFor(() => expect(saved().wind_speed).toBe('7'));
    // A blank on the earlier job never wipes what was typed here.
    expect(saved()).toEqual({ wind_speed: '7', wind_direction: 'SW', temperature: '68.5', humidity: '60' });
    expect(H.reads).toHaveLength(1);
    expect(H.reads[0].table).toBe('job_applied_info');
    expect(H.reads[0].calls).toContain('in ["job_id",["job-a","job-b"]]');
    expect(H.reads[0].calls.some((c) => c.startsWith('gte ["updated_at",'))).toBe(true);
    expect(H.toast).toHaveBeenCalledWith('info', expect.stringContaining('Filled from J-100'));

    fireEvent.change(screen.getByLabelText('Wind Speed (mph)'), { target: { value: '9' } });
    expect(saved().wind_speed).toBe('9');
  });

  it('says so and changes nothing when no weather was saved today', async () => {
    render(<Harness initial={{ wind_speed: '5' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use last weather' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('info', 'No weather saved on your jobs today yet.'));
    expect(saved().wind_speed).toBe('5');
  });

  it('reports a failed read and changes nothing', async () => {
    H.error = new Error('boom');
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Use last weather' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining("Couldn't load")));
    expect(saved().wind_speed).toBe('');
  });

  it('hides the button when there are no other jobs to copy from', () => {
    render(<Harness otherJobs={[]} />);
    expect(screen.queryByRole('button', { name: 'Use last weather' })).not.toBeInTheDocument();
  });
});
