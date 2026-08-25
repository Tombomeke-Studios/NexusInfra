import { useEffect, useState } from 'react';

// First-run intro (#123): a short, skippable, keyboard-friendly walkthrough that
// orients a new user — what a node is, what a deployment is, and where the per
// server tools live. Shown once (persisted via prefs) and re-openable from the
// Help button in the nav.

interface Step {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to NexusInfra',
    body: 'NexusInfra runs and manages servers as Docker containers across your machines. This quick tour explains the three things you need: nodes, deployments, and the per-server tools.',
  },
  {
    title: 'Nodes are your machines',
    body: 'A node is a Docker host NexusInfra can run servers on. The Overview shows each node’s live CPU and memory; “New node” adds one. When you deploy, the scheduler picks the emptiest healthy node for you — so add nodes to grow capacity.',
  },
  {
    title: 'Deployments are your servers',
    body: 'New Deployment turns a Docker image (or a game preset) into a running container with the CPU/RAM/restart limits you choose — hover any “?” to learn what an option does. The Servers page lists them with start, stop and restart.',
  },
  {
    title: 'Tools for each server',
    body: 'Open a server to reach its live Console (real container logs), a real file browser, managed databases, live resource stats, and settings. Everything streams from the node running it.',
  },
  {
    title: 'Sharing a server',
    body: 'A server’s Subusers tab invites someone by email and gives them a role: a viewer sees status and logs, an operator can also start, stop and restart it, and an admin manages everything except deleting it. Invite someone without an account yet and the invitation waits, granting nothing until they sign up with that address.',
  },
  {
    title: 'Teams, for sharing more than once',
    body: 'A team shares every server attached to it with everyone in it, so you don’t invite each person to each server. Create one on the Teams page, then attach a server from its Settings tab. Servers always stay owned by whoever created them — deleting a team never deletes a server.',
  },
];

export function IntroTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);

  // Reset to the first step whenever it opens, and wire Escape to dismiss.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  return (
    <div
      className="intro-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="intro-title"
    >
      <div className="intro-card" onClick={(e) => e.stopPropagation()}>
        <div className="intro-card__step">Step {step + 1} of {STEPS.length}</div>
        <h2 id="intro-title" className="intro-card__title">{current.title}</h2>
        <p className="intro-card__body">{current.body}</p>

        <div className="intro-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <span key={i} className={`intro-dot${i === step ? ' is-active' : ''}`} />
          ))}
        </div>

        <div className="intro-card__actions">
          <button className="btn btn--ghost btn--sm" data-ripple onClick={onClose}>Skip</button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button className="btn btn--secondary btn--sm" data-ripple onClick={() => setStep((s) => s - 1)}>Back</button>
            )}
            {last ? (
              <button className="btn btn--primary btn--sm" data-ripple data-burst="success" onClick={onClose} autoFocus>Get started</button>
            ) : (
              <button className="btn btn--primary btn--sm" data-ripple onClick={() => setStep((s) => s + 1)} autoFocus>Next</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
