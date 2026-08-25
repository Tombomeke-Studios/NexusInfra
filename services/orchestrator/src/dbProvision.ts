import { randomBytes } from 'crypto';
import type { DatabaseEngine } from './types.js';

// Pure helpers for provisioning a managed database (#109): validating the engine
// and generating db-identifier-safe credentials. Kept side-effect-free so the
// naming/validation rules are unit-tested; the container itself is started by the
// owning Node Agent.

export const DB_ENGINES: DatabaseEngine[] = ['mysql', 'mariadb', 'postgres'];

export function isDatabaseEngine(value: unknown): value is DatabaseEngine {
  return typeof value === 'string' && (DB_ENGINES as string[]).includes(value);
}

// Reduce an arbitrary server name to a safe identifier stem (lowercase, a-z0-9_).
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16) || 'srv'
  );
}

export interface DatabaseCredentials {
  name: string;
  username: string;
  password: string;
}

/**
 * Generate a database name, user and password for a server. `seq` (the count of
 * existing databases + 1) keeps names unique per server; the password is a random
 * URL-safe token.
 */
export function generateDatabaseCredentials(serverName: string, seq: number): DatabaseCredentials {
  const base = slug(serverName);
  const suffix = randomBytes(3).toString('hex');
  return {
    name: `${base}_db${seq}`,
    username: `u_${base}_${suffix}`.slice(0, 24),
    password: randomBytes(18).toString('base64url'),
  };
}
