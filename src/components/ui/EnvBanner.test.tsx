import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EnvBanner from './EnvBanner';

describe('EnvBanner', () => {
  it('marks staging as test data', () => {
    render(<EnvBanner env="staging" supabaseUrl="https://fsnjredpmakbmhwowjjt.supabase.co" />);
    expect(screen.getByText('STAGING · test data only')).toBeInTheDocument();
  });

  it('marks a local build', () => {
    render(<EnvBanner env="local" supabaseUrl="http://127.0.0.1:56321" />);
    expect(screen.getByText('LOCAL')).toBeInTheDocument();
  });

  it('never calls a build pointed at the live database test data', () => {
    render(<EnvBanner env="staging" supabaseUrl="https://rhyzpcqhnizqbxphqdkr.supabase.co" />);
    expect(screen.getByText('STAGING · LIVE DATABASE')).toBeInTheDocument();
    expect(screen.queryByText(/test data/)).not.toBeInTheDocument();
  });

  it('shows nothing on production', () => {
    const { container } = render(<EnvBanner env="production" />);
    expect(container).toBeEmptyDOMElement();
  });
});
