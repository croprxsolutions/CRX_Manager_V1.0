import { useState, useEffect, useId, useRef } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import Modal from '../ui/Modal';
import Input from '../ui/Input';
import Button from '../ui/Button';
import type { LinkedEntityType, NoteType, NotePriority, Profile } from '../../types';
import { toSentryError } from '../../lib/sentryError';

interface QuickTaskModalProps {
  open: boolean;
  onClose: () => void;
  entityType: LinkedEntityType;
  entityId: string;
  prefillTitle?: string;
  prefillContent?: string;
  prefillAssignee?: string;
  callbackOnly?: boolean;
  onCreated?: () => void;
}

const entityDisplayNames: Record<LinkedEntityType, string> = {
  delivery: 'Delivery',
  order: 'Order',
  customer: 'Customer',
  job: 'Job',
  purchase_order: 'Purchase Order',
  quote: 'Quote',
  invoice: 'Invoice',
  product: 'Product',
};

type TaskFields = {
  title: string;
  content: string | null;
  note_type: NoteType;
  priority: NotePriority;
  assigned_to: string | null;
  due_date: string | null;
  created_by: string;
  linked_entity_type: LinkedEntityType;
  linked_entity_id: string;
};

async function saveQuickTask(fields: TaskFields, callbackId: string | null) {
  const input: TaskFields & { id?: string } = callbackId ? { id: callbackId, ...fields } : fields;
  const { error } = await supabase.from('team_notes').insert(input);
  if (!error) return true;
  if (!callbackId || error.code !== '23505') throw error;

  // A lost save response can leave this same callback in Team Board already.
  const prior = await supabase.from('team_notes')
    .select('title, content, note_type, priority, assigned_to, due_date, created_by, linked_entity_type, linked_entity_id')
    .eq('id', callbackId).eq('created_by', fields.created_by).maybeSingle();
  if (prior.error || !prior.data) throw prior.error ?? error;
  const saved = prior.data;
  return Object.keys(fields).every((key) => saved[key as keyof TaskFields] === fields[key as keyof TaskFields]);
}

