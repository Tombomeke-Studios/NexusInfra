import { InfoHint } from './InfoHint';

/** A limit set either as an absolute amount or as a share of the node (#275). */
export function LimitField<U extends string>({
  label,
  unit,
  onUnitChange,
  units,
  hint,
  absoluteValue,
  onAbsoluteChange,
  absoluteStep,
  absoluteMax,
  percentValue,
  onPercentChange,
  note,
}: {
  label: string;
  unit: U;
  onUnitChange: (u: U) => void;
  units: { value: U; label: string }[];
  hint: string;
  absoluteValue: number;
  onAbsoluteChange: (v: number) => void;
  absoluteStep: number;
  absoluteMax?: number;
  percentValue: number;
  onPercentChange: (v: number) => void;
  note?: string;
}) {
  const isPercent = unit === 'percent';
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9, gap: 10 }}>
        <span style={{ fontSize: '.86rem', fontWeight: 550 }}>
          {label}
          <InfoHint text={hint} label={`${label} help`} />
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          {units.map((u) => (
            <button
              key={u.value}
              type="button"
              data-ripple
              onClick={() => onUnitChange(u.value)}
              className={`opt opt--sm${unit === u.value ? ' is-active' : ''}`}
              aria-pressed={unit === u.value}
              // Named per field: two of these say "%", and "%" on its own tells a
              // screen reader nothing about which limit it switches.
              aria-label={`${label} in ${u.label}`}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>
      {isPercent ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            type="range"
            min={5}
            max={100}
            step={5}
            value={percentValue}
            onChange={(e) => onPercentChange(Number(e.target.value))}
            aria-label={`${label} percent`}
            style={{ flex: 1 }}
          />
          <span className="mono tnum" style={{ minWidth: 48, textAlign: 'right', fontSize: '.9rem', fontWeight: 600 }}>{percentValue}%</span>
        </div>
      ) : (
        <input
          className="input mono"
          type="number"
          min={0}
          step={absoluteStep}
          max={absoluteMax}
          value={absoluteValue}
          onChange={(e) => onAbsoluteChange(Number(e.target.value))}
          aria-label={label}
        />
      )}
      {note && <span className="subtle" style={{ display: 'block', marginTop: 6, fontSize: '.78rem' }}>{note}</span>}
    </div>
  );
}
