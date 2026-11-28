import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getConfig, type Edition } from './api';

// Edition context (#144) — the open-core split. The dashboard reads the running
// edition from the Orchestrator's public /config and exposes it so billing UI
// (Billing page, usage badges) renders only in the hosted edition. Community is
// the safe default until (and if) the config resolves as hosted.

interface EditionState {
  edition: Edition;
  isHosted: boolean;
  loaded: boolean;
  /** Whether "Forgot your password?" can send a link here (#344). */
  passwordResetByEmail: boolean;
  /** The SFTP port (#235), or null when this installation does not offer SFTP. */
  sftpPort: number | null;
  /** Whether this installation confirms email addresses (#367). */
  emailVerification: boolean;
  /** Hosted only: where a top-up is paid — FinVault's address, and the payee its QR names (#435, #436). */
  finvault: { url: string | null; payee: { name: string; iban: string } | null } | null;
  /** TEMPORARY (#439): whether the Customers page shows its billing test tools. */
  billingTestTools: boolean;
  /** The release the server runs (#447), or null when it did not say. */
  serverVersion: string | null;
}

const DEFAULT_STATE: EditionState = { edition: 'community', isHosted: false, loaded: false, passwordResetByEmail: false, sftpPort: null, emailVerification: false, finvault: null, billingTestTools: false, serverVersion: null };

/** How often the server's config is read again (#447). */
export const CONFIG_REFRESH_MS = 5 * 60_000;

const EditionContext = createContext<EditionState>(DEFAULT_STATE);

export function useEdition(): EditionState {
  return useContext(EditionContext);
}

export function EditionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditionState>(DEFAULT_STATE);

  useEffect(() => {
    let active = true;
    const read = (first: boolean) =>
      getConfig()
        .then((cfg) => {
          if (active)
            setState({
              edition: cfg.edition,
              isHosted: cfg.edition === 'hosted',
              loaded: true,
              passwordResetByEmail: cfg.passwordResetByEmail === true,
              sftpPort: typeof cfg.sftpPort === 'number' ? cfg.sftpPort : null,
              emailVerification: cfg.emailVerification === true,
              finvault: cfg.finvault ?? null,
              billingTestTools: cfg.billingTestTools === true,
              serverVersion: typeof cfg.version === 'string' ? cfg.version : null,
            });
        })
        .catch(() => {
          // Unreachable/erroring config → stay on the community default, but mark
          // loaded so consumers stop waiting. A later re-read that fails keeps
          // what the last one said: a blip is not a downgrade to community.
          if (active && first) setState({ ...DEFAULT_STATE, loaded: true });
        });
    void read(true);
    // Read again when the tab comes back and every few minutes (#447): a tab left
    // open across an update is how an old panel ends up talking to a new server.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void read(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => void read(false), CONFIG_REFRESH_MS);
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, []);

  return <EditionContext.Provider value={state}>{children}</EditionContext.Provider>;
}
