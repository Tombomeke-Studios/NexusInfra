import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

// In-app confirm and prompt dialogs (#299).
//
// The panel used `window.confirm` and `window.prompt` in sixteen places. Three
// problems, in order of what they cost:
//
//   1. They are OS chrome in the middle of a designed panel, and they announce
//      the origin ("localhost:8095 says"), which reads as a browser warning
//      rather than as the application asking a question.
//   2. They cannot carry the weight of what they ask. Deleting a server destroys
//      a container and its files; the native dialog gives that the same single
//      line and the same OK button as renaming a file.
//   3. They block the page thread. A browser-driven test or screenshot run stops
//      dead on one and cannot continue — which is why none of these paths had
//      ever been exercised by an automated run.
//
// The API is promise-shaped so a call site reads almost as it did:
//
//   if (!(await confirm({ title: 'Delete server', danger: true }))) return;
//
// A `window.prompt` returns null on cancel; so does this, for the same reason.

export interface ConfirmOptions {
  title: string;
  /** The consequence, in a sentence. Shown under the title. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Irreversible or destructive: styled as such, and never the default focus. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message?: string;
  cancelLabel?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return a problem to refuse, or null to accept. Runs as the person types. */
  validate?: (value: string) => string | null;
}

interface DialogApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** The entered value, or null when cancelled — as `window.prompt` did. */
  prompt: (options: PromptOptions) => Promise<string | null>;
}

/**
 * Without a provider, every dialog is refused.
 *
 * Failing closed on purpose: these guard deletions, and a missing provider
 * silently answering "yes" would turn a wiring mistake into destroyed data.
 */
const DialogContext = createContext<DialogApi>({
  confirm: async () => false,
  prompt: async () => null,
});

export function useDialog(): DialogApi {
  return useContext(DialogContext);
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', options, resolve })),
    []
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => setPending({ kind: 'prompt', options, resolve })),
    []
  );

  const settle = useCallback(
    (value: boolean | string | null) => {
      setPending((current) => {
        if (!current) return null;
        if (current.kind === 'confirm') current.resolve(value === true);
        else current.resolve(typeof value === 'string' ? value : null);
        return null;
      });
    },
    []
  );

  return (
    <DialogContext.Provider value={{ confirm, prompt }}>
      {children}
      {pending && <DialogHost pending={pending} onSettle={settle} />}
    </DialogContext.Provider>
  );
}

function DialogHost({ pending, onSettle }: { pending: Pending; onSettle: (value: boolean | string | null) => void }) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(pending.kind === 'prompt' ? (pending.options.initialValue ?? '') : '');
  const [touched, setTouched] = useState(false);

  const problem = pending.kind === 'prompt' ? (pending.options.validate?.(value) ?? null) : null;

  // Focus goes into the dialog, and comes back where it was when it closes —
  // otherwise a keyboard user is dropped at the top of the document after every
  // confirmation.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (pending.kind === 'prompt') inputRef.current?.select();
    else panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => previouslyFocused?.focus?.();
  }, [pending]);

  // Escape cancels, wherever focus happens to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onSettle(pending.kind === 'confirm' ? false : null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pending, onSettle]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending.kind === 'confirm') return onSettle(true);
    setTouched(true);
    if (problem) return;
    onSettle(value);
  };

  const cancel = () => onSettle(pending.kind === 'confirm' ? false : null);

  const danger = pending.kind === 'confirm' && pending.options.danger === true;
  const confirmLabel = pending.options.confirmLabel ?? (pending.kind === 'confirm' ? 'Confirm' : 'Save');

  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={panelRef}>
        <form onSubmit={submit}>
          <h2 id={titleId} className="dialog-title">
            {pending.options.title}
          </h2>
          {pending.options.message && <p className="dialog-message">{pending.options.message}</p>}

          {pending.kind === 'prompt' && (
            <label className="field" style={{ display: 'block' }}>
              <span className="field__label">{pending.options.label}</span>
              <input
                ref={inputRef}
                className="input"
                value={value}
                placeholder={pending.options.placeholder}
                onChange={(e) => {
                  setValue(e.target.value);
                  setTouched(true);
                }}
                aria-label={pending.options.label}
                aria-invalid={touched && problem ? true : undefined}
              />
              {touched && problem && (
                <span role="alert" className="field__hint" style={{ color: 'var(--color-danger)' }}>
                  {problem}
                </span>
              )}
            </label>
          )}

          <div className="dialog-actions">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              data-ripple
              onClick={cancel}
              // On a destructive dialog the safe choice is the one that has
              // focus, so a reflexive Enter cancels rather than deletes.
              {...(danger ? { 'data-autofocus': true } : {})}
            >
              {pending.options.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="submit"
              className={`btn btn--sm ${danger ? 'btn--danger-solid' : 'btn--primary'}`}
              data-ripple
              data-burst={danger ? 'danger' : 'primary'}
              disabled={pending.kind === 'prompt' && touched && problem !== null}
              {...(danger ? {} : { 'data-autofocus': true })}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
