import { describe, it, expect } from 'vitest';
import { buildDatabaseSpec } from './databases.js';

describe('buildDatabaseSpec', () => {
  it('builds a MySQL spec with the init env and port binding', () => {
    const spec = buildDatabaseSpec({ engine: 'mysql', name: 'app_db1', username: 'u_app', password: 'secret', hostPort: 33060 });
    expect(spec.dockerImage).toBe('mysql:8');
    expect(spec.containerName).toBe('nexusinfra-db-app_db1');
    expect(spec.env).toEqual({
      MYSQL_DATABASE: 'app_db1',
      MYSQL_USER: 'u_app',
      MYSQL_PASSWORD: 'secret',
      MYSQL_ROOT_PASSWORD: 'secret',
    });
    expect(spec.ports).toEqual({ '33060': '3306' });
  });

  it('builds a Postgres spec with POSTGRES_* env and 5432', () => {
    const spec = buildDatabaseSpec({ engine: 'postgres', name: 'app_db1', username: 'u_app', password: 'pw', hostPort: 54320 });
    expect(spec.dockerImage).toBe('postgres:16');
    expect(spec.env).toEqual({ POSTGRES_DB: 'app_db1', POSTGRES_USER: 'u_app', POSTGRES_PASSWORD: 'pw' });
    expect(spec.ports).toEqual({ '54320': '5432' });
  });

  it('uses the mariadb image for mariadb', () => {
    expect(buildDatabaseSpec({ engine: 'mariadb', name: 'd', username: 'u', password: 'p', hostPort: 1 }).dockerImage).toBe('mariadb:11');
  });
});
