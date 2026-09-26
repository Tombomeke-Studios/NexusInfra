import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditionProvider } from '../edition';
import { SftpDetails } from './SftpDetails';

// The Files tab's SFTP details (#235): present only when the installation runs
// SFTP, and complete enough to type into a client without guessing.

const ID = '1a2b3c4d-0000-4000-8000-000000000000';

function serve(config: { sftpPort: number | null }, me: { email: string; twoFactorEnabled?: boolean }, canWrite = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith('/config')) return { ok: true, status: 200, json: async () => ({ edition: 'community', ...config }) } as Response;
      if (path.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ id: 'u1', displayName: 'Ada', platformRole: 'user', ...me }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    })
  );
  return render(
    <EditionProvider>
      <SftpDetails deploymentId={ID} canWrite={canWrite} />
    </EditionProvider>
  );
}

describe('SftpDetails', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows nothing when SFTP is off', async () => {
    const { container } = serve({ sftpPort: null }, { email: 'ada@example.com' });
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('gives the host, port, user name and a working link', async () => {
    serve({ sftpPort: 2022 }, { email: 'ada@example.com' });
    await userEvent.click(await screen.findByText('Connect with SFTP'));
    expect(screen.getByText('ada@example.com.1a2b3c4d')).toBeInTheDocument();
    expect(screen.getByText('2022')).toBeInTheDocument();
    expect(screen.getByText('Your account password, or an API token.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in a file manager' })).toHaveAttribute('href', `sftp://ada%40example.com.1a2b3c4d@${window.location.hostname}:2022`);
  });

  it('tells a two-factor account its password will not work here', async () => {
    serve({ sftpPort: 2022 }, { email: 'ada@example.com', twoFactorEnabled: true });
    await userEvent.click(await screen.findByText('Connect with SFTP'));
    expect(screen.getByText(/two-factor sign-in, so its password is not accepted/)).toBeInTheDocument();
  });

  it('says so when the role can only read', async () => {
    serve({ sftpPort: 2022 }, { email: 'op@example.com' }, false);
    await userEvent.click(await screen.findByText('Connect with SFTP'));
    expect(screen.getByText(/can read files but not change them/)).toBeInTheDocument();
  });
});
