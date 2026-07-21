import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

// Smoke test: proves the jsdom + Testing Library harness renders the app.
describe('App', () => {
  it('renders the NexusInfra heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'NexusInfra' })).toBeInTheDocument();
  });
});
