import { useCallback } from 'react';
import type { useFieldMarkerEditor } from '../../hooks/useFieldMarkerEditor';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { MarkerKindSelect } from './FieldMarkerPanel';

export default function FieldMarkerEditor({ editor, ready, unavailable }: {
  editor: ReturnType<typeof useFieldMarkerEditor>;
  ready: boolean;
  unavailable: boolean;
}) {
  const { draft, placing, saving } = editor;
  const focusForm = useCallback((form: HTMLFormElement | null) => form?.focus({ preventScroll: true }), []);
  return (
    <>
      {editor.message && <p role="status" className="text-sm text-nav-dark">{editor.message}</p>}
      {draft && unavailable && <Button type="button" variant="ghost" disabled={saving} onClick={editor.cancel}>
        {draft.submitted ? 'Keep for later' : 'Cancel'}
      </Button>}
      {draft && !unavailable && (
        <form ref={focusForm} tabIndex={-1} aria-label="Field marker editor"
          className="space-y-3 rounded-lg border border-gray-300 p-3"
          onSubmit={(event) => { event.preventDefault(); void editor.save(); }}>
          <h3 className="font-semibold">{draft.marker ? 'Edit marker on' : 'Add marker to'} {draft.field.name}</h3>
          {placing && <p role="status" className="text-sm">Tap the map where the marker belongs.</p>}
          <MarkerKindSelect kind={draft.kind} onChange={(kind) => editor.patch({ kind })} disabled={saving || draft.submitted} />
          <label className="block text-sm font-medium">
            Note (optional)
            <textarea className="mt-1 block w-full rounded border border-gray-300 p-2 text-base"
              value={draft.note} disabled={saving || draft.submitted} onChange={(event) => editor.patch({ note: event.target.value })}
              rows={2} />
          </label>
          <div className="flex flex-wrap gap-2">
            {!placing && !draft.submitted && <Button type="button" variant="secondary" disabled={saving || !ready}
              onClick={() => editor.setPlacing(true)}>Move pin on map</Button>}
            <Button type="submit" loading={saving} disabled={!ready || placing || (!draft.marker && !draft.point)}>
              {draft.submitted ? 'Retry save' : 'Save marker'}
            </Button>
            <Button type="button" variant="ghost" disabled={saving} onClick={editor.cancel}>
              {draft.submitted ? 'Keep for later' : 'Cancel'}
            </Button>
          </div>
        </form>
      )}
      <ConfirmModal open={editor.target !== null} onClose={editor.cancel} onConfirm={() => void editor.remove()}
        title="Delete field marker?" message="The pin will be removed from this field’s maps and future printouts."
        confirmLabel="Delete marker" loading={saving} />
    </>
  );
}
