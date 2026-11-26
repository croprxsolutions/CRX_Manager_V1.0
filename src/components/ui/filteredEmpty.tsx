import { FilterX } from 'lucide-react';
import Button from './Button';

/**
 * DataTable empty-state props for a list whose search or filters hide every row. "No … yet"
 * there reads as if the records were gone, so say what is hiding them and offer to clear it.
 */
export function filteredEmptyProps(noun: string, onClear: () => void) {
  return {
    emptyTitle: `No ${noun} match your search or filters`,
    emptyDescription: 'Try a different search or clear the filters.',
    emptyAction: (
      <Button variant="secondary" icon={<FilterX className="w-4 h-4" />} onClick={onClear}>
        Clear filters
      </Button>
    ),
  };
}
