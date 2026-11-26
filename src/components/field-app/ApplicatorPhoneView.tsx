import { CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import PhoneHeader from '../ui/PhoneHeader';
import ApplicatorWorkEntryForm from './ApplicatorWorkEntryForm';
import type { ApplicatorPhoneField, ApplicatorPhoneJob } from './applicatorPhoneApi';

interface ApplicatorPhoneViewProps {
  jobs: ApplicatorPhoneJob[];
  loading: boolean;
  loadError: boolean;
  selectedJob: ApplicatorPhoneJob | null;
  selectedField: ApplicatorPhoneField | null;
  markingDoneJobId: string | null;
  onRetry: () => void;
  onMarkJobDone: (job: ApplicatorPhoneJob) => void;
  onOpenJob: (jobId: string) => void;
  onOpenField: (field: ApplicatorPhoneField) => void;
  onBackToJobs: () => void;
  onBackToFields: () => void;
  onSaved: () => void;
}

function acresLabel(value: number | null, label: string): string {
  return value === null ? `${label} not set` : `${value} ${label}`;
}

function statusLabel(status: string): string {
  if (status === 'ready_for_review') return 'Ready for review';
  if (status === 'in_progress') return 'In progress';
  if (status === 'scheduled') return 'Scheduled';
  return status.replaceAll('_', ' ');
}

function dateLabel(date: string | null): string {
  if (!date) return 'No date set';
  const [year, month, day] = date.split('-');
  return year && month && day ? `${month}/${day}/${year}` : date;
}

function LoadingFieldWork() {
  return (
    <div className="space-y-3" aria-label="Loading field work">
      {[0, 1, 2].map((row) => <div key={row} className="h-24 animate-pulse rounded-xl bg-white shadow-sm" />)}
    </div>
  );
}

function FailedFieldWork({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 text-center">
      <p className="font-semibold text-nav-dark">Your field work could not be loaded.</p>
      <Button variant="secondary" className="mt-4 min-h-11" icon={<RefreshCw className="h-4 w-4" />} onClick={onRetry}>Try again</Button>
    </section>
  );
}

function NoOpenFieldWork() {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-crx-green-light text-crx-green"><CheckCircle2 className="h-6 w-6" aria-hidden="true" /></span>
      <h2 className="mt-3 font-heading text-xl font-bold text-nav-dark">No open field work</h2>
      <p className="mt-1 text-sm text-secondary">Assigned jobs will show here when they are ready.</p>
    </section>
  );
}