export default function QuickTaskModal({
  open,
  onClose,
  entityType,
  entityId,
  prefillTitle = '',
  prefillContent = '',
  prefillAssignee = '',
  callbackOnly = false,
  onCreated,
}: QuickTaskModalProps) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const fieldId = useId();

  const [title, setTitle] = useState(prefillTitle);
  const [content, setContent] = useState(prefillContent);
  const [noteType, setNoteType] = useState<NoteType>('todo');
  const [priority, setPriority] = useState<NotePriority>('medium');
  const [assignedTo, setAssignedTo] = useState(prefillAssignee);
  const [dueDate, setDueDate] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [assigneeStatus, setAssigneeStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [assigneeRetry, setAssigneeRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const callbackIdRef = useRef<string | null>(null);
  const waitingForAssignee = callbackOnly && !!assignedTo && assigneeStatus !== 'ready';
  const callbackAssigneeUnavailable = callbackOnly && !!assignedTo && !profiles.some((person) => person.id === assignedTo);

  useEffect(() => { callbackIdRef.current = null; }, [open, entityId]);

  // Reset form when modal opens with new prefill values
  useEffect(() => {
    if (open) {
      setTitle(prefillTitle);
      setContent(prefillContent);
      setAssignedTo(prefillAssignee);
      setNoteType('todo');
      setPriority('medium');
      setDueDate('');
    }
  }, [open, prefillTitle, prefillContent, prefillAssignee]);

  // Load profiles for the assign-to dropdown
  useEffect(() => {
    if (!open) return;
    let current = true;
    (async () => {
      // PR-07 follow-up: assignee picker only uses p.id + p.full_name; safe via view.
      // Codex P2 (2026-05-16): exclude entity_recipient service profiles
      // (CMCTW LLC, Crop Rx Solutions) — they can't log in or receive tasks.
      const { data, error } = await supabase
        .from('profile_public_view')
        .select('id, full_name, role, is_active')
        .eq('is_active', true)
        .neq('role', 'entity_recipient')
        .order('full_name');
      if (!current) return;
      setAssigneeStatus(error || !data ? 'failed' : 'ready');
      if (data) setProfiles(data as unknown as Profile[]);
    })();
    return () => { current = false; };
  }, [open, assigneeRetry]);

  async function handleSave() {
    if (saving || waitingForAssignee) return;
    if (!profile) {
      toast('error', 'Please wait for profile to load');
      return;
    }
    if (!title.trim()) {
      toast('error', 'Title is required');
      return;
    }
    if (callbackAssigneeUnavailable) {
      toast('error', 'Choose an active assignee or select Unassigned.');
      return;
    }

    setSaving(true);
    try {
      if (callbackOnly && !callbackIdRef.current) callbackIdRef.current = crypto.randomUUID();
      const matches = await saveQuickTask({
        title: title.trim(),
        content: content.trim() || null,
        note_type: callbackOnly ? 'todo' : noteType,
        priority,
        assigned_to: assignedTo || null,
        due_date: dueDate || null,
        created_by: profile.id,
        linked_entity_type: entityType,
        linked_entity_id: entityId,
      }, callbackOnly ? callbackIdRef.current : null);

      onCreated?.();
      if (!matches) throw new Error('The earlier callback was already saved. Open it on Team Board to make changes.');
      toast('success', callbackOnly ? 'Callback saved' : 'Task created successfully');
      onClose();
    } catch (err: unknown) {
      Sentry.captureException(toSentryError(err), { extra: { context: 'QuickTaskModal.handleSave' } });
      const message = err instanceof Error ? err.message : 'Failed to create task';
      toast('error', message);
    } finally {
      setSaving(false);
    }
  }

  const selectClass =
    'w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green';

  return (
    <Modal open={open} onClose={saving ? () => {} : onClose} title={callbackOnly ? 'Schedule callback' : 'Quick Task'} accent={callbackOnly ? undefined : 'Note'}>
      <fieldset className="space-y-4" disabled={saving}>
        {/* Entity badge */}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg text-sm text-secondary">
          <LinkIcon className="w-4 h-4 shrink-0" />
          <span>Linked to: {entityDisplayNames[entityType]}</span>
        </div>

        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />

        <div>
          <label htmlFor={`${fieldId}-content`} className="block text-sm font-medium text-secondary mb-1">Content</label>
          <textarea
            id={`${fieldId}-content`}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
            className={selectClass}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {!callbackOnly && <div>
            <label htmlFor={`${fieldId}-type`} className="block text-sm font-medium text-secondary mb-1">Type</label>
            <select id={`${fieldId}-type`} value={noteType} onChange={(e) => setNoteType(e.target.value as NoteType)} className={selectClass}>
              <option value="note">Note</option>
              <option value="todo">To-Do</option>
              <option value="announcement">Announcement</option>
            </select>
          </div>}
          <div>
            <label htmlFor={`${fieldId}-priority`} className="block text-sm font-medium text-secondary mb-1">Priority</label>
            <select id={`${fieldId}-priority`} value={priority} onChange={(e) => setPriority(e.target.value as NotePriority)} className={selectClass}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor={`${fieldId}-assignee`} className="block text-sm font-medium text-secondary mb-1">Assign To</label>
            <select id={`${fieldId}-assignee`} value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={selectClass}>
              <option value="">Unassigned</option>
              {callbackAssigneeUnavailable && (
                <option value={assignedTo}>{assigneeStatus === 'loading' ? 'Loading assigned rep…' : 'Selected assignee unavailable'}</option>
              )}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name}</option>
              ))}
            </select>
            {callbackOnly && assigneeStatus === 'failed' && (
              <Button size="sm" variant="ghost" className="min-h-11" onClick={() => {
                setAssigneeStatus('loading');
                setAssigneeRetry((attempt) => attempt + 1);
              }}>Retry loading assignees</Button>
            )}
          </div>
          <Input label="Due Date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} loading={saving} disabled={waitingForAssignee}>
            {callbackOnly ? 'Save callback' : 'Create Task'}
          </Button>
        </div>
      </fieldset>
    </Modal>
  );
}
