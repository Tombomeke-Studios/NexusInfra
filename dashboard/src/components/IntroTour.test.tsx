import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntroTour } from './IntroTour';

describe('IntroTour', () => {
  it('renders nothing when closed', () => {
    render(<IntroTour open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('steps through the tour and finishes on the last step', async () => {
    const onClose = vi.fn();
    render(<IntroTour open onClose={onClose} />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    // Back returns to the previous step.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument();

    // Advance to the last step and finish.
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when Skip is clicked', async () => {
    const onClose = vi.fn();
    render(<IntroTour open onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onClose).toHaveBeenCalled();
  });
});
