import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import EpaLabelLink from './EpaLabelLink';

describe('EpaLabelLink', () => {
  it.each([false, true])('links a valid registration to EPA labels when showHint is %s', (showHint) => {
    render(<EpaLabelLink epaRegistration=" 524-475 " showHint={showHint} />);

    const link = screen.getByRole('link', { name: 'Search EPA labels for 524-475' });
    expect(link).toHaveAttribute(
      'href',
      'https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:524-475',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the missing-number hint when requested', () => {
    render(<EpaLabelLink epaRegistration="   " showHint />);

    expect(screen.getByText('Add an EPA number to see the label')).toHaveClass('text-xs', 'text-secondary');
  });

  it('shows the malformed-number hint when requested', () => {
    render(<EpaLabelLink epaRegistration="EPA 524-475" showHint />);

    expect(screen.getByText("Check the EPA number's format to see the label")).toHaveClass('text-xs', 'text-secondary');
  });

  it('renders nothing for blank or invalid numbers when no hint is requested', () => {
    const { rerender, container } = render(<EpaLabelLink epaRegistration={null} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<EpaLabelLink epaRegistration="invalid" />);
    expect(container).toBeEmptyDOMElement();
  });
});
