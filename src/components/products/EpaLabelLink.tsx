import { ExternalLink } from 'lucide-react';
import { epaLabelSearchUrl } from '../../lib/productBrands';

interface EpaLabelLinkProps {
  epaRegistration: string | null | undefined;
  showHint?: boolean;
}

export default function EpaLabelLink({ epaRegistration, showHint = false }: EpaLabelLinkProps) {
  const registration = epaRegistration?.trim() ?? '';
  const href = epaLabelSearchUrl(registration);

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Search EPA labels for ${registration}`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-crx-green hover:underline"
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
