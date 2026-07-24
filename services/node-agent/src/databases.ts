import type { StartSpec } from './runtime.js';

// Pure helpers for provisioning a managed database container (#109): map an engine
// to its image, port and env, and pick a host port. Kept side-effect-free so the
// spec construction is unit-tested; DockerodeRuntime.start actually runs it.

export type DatabaseEngine = 'mysql' | 'mariadb' | 'postgres';

const IMAGE: Record<DatabaseEngine, string> = {
  mysql: 'mysql:8',
  mariadb: 'mariadb:11',
  postgres: 'postgres:16',
};

const CONTAINER_PORT: Record<DatabaseEngine, string> = {
  mysql: '3306',
  mariadb: '3306',
  postgres: '5432',
};

export interface DatabaseProvisionRequest {
  engine: DatabaseEngine;
  name: string;
  username: string;
  password: string;
  hostPort: number;
}

/**
 * Build the StartSpec for a database container: the engine's image, a stable
 * container name (so it can be removed by name later), the init env the official
 * images read to create the db/user, and the host→container port binding.
 */
export function buildDatabaseSpec(req: DatabaseProvisionRequest): StartSpec {
  const env: Record<string, string> =
    req.engine === 'postgres'
      ? { POSTGRES_DB: req.name, POSTGRES_USER: req.username, POSTGRES_PASSWORD: req.password }
      : {
          MYSQL_DATABASE: req.name,
          MYSQL_USER: req.username,
          MYSQL_PASSWORD: req.password,
          // The official MySQL/MariaDB images require a root password to start.
          MYSQL_ROOT_PASSWORD: req.password,
        };
  return {
    dockerImage: IMAGE[req.engine],
    containerName: `nexusinfra-db-${req.name}`,
    env,
    ports: { [String(req.hostPort)]: CONTAINER_PORT[req.engine] },
  };
}

/** Pick a host port for a new database from a high, unprivileged range. */
export function pickDatabasePort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}
