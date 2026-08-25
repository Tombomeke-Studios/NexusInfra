// Theme handling: persist the user's choice, fall back to the OS preference, and
// apply it via data-theme on <html> (see index.css tokens).

export type Theme = 'light' | 'dark';

const KEY = 'nexusinfra.theme';

export function getTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** Applies the initial theme as early as possible to avoid a flash. */
export function initTheme(): void {
  applyTheme(getTheme());
}
