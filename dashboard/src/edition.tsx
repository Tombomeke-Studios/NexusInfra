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
}

const DEFAULT_STATE: EditionState = { edition: 'community', isHosted: false, loaded: false };

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
        if (active) setState({ edition: cfg.edition, isHosted: cfg.edition === 'hosted', loaded: true });
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
