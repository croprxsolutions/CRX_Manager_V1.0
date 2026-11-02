import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { usePhoneSections } from '../../hooks/usePhoneSections';
import PhoneSection from './PhoneSection';

function Page() {
  const sections = usePhoneSections(['pricing']);
  return (
    <>
      <button onClick={() => sections.reveal('details')}>Refuse</button>
      <PhoneSection title="Details" {...sections.sectionProps('details')}>
        <input aria-label="SKU" />
      </PhoneSection>
      <PhoneSection title="Locked" {...sections.sectionProps('locked', true)}>
        <p>Locked content</p>
      </PhoneSection>
      <PhoneSection title="Pricing" {...sections.sectionProps('pricing')}>
        <p>Pricing content</p>
      </PhoneSection>
    </>
  );
}

const toggle = (name: string) => screen.getByRole('button', { name });
const body = (name: string) => document.getElementById(toggle(name).getAttribute('aria-controls')!)!;

describe('PhoneSection', () => {
  it('opens only what it is told to, and folds with phone-only classes so desktop shows everything', () => {
    render(<Page />);
    expect(toggle('Pricing')).toHaveAttribute('aria-expanded', 'true');
    expect(toggle('Details')).toHaveAttribute('aria-expanded', 'false');
    expect(toggle('Locked')).toHaveAttribute('aria-expanded', 'true');
    expect(toggle('Details')).toHaveClass('md:hidden');
    expect(body('Details')).toHaveClass('max-md:hidden');
    expect(body('Details')).not.toHaveClass('hidden');
    expect(body('Pricing')).not.toHaveClass('max-md:hidden');
  });

  it('keeps a typed value through folding, because the field stays mounted', () => {
    render(<Page />);
    const field = screen.getByLabelText('SKU');
    fireEvent.change(field, { target: { value: 'KEPT' } });
    fireEvent.click(toggle('Details'));
    fireEvent.click(toggle('Details'));
    expect(screen.getByLabelText('SKU')).toBe(field);
    expect(field).toHaveValue('KEPT');
  });

  it('reveals a closed section that holds a problem', () => {
    render(<Page />);
    fireEvent.click(toggle('Refuse'));
    expect(toggle('Details')).toHaveAttribute('aria-expanded', 'true');
    expect(body('Details')).not.toHaveClass('max-md:hidden');
  });
});
