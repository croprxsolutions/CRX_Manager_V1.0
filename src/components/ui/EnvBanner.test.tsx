import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import EnvBanner from './EnvBanner';

describe('EnvBanner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('marks staging as test data', () => {
    render(<EnvBanner env="staging" supabaseUrl="https://fsnjredpmakbmhwowjjt.supabase.co" />);
    expect(screen.getByText('STAGING · test data only')).toBeInTheDocument();
  });

  it.each(['localhost', 'preview.vercel.app', 'croprxsolutions.app'])('hides proof links on %s', (hostname) => {
    vi.stubGlobal('location', { hostname });
    render(<EnvBanner env="staging" />);
    expect(screen.queryByRole('navigation', { name: 'Staging maps checks' })).not.toBeInTheDocument();
  });

  it('opens the Stage 0 proofs in the same installed app on the protected staging hostname', () => {
    vi.stubGlobal('location', { hostname: 'staging.croprxsolutions.app' });
    render(<EnvBanner env="staging" supabaseUrl="https://fsnjredpmakbmhwowjjt.supabase.co" />);
    const drawing = screen.getByRole('link', { name: 'Map drawing proof' });
    const places = screen.getByRole('link', { name: 'Google Places check' });
    expect(drawing).toHaveAttribute('href', '/api/maps-step0-draw/index.html');
    expect(places).toHaveAttribute('href', '/api/maps-step0?places=1');
    expect(drawing).not.toHaveAttribute('target');
    expect(places).not.toHaveAttribute('target');
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
