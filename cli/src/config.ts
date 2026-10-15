import { mkdir, readFile, writeFile, chmod } from 'fs/promises';
import os from 'os';
import path from 'path';

// Where nexusctl keeps the panel's address and an API token (#240). The token
// is a credential, so the file is written readable by its owner only.

export interface CliConfig {
  url: string;
  token: string;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'nexusctl', 'config.json');
}

export async function readConfigFile(file: string): Promise<Partial<CliConfig>> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Partial<CliConfig>;
  } catch {
    return {};
  }
}

export async function writeConfigFile(file: string, config: CliConfig): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

/** The environment wins over the file, so CI can run without ever writing a token to disk. */
export function resolveConfig(env: NodeJS.ProcessEnv, file: Partial<CliConfig>): Partial<CliConfig> {
  return {
    url: (env.NEXUSCTL_URL || file.url || '').replace(/\/+$/, '') || undefined,
    token: env.NEXUSCTL_TOKEN || file.token || undefined,
  };
}
