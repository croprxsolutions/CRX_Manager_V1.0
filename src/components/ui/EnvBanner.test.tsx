import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import EnvBanner from './EnvBanner';

describe('EnvBanner', () => {
  it('marks staging as test data', () => {
    render(<EnvBanner env="staging" supabaseUrl="https://fsnjredpmakbmhwowjjt.supabase.co" />);
    expect(screen.getByText('STAGING · test data only')).toBeInTheDocument();
  });

  it('marks a local build', () => {
    render(<EnvBanner env="local" supabaseUrl="https://rhyzpcqhnizqbxphqdkr.supabase.co" />);
    expect(screen.getByText('LOCAL')).toBeInTheDocument();
  });

  it('claims test data only for a database known to hold it', () => {
    for (const url of ['https://rhyzpcqhnizqbxphqdkr.supabase.co', 'http://localhost:54321', undefined]) {
      const { unmount } = render(<EnvBanner env="staging" supabaseUrl={url} />);
      expect(screen.getByText('STAGING · check which database this uses')).toBeInTheDocument();
      expect(screen.queryByText(/test data/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows nothing on production', () => {
    const { container } = render(<EnvBanner env="production" />);
    expect(container).toBeEmptyDOMElement();
  });
});
