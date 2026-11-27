import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { EditionProvider, useEdition } from './edition';

// The provider fetches /config and exposes the edition. A component reads it via
// useEdition() so billing UI can gate on isHosted.

function Probe() {
  const { edition, isHosted, loaded } = useEdition();
  return (
    <div>
      <span data-testid="edition">{edition}</span>
      <span data-testid="hosted">{String(isHosted)}</span>
      <span data-testid="loaded">{String(loaded)}</span>
    </div>
  );
}

function mockConfig(edition: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ edition }) } as Response));
}

describe('EditionProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to community before config resolves', () => {
    mockConfig('community');
    render(
      <EditionProvider>
        <Probe />
      </EditionProvider>
    );
    expect(screen.getByTestId('edition').textContent).toBe('community');
    expect(screen.getByTestId('hosted').textContent).toBe('false');
  });

  it('exposes the hosted edition once /config resolves', async () => {
    mockConfig('hosted');
    render(
      <EditionProvider>
        <Probe />
      </EditionProvider>
    );
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    expect(screen.getByTestId('edition').textContent).toBe('hosted');
    expect(screen.getByTestId('hosted').textContent).toBe('true');
  });

  it('stays on community when /config is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(
      <EditionProvider>
        <Probe />
      </EditionProvider>
    );
    await waitFor(() => expect(screen.getByTestId('loaded').textContent).toBe('true'));
    expect(screen.getByTestId('edition').textContent).toBe('community');
    expect(screen.getByTestId('hosted').textContent).toBe('false');
  });
});

describe('EditionProvider re-reading the server (#447)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function VersionProbe() {
    const { serverVersion, edition } = useEdition();
    return <span data-testid="version">{`${edition}@${serverVersion}`}</span>;
  }

  it('picks up a new server version when the tab comes back, and keeps the last answer through a blip', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ edition: 'hosted', version: '0.5.0' }) } as Response)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ edition: 'hosted', version: '0.5.1' }) } as Response);
    vi.stubGlobal('fetch', fetchMock);
    render(
      <EditionProvider>
        <VersionProbe />
      </EditionProvider>
    );
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('hosted@0.5.0'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('version').textContent).toBe('hosted@0.5.0');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('hosted@0.5.1'));
  });
});
