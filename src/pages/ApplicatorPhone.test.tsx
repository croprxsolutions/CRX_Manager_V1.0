import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../components/ui/Toast';
import ApplicatorPhone from './ApplicatorPhone';

const mocks = vi.hoisted(() => ({
  ContractPendingError: class extends Error {
    todo: string;
    constructor(todo: string, action: string) {
      super(`${action} is waiting for the field-application database contract. Nothing was saved.`);
      this.todo = todo;
    }
  },
  loadApplicatorPhoneJobs: vi.fn(),
  loadApplicatorWorkEntries: vi.fn(),
  loadApplicatorLoadChoices: vi.fn(),
  loadRestrictedUseFieldDefinitions: vi.fn(),
  loadNextLoadProposal: vi.fn(),
  saveApplicatorWorkEntry: vi.fn(),
  markApplicatorJobDone: vi.fn(),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'applicator-1' }, role: 'applicator' }),
}));

vi.mock('../components/field-app/applicatorPhoneApi', () => ({
  ApplicatorPhoneContractPendingError: mocks.ContractPendingError,
  loadApplicatorPhoneJobs: mocks.loadApplicatorPhoneJobs,
  loadApplicatorWorkEntries: mocks.loadApplicatorWorkEntries,
  loadApplicatorLoadChoices: mocks.loadApplicatorLoadChoices,
  loadRestrictedUseFieldDefinitions: mocks.loadRestrictedUseFieldDefinitions,
  loadNextLoadProposal: mocks.loadNextLoadProposal,
  saveApplicatorWorkEntry: mocks.saveApplicatorWorkEntry,
  markApplicatorJobDone: mocks.markApplicatorJobDone,
}));

const job = {
  id: 'job-1',
  jobNumber: 'J-101',
  status: 'in_progress',
  jobDate: '2026-11-25',
  scheduledTime: null,
  plannedAcres: 40,
  appliedAcres: 0,
  remainingAcres: 40,
  billedCustomerNames: ['Acme Farm'],
  fields: [{ jobFieldId: 'jf-1', fieldId: 'field-1', fieldName: 'North 40', state: 'Iowa', plannedAcres: 40 }],
};

function renderPhone() {
  return render(<ToastProvider><ApplicatorPhone /></ToastProvider>);
}

async function openField() {
  fireEvent.click(await screen.findByRole('button', { name: /J-101/ }));
  fireEvent.click(screen.getByRole('button', { name: /North 40/ }));
}

function todayInCentralTime(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

describe('ApplicatorPhone', () => {
  beforeEach(() => {
    mocks.loadApplicatorPhoneJobs.mockResolvedValue([job]);
    mocks.loadApplicatorWorkEntries.mockRejectedValue(new mocks.ContractPendingError('TODO_WORK_ENTRY_READ_RPC', 'Reading work entries'));
    mocks.loadApplicatorLoadChoices.mockRejectedValue(new mocks.ContractPendingError('TODO_LOAD_REVISION_READ_PATH', 'Reading load revisions'));
    mocks.loadRestrictedUseFieldDefinitions.mockRejectedValue(new mocks.ContractPendingError('TODO_RESTRICTED_USE_FIELDS', 'Reading restricted-use fields'));
    mocks.loadNextLoadProposal.mockRejectedValue(new mocks.ContractPendingError('TODO_NEXT_LOAD_PROPOSAL', 'Loading the next-load proposal'));
    mocks.saveApplicatorWorkEntry.mockRejectedValue(new mocks.ContractPendingError('TODO_WORK_ENTRY_WRITE_RPC', 'Saving a work entry'));
    mocks.markApplicatorJobDone.mockRejectedValue(new mocks.ContractPendingError('TODO_READY_FOR_REVIEW_RPC', 'Marking the job done'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('shows assigned jobs and opens a one-handed field entry form with Now and pause proposal controls', async () => {
    renderPhone();
    expect(await screen.findByText('J-101')).toBeInTheDocument();
    expect(screen.getByText(/Acme Farm/)).toBeInTheDocument();

    await openField();
    expect(await screen.findByRole('heading', { name: "Today's work entry" })).toBeInTheDocument();
    const [startNow] = screen.getAllByRole('button', { name: 'Now' });
    fireEvent.click(startNow);
    expect((screen.getByLabelText('Start time') as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.change(screen.getByLabelText('Acres left'), { target: { value: '12' } });
    fireEvent.change(screen.getByLabelText('Resume note'), { target: { value: 'Finish the north edge after lunch.' } });
    expect(screen.getByText('12 acres to finish on field North 40')).toBeInTheDocument();
    expect(screen.getByText('Resume note: Finish the north edge after lunch.')).toBeInTheDocument();
  });

  it('does not read field assignments from direct tables when the safe crew-view contract omits them', async () => {
    mocks.loadApplicatorPhoneJobs.mockResolvedValue([{ ...job, fields: null }]);
    renderPhone();
    fireEvent.click(await screen.findByRole('button', { name: /J-101/ }));
    expect(await screen.findByText(/waiting for the safe crew-view field columns/)).toBeInTheDocument();
  });

  it('keeps saving disabled until the work-entry, load-revision, and state-field reads are available', async () => {
    renderPhone();
    await openField();
    expect(await screen.findByRole('button', { name: 'Save work entry' })).toBeDisabled();
    expect(await screen.findByText(/Saved work entries and same-day duplicate warnings are not connected yet/)).toBeInTheDocument();
    expect(screen.getByText(/State-specific fields are not connected yet/)).toBeInTheDocument();
  });

  it('warns about a same-field, same-day duplicate and shows the next-load proposal with its resume note', async () => {
    mocks.loadApplicatorWorkEntries.mockResolvedValue([{
      id: 'entry-1', fieldId: 'field-1', sprayDateCentral: todayInCentralTime(), acresSprayed: 18, resumeNote: null,
    }]);
    mocks.loadNextLoadProposal.mockResolvedValue({
      fieldId: 'field-1', fieldName: 'North 40', acresToFinish: 22, resumeNote: 'Start on the north edge.',
    });
    renderPhone();
    await openField();
    expect(await screen.findByRole('alert')).toHaveTextContent(`A work entry already exists for this field on ${todayInCentralTime()}.`);
    expect(screen.getByText('22 acres to finish on field North 40')).toBeInTheDocument();
    expect(screen.getByText('Resume note: Start on the north edge.')).toBeInTheDocument();
  });

  it('does not change the job status when the database contract is pending', async () => {
    renderPhone();
    fireEvent.click(await screen.findByRole('button', { name: /J-101/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Job done' }));
    expect(await screen.findByText(/waiting for the field-application database contract/)).toBeInTheDocument();
    expect(mocks.markApplicatorJobDone).toHaveBeenCalledWith('job-1', expect.any(String));
    await waitFor(() => expect(screen.getByText('In progress')).toBeInTheDocument());
  });
});
