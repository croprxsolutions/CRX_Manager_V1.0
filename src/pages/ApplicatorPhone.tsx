import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useToast } from '../components/ui/Toast';
import PhoneHeader from '../components/ui/PhoneHeader';
import Button from '../components/ui/Button';
import ApplicatorWorkEntryForm from '../components/field-app/ApplicatorWorkEntryForm';
import {
  ApplicatorPhoneContractPendingError,
  loadApplicatorPhoneJobs,
  markApplicatorJobDone,
  type ApplicatorPhoneField,
  type ApplicatorPhoneJob,
} from '../components/field-app/applicatorPhoneApi';

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

function pendingMessage(error: unknown, fallback: string): string {
  if (error instanceof ApplicatorPhoneContractPendingError) return error.message;
  return fallback;
}

export default function ApplicatorPhone() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('field_app_job_done', profile?.id ?? 'signed-out');
  const [jobs, setJobs] = useState<ApplicatorPhoneJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [markingDoneJobId, setMarkingDoneJobId] = useState<string | null>(null);

  const reloadJobs = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const rows = await loadApplicatorPhoneJobs();
      setJobs(rows);
      setSelectedJobId((current) => current && rows.some((job) => job.id === current) ? current : null);
      setSelectedFieldId(null);
    } catch {
      setLoadError(true);
      toast('error', 'Could not load your field work. Try again.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError(false);
      try {
        const rows = await loadApplicatorPhoneJobs();
        if (!active) return;
        setJobs(rows);
      } catch {
        if (!active) return;
        setLoadError(true);
        toast('error', 'Could not load your field work. Try again.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [toast]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const selectedField = selectedJob?.fields?.find((field) => field.fieldId === selectedFieldId) ?? null;

  async function markJobDone(job: ApplicatorPhoneJob) {
    if (markingDoneJobId) return;
    setMarkingDoneJobId(job.id);
    const idempotencyKey = getKeyFor(job.id);
    try {
      await markApplicatorJobDone(job.id, idempotencyKey);
      resetKeyFor(job.id);
      toast('success', `${job.jobNumber ?? 'Job'} marked ready for review.`);
      await reloadJobs();
    } catch (error) {
      toast('warning', pendingMessage(error, 'Job status could not be changed. Nothing was changed.'));
    } finally {
      setMarkingDoneJobId(null);
    }
  }

  function openJob(jobId: string) {
    setSelectedJobId(jobId);
    setSelectedFieldId(null);
  }

  function openField(field: ApplicatorPhoneField) {
    setSelectedFieldId(field.fieldId);
  }

  const pageTitle = selectedField?.fieldName ?? selectedJob?.jobNumber ?? 'My field work';
  const eyebrow = selectedJob ? `${selectedJob.jobNumber ?? 'Job'} · ${statusLabel(selectedJob.status)}` : new Date().toLocaleDateString();
  const backAction = selectedField
    ? { label: 'Fields', onClick: () => setSelectedFieldId(null) }
    : selectedJob
      ? { label: 'Jobs', onClick: () => { setSelectedJobId(null); setSelectedFieldId(null); } }
      : undefined;

  return (
    <div className="phone-touch min-h-full bg-cream md:bg-gray-50">
      <PhoneHeader title={pageTitle} eyebrow={eyebrow} back={backAction} />
      <main className="mx-auto max-w-xl space-y-4 px-4 py-4 pb-32 md:pb-6">
        {loading ? (
          <div className="space-y-3" aria-label="Loading field work">
            {[0, 1, 2].map((row) => <div key={row} className="h-24 animate-pulse rounded-xl bg-white shadow-sm" />)}
          </div>
        ) : loadError ? (
          <section className="rounded-xl border border-gray-200 bg-white p-5 text-center">
            <p className="font-semibold text-nav-dark">Your field work could not be loaded.</p>
            <Button variant="secondary" className="mt-4 min-h-11" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void reloadJobs()}>Try again</Button>
          </section>
        ) : selectedJob ? (
          <>
            <section className="rounded-xl border border-gray-200 bg-white p-4" aria-label="Job summary">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-secondary">{dateLabel(selectedJob.jobDate)}{selectedJob.scheduledTime ? ` · ${selectedJob.scheduledTime}` : ''}</p>
                  {selectedJob.billedCustomerNames.length > 0 && (
                    <p className="mt-1 truncate text-base font-semibold text-nav-dark">{selectedJob.billedCustomerNames.join(', ')}</p>
                  )}
                  <p className="mt-2 text-sm tabular-nums text-secondary">
                    {acresLabel(selectedJob.plannedAcres, 'planned')} · {acresLabel(selectedJob.appliedAcres, 'sprayed')}
                    {selectedJob.remainingAcres !== null ? ` · ${selectedJob.remainingAcres} remaining` : ''}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-nav-dark">{statusLabel(selectedJob.status)}</span>
              </div>
              {selectedJob.status !== 'ready_for_review' && (
                <Button
                  variant="secondary"
                  className="mt-4 min-h-11 w-full"
                  icon={<CheckCircle2 className="h-4 w-4" />}
                  loading={markingDoneJobId === selectedJob.id}
                  disabled={markingDoneJobId !== null && markingDoneJobId !== selectedJob.id}
                  onClick={() => void markJobDone(selectedJob)}
                >Job done</Button>
              )}
            </section>

            {selectedField ? (
              <ApplicatorWorkEntryForm
                key={`${selectedJob.id}:${selectedField.jobFieldId}`}
                job={selectedJob}
                field={selectedField}
                onSaved={() => void reloadJobs()}
              />
            ) : (
              <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="field-list-heading">
                <h2 id="field-list-heading" className="bg-cream-dark px-4 py-3 font-heading text-xl font-bold text-nav-dark">Fields</h2>
                {selectedJob.fields === null ? (
                  <p className="px-4 py-5 text-sm text-amber-800" role="status">Assigned fields are waiting for the safe crew-view field columns; this phone cannot read field assignments from another table.</p>
                ) : selectedJob.fields.length === 0 ? (
                  <p className="px-4 py-5 text-sm text-secondary">No fields are assigned to this job.</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {selectedJob.fields.map((field) => (
                      <li key={field.jobFieldId}>
                        <button
                          type="button"
                          onClick={() => openField(field)}
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
            )}
          </>
        ) : jobs.length === 0 ? (
          <section className="rounded-xl border border-gray-200 bg-white p-6 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-crx-green-light text-crx-green"><CheckCircle2 className="h-6 w-6" aria-hidden="true" /></span>
            <h2 className="mt-3 font-heading text-xl font-bold text-nav-dark">No open field work</h2>
            <p className="mt-1 text-sm text-secondary">Assigned jobs will show here when they are ready.</p>
          </section>
        ) : (
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white" aria-labelledby="jobs-heading">
            <h2 id="jobs-heading" className="bg-cream-dark px-4 py-3 font-heading text-xl font-bold text-nav-dark">Today's jobs</h2>
            <ul className="divide-y divide-gray-100">
              {jobs.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    onClick={() => openJob(job.id)}
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
        )}
      </main>
    </div>
  );
}
