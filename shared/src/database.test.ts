import { describe, it, expect } from 'vitest';
import { databaseProvider, isPostgresUrl } from './database.js';

describe('databaseProvider (#241)', () => {
  it('recognises both spellings of a PostgreSQL URL', () => {
    expect(isPostgresUrl('postgresql://u:p@db:5432/nexus')).toBe(true);
    expect(isPostgresUrl('postgres://u:p@db/nexus')).toBe(true);
    expect(databaseProvider('POSTGRESQL://db/x')).toBe('postgresql');
  });
  it('treats anything else as SQLite, the default', () => {
    expect(databaseProvider('file:./orchestrator.db')).toBe('sqlite');
    expect(databaseProvider(undefined)).toBe('sqlite');
    expect(databaseProvider('')).toBe('sqlite');
    expect(isPostgresUrl('mysql://db/x')).toBe(false);
  });
});
