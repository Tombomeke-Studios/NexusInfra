import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { confirmEmail } from '../api';
import { isAuthenticated } from '../session';
import { IconHexagon } from '../components/Icons';

// Where the confirmation link in the mail lands (#367). Public: the link may be
// opened on a phone that was never signed in. The token is the only credential
// and is spent by the first accepted submission — so it is sent exactly once,
// even when React runs the effect twice in development.

type State = 'working' | 'done' | 'failed';

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>(token ? 'working' : 'failed');
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current) return;
    sent.current = true;
    confirmEmail(token).then(
      () => setState('done'),
      (err) => {
        setError(err instanceof Error ? err.message : null);
        setState('failed');
      }
    );
  }, [token]);

  const signedIn = isAuthenticated();

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="card" style={{ width: '100%', maxWidth: 392, padding: '28px 26px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, fontWeight: 700, color: 'var(--color-primary)', marginBottom: 18 }}>
          <IconHexagon size={22} />
          NexusInfra
        </span>
        <h1 style={{ fontSize: '1.4rem' }}>Confirm your email address</h1>

        {state === 'working' && (
          <p role="status" className="subtle" style={{ marginTop: 16 }}>
            Confirming…
          </p>
        )}
        {state === 'done' && (
          <>
            <p role="status" className="alert alert--success" style={{ marginTop: 16 }}>
              Your email address is confirmed. You can top up your credit now.
            </p>
            <Link className="btn btn--primary btn--block" to={signedIn ? '/billing' : '/login'} style={{ marginTop: 12 }}>
              {signedIn ? 'Go to Billing' : 'Sign in'}
            </Link>
          </>
        )}
        {state === 'failed' && (
          <>
            <p role="alert" className="alert alert--error" style={{ marginTop: 16 }}>
              {token
                ? `${sentence(error) ?? 'This confirmation link did not work.'} Links work once and for 24 hours; ask for a new one on the Billing page.`
                : 'This page needs the link from the confirmation email. Open the link from the mail, or ask for a new one on the Billing page.'}
            </p>
            <Link className="btn btn--secondary btn--block" to={signedIn ? '/billing' : '/login'} style={{ marginTop: 12 }}>
              {signedIn ? 'Go to Billing' : 'Sign in'}
            </Link>
          </>
        )}
      </div>
    </main>
  );
}

/** The server's reason as a sentence, or null when there is none. */
function sentence(reason: string | null): string | null {
  const text = reason?.trim();
  if (!text) return null;
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
}
