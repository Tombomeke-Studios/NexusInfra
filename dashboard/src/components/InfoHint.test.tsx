import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InfoHint } from './InfoHint';

describe('InfoHint', () => {
  it('reveals the tooltip when the trigger is focused', async () => {
    render(<InfoHint text="Share of the host node's CPU" label="CPU limit help" />);
    expect(screen.queryByRole('tooltip')).toBeNull();

    const trigger = screen.getByRole('button', { name: 'CPU limit help' });
    await userEvent.click(trigger); // clicking focuses the trigger

    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent("Share of the host node's CPU");
    // The trigger points at the tooltip for assistive tech.
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
  });

  it('hides the tooltip again on blur', async () => {
    render(<InfoHint text="help text" />);
    const trigger = screen.getByRole('button', { name: 'More information' });
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
