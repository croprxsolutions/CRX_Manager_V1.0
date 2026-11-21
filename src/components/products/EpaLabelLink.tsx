import { ExternalLink } from 'lucide-react';
import { epaLabelSearchUrl } from '../../lib/productBrands';

interface EpaLabelLinkProps {
  epaRegistration: string | null | undefined;
  showHint?: boolean;
  /** The stored label PDF for this exact number (database-checked https). Shows "View label" instead of the search. */
  labelUrl?: string | null;
}

const linkClass = 'inline-flex items-center gap-1.5 text-sm font-medium text-crx-green hover:underline';

export default function EpaLabelLink({ epaRegistration, showHint = false, labelUrl }: EpaLabelLinkProps) {
  const registration = epaRegistration?.trim() ?? '';
  const href = epaLabelSearchUrl(registration);

  if (labelUrl && href) {
    return (
      <a href={labelUrl} target="_blank" rel="noopener noreferrer" aria-label={`View the EPA label for ${registration}`} className={linkClass}>
        View label
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    );
  }

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Search EPA labels for ${registration}`}
        className={linkClass}
      >
        Search EPA labels
        <ExternalLink aria-hidden="true" className="h-4 w-4" />
      </a>
    );
  }

  if (!showHint) return null;

  const hint = registration
    ? "Check the EPA number's format to see the label"
    : 'Add an EPA number to see the label';

  return <p className="text-xs text-secondary">{hint}</p>;
}
