import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ReportShell from './ReportShell';

describe('ReportShell', () => {
  it('renders children', () => {
    render(
      <ReportShell onDateChange={() => {}}>
        <div>Report Content</div>
      </ReportShell>
    );
    expect(screen.getByText('Report Content')).toBeInTheDocument();
  });

  it('renders date range controls by default', () => {
    render(
      <ReportShell onDateChange={() => {}}>
        <div>Content</div>
      </ReportShell>
    );
    expect(screen.getByLabelText('Report start date')).toBeInTheDocument();
    expect(screen.getByLabelText('Report end date')).toBeInTheDocument();
  });

  it('hides date range controls when showDateRange=false', () => {
    render(
      <ReportShell onDateChange={() => {}} showDateRange={false}>
        <div>Content</div>
      </ReportShell>
    );
    expect(screen.queryByLabelText('Report start date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Report end date')).not.toBeInTheDocument();
  });

  it('renders all 6 preset buttons', () => {
    render(
      <ReportShell onDateChange={() => {}}>
        <div>Content</div>
      </ReportShell>
    );
    expect(screen.getByText('All Time')).toBeInTheDocument();
    expect(screen.getByText('This Season')).toBeInTheDocument();
    expect(screen.getByText('Last Season')).toBeInTheDocument();
    expect(screen.getByText('YTD')).toBeInTheDocument();
    expect(screen.getByText('Last 30d')).toBeInTheDocument();
    expect(screen.getByText('Last 90d')).toBeInTheDocument();
  });

  it('calls onDateChange when start date changes', () => {
    const onDateChange = vi.fn();
    render(
      <ReportShell onDateChange={onDateChange}>
        <div>Content</div>
      </ReportShell>
    );

    fireEvent.change(screen.getByLabelText('Report start date'), {
      target: { value: '2025-07-01' },
    });
    expect(onDateChange).toHaveBeenCalledWith('2025-07-01', '');
  });

  it('calls onDateChange when end date changes', () => {
    const onDateChange = vi.fn();
    render(
      <ReportShell onDateChange={onDateChange}>
        <div>Content</div>
      </ReportShell>
    );

    fireEvent.change(screen.getByLabelText('Report end date'), {
      target: { value: '2026-06-30' },
    });
    expect(onDateChange).toHaveBeenCalledWith('', '2026-06-30');
  });

  it('calls onDateChange with empty strings when All Time preset is clicked', () => {
    const onDateChange = vi.fn();
    render(
      <ReportShell onDateChange={onDateChange}>
        <div>Content</div>
      </ReportShell>
    );

    fireEvent.click(screen.getByText('All Time'));
    expect(onDateChange).toHaveBeenCalledWith('', '');
  });

  it('calls onDateChange with season dates when This Season preset is clicked', () => {
    const onDateChange = vi.fn();
    render(
      <ReportShell onDateChange={onDateChange}>
        <div>Content</div>
      </ReportShell>
    );

    fireEvent.click(screen.getByText('This Season'));
    expect(onDateChange).toHaveBeenCalledTimes(1);

    const [start, end] = onDateChange.mock.calls[0];
    // Crop season is Oct-Sep, so start should be a Oct 1 and end a Sep 30
    expect(start).toMatch(/^\d{4}-10-01$/);
    expect(end).toMatch(/^\d{4}-09-30$/);
  });

  it('calls onDateChange with YTD dates by the Chicago date when YTD preset is clicked', () => {
    // Sep 30, 8:30 PM CDT = Oct 1 in UTC: both ends must stay in the season ending Sep 30 (KI-18).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T01:30:00Z'));
    try {
      const onDateChange = vi.fn();
      render(
        <ReportShell onDateChange={onDateChange}>
          <div>Content</div>
        </ReportShell>
      );

      fireEvent.click(screen.getByText('YTD'));
      expect(onDateChange).toHaveBeenCalledTimes(1);
      expect(onDateChange.mock.calls[0]).toEqual(['2025-10-01', '2026-09-30']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends Last 30d and Last 90d on the Chicago date in the evening (KI-18)', () => {
    // Sep 30, 9 PM CDT = Oct 1 in UTC
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T02:00:00Z'));
    try {
      const onDateChange = vi.fn();
      render(
        <ReportShell onDateChange={onDateChange}>
          <div>Content</div>
        </ReportShell>
      );
      fireEvent.click(screen.getByText('Last 30d'));
      fireEvent.click(screen.getByText('Last 90d'));
      expect(onDateChange.mock.calls).toEqual([
        ['2026-08-31', '2026-09-30'],
        ['2026-07-02', '2026-09-30'],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows CSV export button when onExportCSV is provided', () => {
    const onExportCSV = vi.fn();
    render(
      <ReportShell onDateChange={() => {}} onExportCSV={onExportCSV}>
        <div>Content</div>
      </ReportShell>
    );

    const csvBtn = screen.getByText('CSV');
    expect(csvBtn).toBeInTheDocument();
    fireEvent.click(csvBtn);
    expect(onExportCSV).toHaveBeenCalledTimes(1);
  });

  it('shows PDF export button when onExportPDF is provided', () => {
    const onExportPDF = vi.fn();
    render(
      <ReportShell onDateChange={() => {}} onExportPDF={onExportPDF}>
        <div>Content</div>
      </ReportShell>
    );

    const pdfBtn = screen.getByText('PDF');
    expect(pdfBtn).toBeInTheDocument();
    fireEvent.click(pdfBtn);
    expect(onExportPDF).toHaveBeenCalledTimes(1);
  });

  it('does not show CSV/PDF buttons when callbacks are not provided', () => {
    render(
      <ReportShell onDateChange={() => {}}>
        <div>Content</div>
      </ReportShell>
    );

    expect(screen.queryByText('CSV')).not.toBeInTheDocument();
    expect(screen.queryByText('PDF')).not.toBeInTheDocument();
  });

  it('renders extraControls when provided', () => {
    render(
      <ReportShell
        onDateChange={() => {}}
        extraControls={<button>Custom Filter</button>}
      >
        <div>Content</div>
      </ReportShell>
    );

    expect(screen.getByText('Custom Filter')).toBeInTheDocument();
  });
});
