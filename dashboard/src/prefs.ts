// Client-side user preferences, persisted in localStorage. The single place that
// reads/writes the prefs blob (mirrors session.ts for the token). Starts with the
// first-run intro flag (#123); the customisable form defaults land here too (#124).

const PREFS_KEY = 'nexusinfra.prefs';

export interface Prefs {
  introSeen?: boolean;
}

export function getPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Prefs) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...getPrefs(), ...patch };
  localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  return next;
}

export function hasSeenIntro(): boolean {
  return getPrefs().introSeen === true;
}

export function markIntroSeen(): void {
  setPrefs({ introSeen: true });
}
