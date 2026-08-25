import { describe, it, expect } from 'vitest';
import { generateDatabaseCredentials, isDatabaseEngine } from './dbProvision.js';

describe('isDatabaseEngine', () => {
  it('accepts the supported engines and rejects others', () => {
    expect(isDatabaseEngine('mysql')).toBe(true);
    expect(isDatabaseEngine('postgres')).toBe(true);
    expect(isDatabaseEngine('mariadb')).toBe(true);
    expect(isDatabaseEngine('mongo')).toBe(false);
    expect(isDatabaseEngine(undefined)).toBe(false);
  });
});

describe('generateDatabaseCredentials', () => {
  it('derives a safe db name from the server name and sequence', () => {
    const creds = generateDatabaseCredentials('My Cool Server!', 2);
    expect(creds.name).toBe('my_cool_server_db2');
    expect(creds.username).toMatch(/^u_my_cool_server_[0-9a-f]{6}$/);
    expect(creds.password.length).toBeGreaterThanOrEqual(20);
  });

  it('falls back to a stem for names with no safe characters', () => {
    expect(generateDatabaseCredentials('!!!', 1).name).toBe('srv_db1');
  });

  it('generates a distinct password each time', () => {
    const a = generateDatabaseCredentials('svc', 1);
    const b = generateDatabaseCredentials('svc', 1);
    expect(a.password).not.toBe(b.password);
  });
});
