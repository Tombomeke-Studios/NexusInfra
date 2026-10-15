import { useState } from 'react';

/**
 * Pick a game version from a list, or type one (#311).
 *
 * The version used to be a free-text field whose own example ("e.g. 1.21.1") had
 * gone stale — Minecraft has since moved to a new numbering scheme. The list now
 * comes from Mojang, through the orchestrator.
 *
 * It keeps a way to type one, because the list is a *suggestion*: it can be
 * stale, or come from the offline fallback on a machine with no internet. A
 * selector that refused a version the image would happily install would be worse
 * than the field it replaced.
 */
export function VersionSelect({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const known = options.includes(value);
  // A value that is not in the list means somebody typed it — stay in that mode
  // rather than silently snapping their answer to something else.
  const [typing, setTyping] = useState(!known && value !== '');

  if (typing) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          id={id}
          className="input mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="1.21.4"
          style={{ width: 'auto', minWidth: 160 }}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          data-ripple
          onClick={() => {
            setTyping(false);
            onChange(options[0] ?? '');
          }}
        >
          Choose from the list
        </button>
      </div>
    );
  }

  return (
    <select
      id={id}
      className="select"
      value={value}
      onChange={(e) => {
        if (e.target.value === OTHER) {
          setTyping(true);
          onChange('');
          return;
        }
        onChange(e.target.value);
      }}
      style={{ width: 'auto', minWidth: 200 }}
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      <option value={OTHER}>Other — type a version…</option>
    </select>
  );
}

/** Sentinel for the escape hatch. Not a version, so it cannot collide with one. */
const OTHER = '__other__';
