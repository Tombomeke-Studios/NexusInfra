import { Router, type Request, type Response } from 'express';
import { DEV_VERSION, isDefaultInternalToken, type BuildInfo } from 'shared';
import { requirePlatformAdmin } from './auth.js';
import { finvaultFromEnv } from './config.js';
import { parseSftpPort } from './sftp.js';
import type { NodeRecord } from './types.js';

// The System page (#447): what each part of this installation runs, and which
// optional features are on.
//
// Both answer questions an operator otherwise answers by reading compose files.
// "I updated and the new features are not there" had two causes nobody could see
// from the panel — the images were still the old version, and the compose file
// did not pass the variables that turn the features on. So this reports
// versions side by side, says when they disagree, and lists each feature with
// the *names* of the variables it needs. Never a value: this page is for
// administrators, and still nothing on it should be a secret.

export type Env = Record<string, string | undefined>;

export interface ComponentReport {
  /** `orchestrator`, `control-room`, `billing-bridge`, or `node-agent`. */
  service: string;
  /** For a node agent: which node. */
  nodeId?: string;
  label: string;
  reachable: boolean;
  version: string | null;
  edition: string | null;
  /** Why it is unreachable, in a few words. */
  problem?: string;
}

export type FeatureState = 'on' | 'off' | 'warning';

export interface FeatureReport {
  id: string;
  label: string;
  state: FeatureState;
  /** One sentence: what it does now, or why it is off. */
  summary: string;
  /** The variables that control it, by name. */
  variables: string[];
}

const set = (env: Env, name: string) => Boolean(env[name]?.trim());

/**
 * Each optional feature, on or off, and why. `hosted` adds the billing ones.
 * Warnings are features that are on in a way that is unsafe, or settings left
 * at an insecure default.
 */
export function featureChecklist(env: Env, hosted: boolean): FeatureReport[] {
  const mail = set(env, 'SMTP_URL');
  const panelUrl = set(env, 'PANEL_URL');
  const sftpPort = parseSftpPort(env.SFTP_PORT);
  const token = env.INTERNAL_API_TOKEN?.trim();
  const defaultToken = !token || isDefaultInternalToken(token);
  const items: FeatureReport[] = [
    {
      id: 'jwt-secret',
      label: 'Session signing secret',
      state: set(env, 'JWT_SECRET') ? 'on' : 'warning',
      summary: set(env, 'JWT_SECRET')
        ? 'Sign-ins are signed with this installation’s own secret.'
        : 'Not set: sign-ins are signed with a built-in development secret anyone can read. Set a long random value.',
      variables: ['JWT_SECRET'],
    },
    {
      id: 'internal-token',
      label: 'Service-to-service token',
      state: defaultToken ? 'warning' : 'on',
      summary: defaultToken
        ? 'The built-in default: anyone who can reach a node agent or the billing bridge can use it. Set a long random value on every service.'
        : 'Node agents and the billing bridge only answer callers holding this installation’s token.',
      variables: ['INTERNAL_API_TOKEN'],
    },
    {
      id: 'mail',
      label: 'Email notifications',
      state: mail ? 'on' : 'off',
      summary: mail ? 'Notification channels can send email.' : 'Off: no mail server is configured, so notifications go to webhooks only.',
      variables: ['SMTP_URL', 'SMTP_FROM'],
    },
    {
      id: 'password-reset',
      label: 'Password reset and email confirmation',
      state: mail && panelUrl ? 'on' : 'off',
      summary:
        mail && panelUrl
          ? 'People can reset a forgotten password, and new accounts confirm their address, by a mailed link.'
          : `Off: needs ${[!mail && 'SMTP_URL', !panelUrl && 'PANEL_URL'].filter(Boolean).join(' and ')}. An administrator can still set a new password on the Accounts page.`,
      variables: ['SMTP_URL', 'PANEL_URL'],
    },
    {
      id: 'sftp',
      label: 'SFTP',
      state: sftpPort ? 'on' : 'off',
      summary: sftpPort ? `Server files can be reached over SFTP (port ${parseSftpPort(env.SFTP_PUBLIC_PORT) ?? sftpPort} from outside).` : 'Off: server files are reachable through the panel only.',
      variables: ['SFTP_PORT', 'SFTP_PUBLIC_PORT'],
    },
    {
      id: 'require-totp',
      label: 'Two-factor sign-in required',
      state: String(env.REQUIRE_TOTP ?? '').toLowerCase() === 'true' ? 'on' : 'off',
      summary:
        String(env.REQUIRE_TOTP ?? '').toLowerCase() === 'true'
          ? 'Every account must set up an authenticator app before it can do anything else.'
          : 'Optional: each person decides whether to use an authenticator app.',
      variables: ['REQUIRE_TOTP'],
    },
    {
      id: 'metrics-token',
      label: 'Metrics protected',
      state: set(env, 'METRICS_TOKEN') ? 'on' : 'off',
      summary: set(env, 'METRICS_TOKEN')
        ? 'Each service’s /metrics needs the token.'
        : 'Open: anyone who can reach a service can read its /metrics. They hold no names or ids, but set a token if those ports are public.',
      variables: ['METRICS_TOKEN'],
    },
  ];
  if (!hosted) return items;

  const finvault = finvaultFromEnv(env);
  const testTools = env.BILLING_TEST_TOOLS === 'true';
  items.push(
    {
      id: 'finvault-key',
      label: 'Encrypted FinVault events',
      state: set(env, 'FINVAULT_MESSAGE_KEY') ? 'on' : 'warning',
      summary: set(env, 'FINVAULT_MESSAGE_KEY')
        ? 'Payment and invoice events are encrypted on the broker. The key must match FinVault’s.'
        : 'Not set: payment events cross the broker in plain text. Fine on one machine for testing, not otherwise.',
      variables: ['FINVAULT_MESSAGE_KEY'],
    },
    {
      id: 'finvault-link',
      label: 'Link to FinVault',
      state: finvault?.url ? 'on' : 'off',
      summary: finvault?.url ? 'The Billing page links to FinVault.' : 'Off: the Billing page cannot link customers to FinVault.',
      variables: ['FINVAULT_URL'],
    },
    {
      id: 'qr-topup',
      label: 'Top up by QR code',
      state: finvault?.payee ? 'on' : 'off',
      summary: finvault?.payee
        ? `Top-ups can be paid by scanning a QR code, to ${finvault.payee.name}.`
        : 'Off: needs the name and IBAN of FinVault’s merchant account (a valid IBAN). Without it a top-up can only be approved in a FinVault inbox.',
      variables: ['FINVAULT_MERCHANT_NAME', 'FINVAULT_MERCHANT_IBAN'],
    },
    {
      id: 'billing-test-tools',
      label: 'Billing test tools',
      state: testTools ? 'warning' : 'off',
      summary: testTools
        ? 'On: administrators can move billing time and change an account’s rate. Never with real customers.'
        : 'Off, as it should be with real customers.',
      variables: ['BILLING_TEST_TOOLS'],
    },
  );
  return items;
}

