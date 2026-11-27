import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { System } from './System';

const REPORT = {
  components: [
    { service: 'orchestrator', label: 'Orchestrator', reachable: true, version: '0.5.0', edition: 'hosted' },
    { service: 'node-agent', nodeId: 'n1', label: 'Node agent · alpha', reachable: false, version: null, edition: null, problem: 'could not be reached' },
  ],
  versionProblem: 'Not everything runs the same version: Orchestrator on 0.5.0; Node agent · beta on 0.4.1.',
  features: [
    { id: 'jwt-secret', label: 'Session signing secret', state: 'warning', summary: 'Not set.', variables: ['JWT_SECRET'] },
    { id: 'qr-topup', label: 'Top up by QR code', state: 'off', summary: 'Off: needs a payee.', variables: ['FINVAULT_MERCHANT_NAME', 'FINVAULT_MERCHANT_IBAN'] },
  ],
};

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as Response;

describe('System page (#447)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows versions, a dead part, the version split and which settings a feature needs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(REPORT)));
    render(<System />);
    expect(await screen.findByText(/Not everything runs the same version/)).toBeInTheDocument();
    expect(screen.getByText('Not answering')).toBeInTheDocument();
    expect(screen.getByText('could not be reached')).toBeInTheDocument();
    expect(screen.getByText(/One setting needs attention: Session signing secret/)).toBeInTheDocument();
    expect(screen.getByText('FINVAULT_MERCHANT_IBAN')).toBeInTheDocument();
    // The panel's own version sits beside the server's.
    expect(screen.getByText('0.5.0-test')).toBeInTheDocument();
  });

  it('says plainly when the account may not see it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ error: 'platform administrator role required' }, 403)));
    render(<System />);
    expect(await screen.findByText('Only platform administrators can see this page.')).toBeInTheDocument();
  });
});
