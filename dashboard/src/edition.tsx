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
}

const DEFAULT_STATE: EditionState = { edition: 'community', isHosted: false, loaded: false, passwordResetByEmail: false, sftpPort: null, emailVerification: false };

const EditionContext = createContext<EditionState>(DEFAULT_STATE);

export function useEdition(): EditionState {
  return useContext(EditionContext);
}

export function EditionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditionState>(DEFAULT_STATE);

  useEffect(() => {
    let active = true;
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
          });
      })
      .catch(() => {
        // Unreachable/erroring config → stay on the community default, but mark
        // loaded so consumers stop waiting.
        if (active) setState({ ...DEFAULT_STATE, loaded: true });
      });
    return () => {
      active = false;
    };
  }, []);

  return <EditionContext.Provider value={state}>{children}</EditionContext.Provider>;
}