/** A dev build is not a version to compare; neither is something that did not answer. */
const comparable = (c: ComponentReport) => c.reachable && c.version !== null && c.version !== DEV_VERSION;

/**
 * Why these components should not be trusted to work together, or null. An
 * update that reached some images and not others is the case this is for.
 */
export function versionProblem(components: ComponentReport[]): string | null {
  const versions = new Set(components.filter(comparable).map((c) => c.version));
  if (versions.size <= 1) return null;
  const byVersion = new Map<string, string[]>();
  for (const c of components.filter(comparable)) byVersion.set(c.version!, [...(byVersion.get(c.version!) ?? []), c.label]);
  const parts = [...byVersion].map(([v, labels]) => `${labels.join(', ')} on ${v}`);
  return `Not everything runs the same version: ${parts.join('; ')}. Pull the images again and restart, so every part is on one release.`;
}

/** Read one component's /health. Never throws: a dead component is a row, not an error. */
export async function probeHealth(
  base: Omit<ComponentReport, 'reachable' | 'version' | 'edition'>,
  ask: (signal: AbortSignal) => Promise<globalThis.Response>,
  timeoutMs = 2_000,
): Promise<ComponentReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await ask(controller.signal);
    if (!r.ok) return { ...base, reachable: false, version: null, edition: null, problem: `answered ${r.status}` };
    const body = (await r.json()) as { version?: unknown; edition?: unknown };
    return {
      ...base,
      reachable: true,
      version: typeof body.version === 'string' ? body.version : null,
      edition: typeof body.edition === 'string' ? body.edition : null,
    };
  } catch {
    const problem = controller.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : 'could not be reached';
    return { ...base, reachable: false, version: null, edition: null, problem };
  } finally {
    clearTimeout(timer);
  }
}

export interface SystemDeps {
  self: BuildInfo;
  env: Env;
  hosted: boolean;
  listNodes: () => Promise<NodeRecord[]>;
  agentUrlFor: (nodeId: string) => Promise<string>;
  /** Carries the internal token, and dials an agent link where the node has one. */
  agentFetch: (url: string, init?: RequestInit) => Promise<globalThis.Response>;
  bridgeFetch: (path: string, init?: RequestInit) => Promise<globalThis.Response>;
  controlRoomUrl: string;
  fetch?: typeof fetch;
}

export async function systemReport(deps: SystemDeps) {
  const plainFetch = deps.fetch ?? fetch;
  const probes: Promise<ComponentReport>[] = [
    Promise.resolve({ service: 'orchestrator', label: 'Orchestrator', reachable: true, version: deps.self.version, edition: deps.self.edition }),
    probeHealth({ service: 'control-room', label: 'Control Room' }, (signal) => plainFetch(`${deps.controlRoomUrl}/health`, { signal })),
  ];
  if (deps.hosted) probes.push(probeHealth({ service: 'billing-bridge', label: 'Billing Bridge' }, (signal) => deps.bridgeFetch('/health', { signal })));
  for (const node of await deps.listNodes()) {
    probes.push(
      probeHealth({ service: 'node-agent', nodeId: node.id, label: `Node agent · ${node.name}` }, async (signal) => deps.agentFetch(`${await deps.agentUrlFor(node.id)}/health`, { signal })),
    );
  }
  const components = await Promise.all(probes);
  return { components, versionProblem: versionProblem(components), features: featureChecklist(deps.env, deps.hosted) };
}

export function createSystemRouter(deps: SystemDeps): Router {
  const router = Router();
  router.get('/admin/system', requirePlatformAdmin, async (_req: Request, res: Response) => {
    res.json(await systemReport(deps));
  });
  return router;
}
