import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  loadApplicatorLoadChoices,
  loadApplicatorWorkEntries,
  loadNextLoadProposal,
  loadRestrictedUseFieldDefinitions,
  type ApplicatorLoadChoice,
  type ApplicatorPhoneField,
  type ApplicatorPhoneJob,
  type ApplicatorWorkEntrySummary,
  type NextLoadProposal,
  type RestrictedUseFieldDefinition,
} from './applicatorPhoneApi';
import { errorState, type ResourceState } from './applicatorPhoneFormUtils';

function updateResource<T>(
  result: PromiseSettledResult<T>,
  setValue: Dispatch<SetStateAction<T>>,
  setState: Dispatch<SetStateAction<ResourceState>>,
) {
  if (result.status === 'fulfilled') {
    setValue(result.value);
    setState('ready');
    return;
  }
  setState(errorState(result.reason));
}

export default function useApplicatorWorkEntryResources(job: ApplicatorPhoneJob, field: ApplicatorPhoneField) {
  const [savedEntries, setSavedEntries] = useState<ApplicatorWorkEntrySummary[]>([]);
  const [loadChoices, setLoadChoices] = useState<ApplicatorLoadChoice[]>([]);
  const [restrictedFields, setRestrictedFields] = useState<RestrictedUseFieldDefinition[]>([]);
  const [nextLoadProposal, setNextLoadProposal] = useState<NextLoadProposal | null>(null);
  const [entriesState, setEntriesState] = useState<ResourceState>('loading');
  const [loadsState, setLoadsState] = useState<ResourceState>('loading');
  const [restrictedState, setRestrictedState] = useState<ResourceState>('loading');
  const [proposalState, setProposalState] = useState<ResourceState>('loading');

  useEffect(() => {
    let active = true;
    setEntriesState('loading');
    setLoadsState('loading');
    setRestrictedState('loading');
    setProposalState('loading');

    void Promise.allSettled([
      loadApplicatorWorkEntries(job.id, field.fieldId),
      loadApplicatorLoadChoices(job.id),
      loadRestrictedUseFieldDefinitions(field.state),
      loadNextLoadProposal(job.id, field.fieldId),
    ]).then(([entriesResult, loadsResult, restrictedResult, proposalResult]) => {
      if (!active) return;
      updateResource(entriesResult, setSavedEntries, setEntriesState);
      updateResource(loadsResult, setLoadChoices, setLoadsState);
      updateResource(restrictedResult, setRestrictedFields, setRestrictedState);
      updateResource(proposalResult, setNextLoadProposal, setProposalState);
    });

    return () => { active = false; };
  }, [field.fieldId, field.state, job.id]);

  return {
    savedEntries,
    loadChoices,
    restrictedFields,
    nextLoadProposal,
    entriesState,
    loadsState,
    restrictedState,
    proposalState,
  };
}
