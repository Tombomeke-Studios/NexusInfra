import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { PlayerCount, PlayerStatus } from './PlayerStatus';

// The live player line (#382): asks only while the server runs, and shows what
// the game said — or that it did not answer — never a made-up zero.

function serve(body: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as Response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ONLINE = {
  status: 'online',
  protocol: 'minecraft',
  players: { online: 2, max: 20 },
  version: '1.21.1',
  motd: 'Hello there',
  name: null,
  map: null,
  latencyMs: 4,
  checkedAt: '2026-10-15T12:00:00.000Z',
};

describe('PlayerStatus', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the players and what the game said', async () => {
    const fetchMock = serve(ONLINE);
    render(<PlayerStatus deploymentId="d1" running />);
    expect(await screen.findByText('2 / 20 players')).toBeInTheDocument();
    expect(screen.getByText('Hello there · 1.21.1 · 4 ms')).toBeInTheDocument();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/deployments/d1/query');
  });

  it('says a game that does not answer is not answering', async () => {
    serve({ status: 'offline', protocol: 'a2s', players: null, error: 'no answer within 2500 ms', checkedAt: 'x' });
    render(<PlayerStatus deploymentId="d1" running />);
    expect(await screen.findByText('Not answering')).toBeInTheDocument();
    expect(screen.queryByText(/players/)).not.toBeInTheDocument();
  });

  it('does not ask about a server that is not running', async () => {
    const fetchMock = serve(ONLINE);
    const { container } = render(<PlayerStatus deploymentId="d1" running={false} />);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a kind of server it cannot ask', async () => {
    serve({ status: 'unsupported', protocol: null, players: null, checkedAt: 'x' });
    const { container } = render(<PlayerStatus deploymentId="d1" running />);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PlayerCount', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the list a compact count', async () => {
    serve(ONLINE);
    render(<PlayerCount deploymentId="d1" running />);
    expect(await screen.findByText('2/20 online')).toBeInTheDocument();
  });
});
