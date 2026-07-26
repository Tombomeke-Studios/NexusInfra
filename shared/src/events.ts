import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ── Event contract ────────────────────────────────────────────────────────────
// NexusInfra speaks FinVault's on-the-wire event format so the two platforms can
// share a single RabbitMQ exchange. The envelope shape, encryption algorithm, KDF
// salt and key derivation below are IDENTICAL to FinVault/shared/src/events.ts —
// do not diverge or cross-platform payloads become undecryptable.
//
// The union is extended with NexusInfra's own infra + monitoring event types. The
// billing bridge trio (payment.request/confirmed/failed) matches FinVault's payload
// shapes exactly so the Phase 4 integration needs no re-plumbing.

export type NexusInfraEvent =
  // ── Monitoring / heartbeats ──────────────────────────────────────────
  | { type: 'heartbeat.service'; payload: { name: string; status: 'healthy'; timestamp: string } }
  | { type: 'heartbeat.node'; payload: { nodeId: string; status: 'healthy'; timestamp: string; resources?: NodeResources } }
  // ── Server lifecycle — commands (Orchestrator → Node Agent) ──────────
  | { type: 'server.start'; payload: { deploymentId: string; nodeId: string; dockerImage: string; containerName?: string; env?: Record<string, string>; ports?: Record<string, string>; resourceLimits?: ResourceLimits } }
  | { type: 'server.stop'; payload: { deploymentId: string; nodeId: string; containerId: string } }
  | { type: 'server.restart'; payload: { deploymentId: string; nodeId: string; containerId: string } }
  // ── Server lifecycle — reports (Node Agent → Orchestrator) ───────────
  | { type: 'server.started'; payload: { deploymentId: string; containerId: string; nodeId: string } }
  | { type: 'server.stopped'; payload: { deploymentId: string; containerId: string } }
  | { type: 'server.crashed'; payload: { deploymentId: string; containerId: string; reason: string } }
  | { type: 'deployment.created'; payload: { deploymentId: string; userId: string; resourceLimits?: ResourceLimits } }
  | { type: 'deployment.failed'; payload: { deploymentId: string; reason: string } }
  // ── Billing bridge → FinVault (payload shapes match FinVault's events.ts) ──
  | { type: 'payment.request'; payload: { reference: string; senderWalletId: string; receiverWalletId: string; amount: number; currency: string; description: string } }
  | { type: 'payment.confirmed'; payload: { transactionId: string; reference: string; amount: number; senderWalletId: string; receiverWalletId: string } }
  | { type: 'payment.failed'; payload: { transactionId: string; reference: string; reason: string } }
  // ── Billing (hosted edition, NexusInfra-only routing keys) ───────────
  // Envelope + encryption are unchanged; these are internal to NexusInfra.
  // Billing Bridge → Orchestrator: stop this user's servers when credit runs out.
  | { type: 'billing.server.suspend'; payload: { userId: string; deploymentIds: string[]; reason: string } }
  // NexusInfra → FinVault: a monthly invoice record for a closed billing cycle.
  | { type: 'invoice.generate'; payload: { reference: string; userId: string; periodStart: string; periodEnd: string; amount: number; currency: string } };

export interface NodeResources {
  cpuPercent: number;
  ramUsedMb: number;
  ramTotalMb: number;
  diskUsedGb: number;
  diskTotalGb: number;
}

/**
 * Resource caps + runtime behaviour chosen for a server, persisted with its config
 * (#106) and carried on server.start so the Node Agent enforces them at container
 * start (#107). Percentages are of the host node; every field is optional.
 */
export interface ResourceLimits {
  cpuPercent?: number;
  ramPercent?: number;
  diskPercent?: number;
  swapPercent?: number;
  ioPriority?: 'low' | 'normal' | 'high';
  restartPolicy?: 'no' | 'on-failure' | 'always';
  oomKill?: boolean;
}

export interface EventEnvelope<T extends NexusInfraEvent = NexusInfraEvent> {
  eventId: string;
  timestamp: string;
  source: string;
  event: T;
}

// ── AES-256-GCM payload encryption ────────────────────────────────────────────
// When FINVAULT_MESSAGE_KEY is set, event payloads are encrypted before transit.
// The event `type` stays readable (needed for routing); only the `payload` is
// replaced with { encrypted: true, data: '<base64 ciphertext>' }.
// Consuming services call decryptPayload(event.payload.data) to recover the data.

const ALGORITHM = 'aes-256-gcm';
const KDF_SALT = 'finvault-events-v1'; // fixed public salt shared with FinVault; entropy comes from the key

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, KDF_SALT, 32);
}

export function encryptPayload(payload: Record<string, unknown>, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12); // 96-bit IV — GCM standard
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const pt = Buffer.from(JSON.stringify(payload), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128-bit auth tag
  // Layout: iv(12) | tag(16) | ciphertext
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptPayload(ciphertext: string, secret: string): Record<string, unknown> {
  const key = deriveKey(secret);
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/**
 * Builds an event envelope, encrypting the payload when FINVAULT_MESSAGE_KEY is set.
 * The result is wire-compatible with FinVault: a service holding the same key can
 * read the encrypted payload; the `type` field is always readable for routing.
 */
export function buildEnvelope(source: string, event: NexusInfraEvent): EventEnvelope {
  const messageKey = process.env.FINVAULT_MESSAGE_KEY;

  const securedEvent: NexusInfraEvent = messageKey
    ? ({ type: event.type, payload: { encrypted: true, data: encryptPayload(event.payload as Record<string, unknown>, messageKey) } } as unknown as NexusInfraEvent)
    : event;

  return {
    eventId: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
    timestamp: new Date().toISOString(),
    source,
    event: securedEvent,
  };
}

/**
 * Recovers an event's payload from an envelope, decrypting when the payload was
 * encrypted (and FINVAULT_MESSAGE_KEY is available). Returns the plain payload.
 */
export function readPayload(event: NexusInfraEvent): Record<string, unknown> {
  const payload = event.payload as Record<string, unknown>;
  if (payload && payload.encrypted === true && typeof payload.data === 'string') {
    const messageKey = process.env.FINVAULT_MESSAGE_KEY;
    if (!messageKey) {
      throw new Error('Encrypted event payload received but FINVAULT_MESSAGE_KEY is not set');
    }
    return decryptPayload(payload.data, messageKey);
  }
  return payload;
}
