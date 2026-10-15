import { useCallback, useEffect, useState } from 'react';
import { X, Loader2, Image } from 'lucide-react';
import { supabase, checkMutationResult } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import ConfirmModal from '../ui/ConfirmModal';
import { PrivatePhotoButton } from '../ui/PrivatePhoto';
import { storagePathFromPublicUrl } from '../../lib/privatePhotos';
import type { TeamNoteAttachment } from '../../types';

interface NoteAttachmentsProps {
  noteId: string;
  canDelete: boolean;
  refreshKey?: number;
}

export default function NoteAttachments({ noteId, canDelete, refreshKey }: NoteAttachmentsProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  // The photo file and its row may be deleted only by their uploader or an admin (storage and
  // table policies), so a note owner sees Delete only on their own photos.
  const isAdmin = profile?.role === 'admin' && profile.is_active;
  const [attachments, setAttachments] = useState<TeamNoteAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TeamNoteAttachment | null>(null);

  const fetchAttachments = useCallback(async () => {
    const { data, error } = await supabase
      .from('team_note_attachments')
      .select('*')
      .eq('note_id', noteId)
      .order('created_at', { ascending: true });

    if (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { extra: { context: 'Failed to fetch attachments' } });
    } else {
      setAttachments(data ?? []);
    }
    setLoading(false);
  }, [noteId]);

  useEffect(() => {
    fetchAttachments();
  }, [fetchAttachments, refreshKey]);

  const handleDelete = async (attachment: TeamNoteAttachment) => {
    setDeletingId(attachment.id);

    try {
      const storagePath = storagePathFromPublicUrl(attachment.file_url, 'team-note-attachments');

      // Delete from storage first
      if (storagePath) {
        const { error: storageErr } = await supabase.storage
          .from('team-note-attachments')
          .remove([storagePath]);

        if (storageErr) {
          Sentry.captureException(storageErr instanceof Error ? storageErr : new Error(String(storageErr)), { extra: { context: 'Storage delete error' } });
          // Continue to delete DB record even if storage delete fails
        }
      }

      // Delete from database
      const result = await supabase
        .from('team_note_attachments')
        .delete()
        .eq('id', attachment.id)
        .select();

      checkMutationResult(result, 'Delete note attachment');
      toast('success', 'Photo deleted');
      setAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
    } catch (err) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'Delete attachment error' } });
      toast('error', 'Failed to delete photo');
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    );
  }

  if (attachments.length === 0) return null;

  return (
    <>
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative">
          {attachment.file_type.startsWith('image/') ? (
            <PrivatePhotoButton
              bucket="team-note-attachments"
              path={storagePathFromPublicUrl(attachment.file_url, 'team-note-attachments')}
              alt={attachment.file_name}
              viewerTitle={attachment.file_name}
              className="w-full aspect-square rounded-lg object-cover"
            />
          ) : (
            <div className="w-full aspect-square rounded-lg bg-gray-100 flex items-center justify-center">
              <Image className="w-8 h-8 text-gray-400" />
            </div>
          )}

          {canDelete && (isAdmin || attachment.uploaded_by === profile?.id) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(attachment);
              }}
              disabled={deletingId === attachment.id}
              className="absolute top-1 right-1 p-1 bg-red-600 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700 disabled:opacity-50"
              title="Delete photo"
            >
              {deletingId === attachment.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          <p className="mt-1 text-xs text-gray-500 truncate" title={attachment.file_name}>
            {attachment.file_name}
          </p>
        </div>
      ))}
    </div>

      <ConfirmModal
        open={!!confirmDelete}
        title="Delete Photo"
        message={`Are you sure you want to delete "${confirmDelete?.file_name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (confirmDelete) handleDelete(confirmDelete);
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </>
  );
}
