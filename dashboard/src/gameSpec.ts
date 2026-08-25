// Maps the New Deployment game picker to a real, pullable Docker image with the
// right startup env and port (#114). Pure so the mapping is unit-tested; the form
// feeds the result straight into createDeployment.

export interface GameOptions {
  game: string;
  software: string;
  version: string;
  slots: number;
  motd: string;
}

export interface GameDeployment {
  dockerImage: string;
  ports: Record<string, string>; // hostPort -> containerPort
  env: Record<string, string>;
}

// Minecraft server "type" values understood by itzg/minecraft-server.
const MC_TYPE: Record<string, string> = {
  paper: 'PAPER',
  fabric: 'FABRIC',
  forge: 'FORGE',
  vanilla: 'VANILLA',
  purpur: 'PURPUR',
};

/** Build the image/env/ports for the selected game. Unknown games fall back to Minecraft. */
export function buildGameDeployment(opts: GameOptions): GameDeployment {
  const motd = opts.motd.trim() || 'A NexusInfra server';
  switch (opts.game) {
    case 'valheim':
      return {
        dockerImage: 'lloesche/valheim-server',
        ports: { '2456': '2456' },
        env: { SERVER_NAME: motd, WORLD_NAME: 'NexusInfra', SERVER_PUBLIC: '1' },
      };
    case 'rust':
      return {
        dockerImage: 'didstopia/rust-server',
        ports: { '28015': '28015' },
        env: { RUST_SERVER_NAME: motd, RUST_SERVER_MAXPLAYERS: String(opts.slots) },
      };
    case 'cs2':
      return {
        dockerImage: 'joedwards32/cs2',
        ports: { '27015': '27015' },
        env: { CS2_SERVERNAME: motd, CS2_MAXPLAYERS: String(opts.slots) },
      };
    case 'minecraft':
    default:
      return {
        dockerImage: 'itzg/minecraft-server',
        ports: { '25565': '25565' },
        env: {
          EULA: 'TRUE',
          TYPE: MC_TYPE[opts.software] ?? 'PAPER',
          VERSION: opts.version,
          MAX_PLAYERS: String(opts.slots),
          MOTD: motd,
        },
      };
  }
}
