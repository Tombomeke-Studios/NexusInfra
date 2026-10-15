import { useEffect, type RefObject } from 'react';

// Keeping keyboard focus inside a modal (#247). A dialog marked aria-modal tells
// a screen reader the rest of the page is inert, but Tab did not know: it walked
// out of the dialog into the page behind it, where nothing visible had focus.
// And when a modal closes, focus goes back where it was, rather than to the top
// of the document.

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The last element focused outside any modal. What to hand focus back to can't
// be read when the modal opens: a button inside it with `autoFocus` has already
// taken focus by the time an effect runs, and restoring to *that* — gone once the
// modal closes — dropped focus on <body>.
let lastFocusedOutside: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest?.('[aria-modal="true"]')) lastFocusedOutside = target;
    },
    true
  );
}

export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true');
}

/**
 * Where Tab (or Shift+Tab) should land from `current`, or null to let the
 * browser move normally. Pure, so the wrap-around is tested without a browser.
 */
export function nextFocus(items: HTMLElement[], current: Element | null, backwards: boolean): HTMLElement | null {
  if (items.length === 0) return null;
  const index = current ? items.indexOf(current as HTMLElement) : -1;
  // Focus is outside the modal (or on the container itself): bring it in.
  if (index === -1) return backwards ? items[items.length - 1] : items[0];
  if (backwards && index === 0) return items[items.length - 1];
  if (!backwards && index === items.length - 1) return items[0];
  return null;
}

export interface FocusTrapOptions {
  /** Move focus into the modal when it opens. Off when the component focuses a field itself. */
  autoFocus?: boolean;
  /** Return focus to where it was when the modal closes. Off when the component does it. */
  restore?: boolean;
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: FocusTrapOptions = {}): void {
  const { autoFocus = true, restore = true } = options;
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;
    const current = document.activeElement as HTMLElement | null;
    const previouslyFocused = current && container.contains(current) ? lastFocusedOutside : current;
    if (autoFocus && !container.contains(document.activeElement)) {
      (focusablesIn(container)[0] ?? container).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const target = nextFocus(focusablesIn(container), document.activeElement, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (restore && previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [ref, active, autoFocus, restore]);
}
