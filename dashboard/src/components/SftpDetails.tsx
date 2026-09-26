import { useEffect, useState } from 'react';
import { getCurrentUser, type CurrentUser } from '../api';
import { useEdition } from '../edition';
import { sftpUrl, sftpUsernameFor } from '../sftp';

// How to connect to this server with an SFTP client (#235) — shown on the Files
// tab, and only when the installation runs SFTP at all. Everything a client
// asks for is here, including why a password might be refused.

export function SftpDetails({ deploymentId, canWrite }: { deploymentId: string; canWrite: boolean }) {
  const { sftpPort } = useEdition();
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!sftpPort) return;
    let active = true;
    getCurrentUser()
      .then((u) => active && setUser(u))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [sftpPort]);

  if (!sftpPort || !user) return null;

  // The panel's own host: SFTP is served by the same installation, so the
  // address people reached the panel on is the one to give them.
  const host = window.location.hostname;
  const username = sftpUsernameFor(user.email, deploymentId);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(username);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (insecure context): the name is selectable text.
    }
  };

  return (
    <details className="sftp-details" style={{ marginBottom: 14, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', background: 'var(--color-surface)', padding: '10px 14px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Connect with SFTP</summary>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: '12px 0 8px', fontSize: '.88rem' }}>
        <dt className="subtle">Host</dt>
        <dd className="mono" style={{ margin: 0 }}>{host}</dd>
        <dt className="subtle">Port</dt>
        <dd className="mono" style={{ margin: 0 }}>{sftpPort}</dd>
        <dt className="subtle">User name</dt>
        <dd style={{ margin: 0, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="mono" style={{ wordBreak: 'break-all' }}>{username}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </dd>
        <dt className="subtle">Password</dt>
        <dd style={{ margin: 0 }}>
          {user.twoFactorEnabled
            ? 'An API token (Account → API tokens). Your account uses two-factor sign-in, so its password is not accepted over SFTP.'
            : 'Your account password, or an API token.'}
        </dd>
      </dl>
      <p className="subtle" style={{ fontSize: '.82rem', margin: 0 }}>
        <a href={sftpUrl(username, host, sftpPort)}>Open in a file manager</a> · Works while the server is running.{' '}
        {canWrite ? 'A token without the write scope only reads.' : 'Your role on this server can read files but not change them.'}
      </p>
    </details>
  );
}
