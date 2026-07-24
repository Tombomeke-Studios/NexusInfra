// Client-side user preferences, persisted in localStorage. The single place that
// reads/writes the prefs blob (mirrors session.ts for the token). Starts with the
// first-run intro flag (#123); the customisable form defaults land here too (#124).

const PREFS_KEY = 'nexusinfra.prefs';

// Customisable defaults for the New Deployment form (#124). Changing these lets a
// user tailor the panel to how they usually deploy, so the form starts pre-filled.
export interface DeploymentDefaults {
  type: 'app' | 'game';
  cpu: number;
  ram: number;
  disk: number;
  swap: number;
  io: 'low' | 'normal' | 'high';
  restart: 'no' | 'on-failure' | 'always';
  oom: boolean;
  dbEngine: 'mysql' | 'mariadb' | 'postgres';
}

export const DEFAULT_DEPLOYMENT: DeploymentDefaults = {
  type: 'app',
  cpu: 50,
  ram: 50,
  disk: 50,
  swap: 0,
  io: 'normal',
  restart: 'on-failure',
  oom: false,
  dbEngine: 'mysql',
};

export interface Prefs {
  introSeen?: boolean;
  deploymentDefaults?: Partial<DeploymentDefaults>;
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

/** The effective deployment defaults: the built-in defaults with the user's overrides applied. */
export function getDeploymentDefaults(): DeploymentDefaults {
  return { ...DEFAULT_DEPLOYMENT, ...getPrefs().deploymentDefaults };
}

export function setDeploymentDefaults(patch: Partial<DeploymentDefaults>): void {
  setPrefs({ deploymentDefaults: { ...getPrefs().deploymentDefaults, ...patch } });
}

/** Clear the user's deployment-default overrides, reverting to the built-ins. */
export function resetDeploymentDefaults(): void {
  setPrefs({ deploymentDefaults: {} });
}
