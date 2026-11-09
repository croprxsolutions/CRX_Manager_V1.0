import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EnvBanner from './EnvBanner';

describe('EnvBanner', () => {
  it('marks staging as test data', () => {
    render(<EnvBanner env="staging" />);
    expect(screen.getByRole('status')).toHaveTextContent('STAGING · test data only');
  });

  it('marks a local build', () => {
    render(<EnvBanner env="local" />);
    expect(screen.getByRole('status')).toHaveTextContent('LOCAL');
  });

  it('shows nothing on production', () => {
    const { container } = render(<EnvBanner env="production" />);
    expect(container).toBeEmptyDOMElement();
  });
});
