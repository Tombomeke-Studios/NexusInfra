import { describe, it, expect } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { nextFocus, useFocusTrap } from './focusTrap';

// #247: Tab stays inside a modal, and focus goes back where it was.

describe('nextFocus', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((id) => Object.assign(document.createElement('button'), { id }));
  const items = [a, b, c];

  it('wraps forward from the last and backward from the first', () => {
    expect(nextFocus(items, c, false)).toBe(a);
    expect(nextFocus(items, a, true)).toBe(c);
  });
  it('leaves the browser alone in the middle', () => {
    expect(nextFocus(items, b, false)).toBeNull();
    expect(nextFocus(items, b, true)).toBeNull();
  });
  it('pulls focus back in from outside', () => {
    expect(nextFocus(items, document.body, false)).toBe(a);
    expect(nextFocus(items, document.body, true)).toBe(c);
  });
  it('does nothing with nothing to focus', () => {
    expect(nextFocus([], document.body, false)).toBeNull();
  });
});

function Modal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true);
  return (
    <div ref={ref} role="dialog" aria-modal="true">
      <button>First</button>
      {/* autoFocus takes focus before any effect runs — the case that used to lose track of the opener */}
      <button autoFocus>Second</button>
      <button onClick={onClose}>Close</button>
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button>Elsewhere</button>
      {open && <Modal onClose={() => setOpen(false)} />}
    </>
  );
}

describe('useFocusTrap', () => {
  it('keeps Tab inside and hands focus back to the opener, even past autoFocus', async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Second' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });
});
