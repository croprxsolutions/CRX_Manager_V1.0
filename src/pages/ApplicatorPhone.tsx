import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { useToast } from '../components/ui/Toast';
import ApplicatorPhoneView from '../components/field-app/ApplicatorPhoneView';
import {
  ApplicatorPhoneContractPendingError,
  loadApplicatorPhoneJobs,
  markApplicatorJobDone,
  type ApplicatorPhoneField,
  type ApplicatorPhoneJob,
} from '../components/field-app/applicatorPhoneApi';

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

  return (
    <ApplicatorPhoneView
      jobs={jobs}
      loading={loading}
      loadError={loadError}
      selectedJob={selectedJob}
      selectedField={selectedField}
      markingDoneJobId={markingDoneJobId}
      onRetry={() => void reloadJobs()}
      onMarkJobDone={(job) => void markJobDone(job)}
      onOpenJob={openJob}
      onOpenField={openField}
      onBackToJobs={() => { setSelectedJobId(null); setSelectedFieldId(null); }}
      onBackToFields={() => setSelectedFieldId(null)}
      onSaved={() => void reloadJobs()}
    />
  );
}
