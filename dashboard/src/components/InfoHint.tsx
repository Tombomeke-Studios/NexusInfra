import { useId, useState } from 'react';

// A small "?" affordance that reveals a one-line explanation of a nearby option
// (#122). Accessible: the trigger is a real button with an aria-label, the bubble
// is a role="tooltip" referenced via aria-describedby, and it opens on hover,
// keyboard focus, or click — so it works with a mouse, keyboard, or touch.
export function InfoHint({ text, label = 'More information' }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="info-hint" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="info-hint__trigger"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Prevent an enclosing <label> from activating its control when the hint
        // is clicked/tapped; focus (which the click triggers) opens the tooltip.
        onClick={(e) => e.preventDefault()}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className="info-hint__bubble">
          {text}
        </span>
      )}
    </span>
  );
}