function JobList({ jobs, onOpenJob }: { jobs: ApplicatorPhoneJob[]; onOpenJob: (jobId: string) => void }) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading" className="bg-cream-dark px-4 py-3 font-heading text-xl font-bold text-nav-dark">Today's jobs</h2>
      <ul className="divide-y divide-gray-100">
        {jobs.map((job) => (
          <li key={job.id}>
            <button
              type="button"
              onClick={() => onOpenJob(job.id)}
              className="flex min-h-20 w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crx-green"
            >
              <span className="min-w-0">
                <span className="block truncate font-heading text-lg font-bold text-nav-dark">{job.jobNumber ?? 'Field job'}</span>
                <span className="mt-0.5 block truncate text-sm text-secondary">{job.billedCustomerNames.join(', ') || 'Grower not available'} · {dateLabel(job.jobDate)}</span>
                <span className="mt-1 block text-xs font-semibold text-gray-600">{statusLabel(job.status)} · {job.fields === null ? 'fields pending' : `${job.fields.length} field${job.fields.length === 1 ? '' : 's'}`}</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-gray-500" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function JobSummary({ job, markingDoneJobId, onMarkJobDone }: {
  job: ApplicatorPhoneJob;
  markingDoneJobId: string | null;
  onMarkJobDone: (job: ApplicatorPhoneJob) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4" aria-label="Job summary">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-secondary">{dateLabel(job.jobDate)}{job.scheduledTime ? ` · ${job.scheduledTime}` : ''}</p>
          {job.billedCustomerNames.length > 0 && (
            <p className="mt-1 truncate text-base font-semibold text-nav-dark">{job.billedCustomerNames.join(', ')}</p>
          )}
          <p className="mt-2 text-sm tabular-nums text-secondary">
            {acresLabel(job.plannedAcres, 'planned')} · {acresLabel(job.appliedAcres, 'sprayed')}
            {job.remainingAcres !== null ? ` · ${job.remainingAcres} remaining` : ''}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-nav-dark">{statusLabel(job.status)}</span>
      </div>
      {job.status !== 'ready_for_review' && (
        <Button
          variant="secondary"
          className="mt-4 min-h-11 w-full"
          icon={<CheckCircle2 className="h-4 w-4" />}
          loading={markingDoneJobId === job.id}
          disabled={markingDoneJobId !== null && markingDoneJobId !== job.id}
          onClick={() => onMarkJobDone(job)}
        >Job done</Button>
      )}
    </section>
  );
}

function FieldList({ fields, onOpenField }: {
  fields: ApplicatorPhoneField[] | null;
  onOpenField: (field: ApplicatorPhoneField) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="field-list-heading">
      <h2 id="field-list-heading" className="bg-cream-dark px-4 py-3 font-heading text-xl font-bold text-nav-dark">Fields</h2>
      {fields === null ? (
        <p className="px-4 py-5 text-sm text-amber-800" role="status">Assigned fields are waiting for the safe crew-view field columns; this phone cannot read field assignments from another table.</p>
      ) : fields.length === 0 ? (
        <p className="px-4 py-5 text-sm text-secondary">No fields are assigned to this job.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {fields.map((field) => (
            <li key={field.jobFieldId}>
              <button
                type="button"
                onClick={() => onOpenField(field)}
                className="flex min-h-16 w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-crx-green"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-nav-dark">{field.fieldName}</span>
                  <span className="mt-1 block text-sm text-secondary">{field.state ?? 'State not set'} · {acresLabel(field.plannedAcres, 'planned acres')}</span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-gray-500" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SelectedJobContent({ job, field, markingDoneJobId, onMarkJobDone, onOpenField, onSaved }: {
  job: ApplicatorPhoneJob;
  field: ApplicatorPhoneField | null;
  markingDoneJobId: string | null;
  onMarkJobDone: (job: ApplicatorPhoneJob) => void;
  onOpenField: (field: ApplicatorPhoneField) => void;
  onSaved: () => void;
}) {
  return (
    <>
      <JobSummary job={job} markingDoneJobId={markingDoneJobId} onMarkJobDone={onMarkJobDone} />
      {field ? (
        <ApplicatorWorkEntryForm key={`${job.id}:${field.jobFieldId}`} job={job} field={field} onSaved={onSaved} />
      ) : (
        <FieldList fields={job.fields} onOpenField={onOpenField} />
      )}
    </>
  );
}

function ApplicatorPhoneBody({
  jobs,
  loading,
  loadError,
  selectedJob,
  selectedField,
  markingDoneJobId,
  onRetry,
  onMarkJobDone,
  onOpenJob,
  onOpenField,
  onSaved,
}: Pick<ApplicatorPhoneViewProps, 'jobs' | 'loading' | 'loadError' | 'selectedJob' | 'selectedField' | 'markingDoneJobId' | 'onRetry' | 'onMarkJobDone' | 'onOpenJob' | 'onOpenField' | 'onSaved'>) {
  if (loading) return <LoadingFieldWork />;
  if (loadError) return <FailedFieldWork onRetry={onRetry} />;
  if (selectedJob) {
    return <SelectedJobContent job={selectedJob} field={selectedField} markingDoneJobId={markingDoneJobId} onMarkJobDone={onMarkJobDone} onOpenField={onOpenField} onSaved={onSaved} />;
  }
  if (jobs.length === 0) return <NoOpenFieldWork />;
  return <JobList jobs={jobs} onOpenJob={onOpenJob} />;
}

export default function ApplicatorPhoneView(props: ApplicatorPhoneViewProps) {
  const { selectedJob, selectedField } = props;
  const pageTitle = selectedField?.fieldName ?? selectedJob?.jobNumber ?? 'My field work';
  const eyebrow = selectedJob ? `${selectedJob.jobNumber ?? 'Job'} · ${statusLabel(selectedJob.status)}` : new Date().toLocaleDateString();
  const backAction = selectedField
    ? { label: 'Fields', onClick: props.onBackToFields }
    : selectedJob
      ? { label: 'Jobs', onClick: props.onBackToJobs }
      : undefined;

  return (
    <div className="phone-touch min-h-full bg-cream md:bg-gray-50">
      <PhoneHeader title={pageTitle} eyebrow={eyebrow} back={backAction} />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-4 pb-32 md:pb-6">
        <ApplicatorPhoneBody {...props} />
      </main>
    </div>
  );
}
