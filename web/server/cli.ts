/**
 * The command line of `npm run host` and ./host.sh: argument parsing, help, the memorable
 * password generator and the startup banner.
 */
import { randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { DEFAULT_PORT } from '../src/net/protocol';
import { browserOriginPolicy } from './browserOrigin';

export interface HostArgs {
  help: boolean;
  password: string | null;
  port: number;
  name: string | null;
  bind: string | null;
  allowedOrigins: string[];
}

export const USAGE = `Host a FLAGHACK ∞ multiplayer burn: friends join from their browsers.

Usage:  ./host.sh [options]                (repo root: checks Node, installs, builds, starts)
        npm run host -- [options]          (in web/: builds the client and the server, starts)

Options:
  --password <pw>   Password players type to join. Also read from FLAGHACK_PASSWORD.
                    Without either, the host makes up a memorable one and prints it.
  --port <n>        HTTP + WebSocket port (default ${DEFAULT_PORT}).
  --name "<name>"   Server name shown in the lobby (default: "<hostname>'s burn").
  --bind <address>  Listen on one address only, e.g. 127.0.0.1 (default: every interface).
  --allow-origin <origin>
                    Allow a remote browser client, e.g. https://elmorei.github.io.
                    Repeat for multiple origins, or set FLAGHACK_ALLOWED_ORIGINS (comma-separated).
                    Same-origin clients always work. Paths and wildcards are not allowed.
  -h, --help        Show this help.
`;

const FLAGS = ['--password', '--port', '--name', '--bind', '--allow-origin'];

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): HostArgs {
  const args: HostArgs = { help: false, password: null, port: DEFAULT_PORT, name: null, bind: null, allowedOrigins: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
      continue;
    }
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (!FLAGS.includes(flag)) throw new Error(`Unknown option ${arg}.`);
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === '--password') {
      if (!value.trim()) throw new Error('--password cannot be empty.');
      args.password = value;
    } else if (flag === '--port') {
      const port = Number(value);
      if (!/^\d+$/.test(value) || port > 65535) throw new Error(`--port must be a number from 0 to 65535 (got ${value}).`);
      args.port = port;
    } else if (flag === '--name') {
      args.name = value;
    } else if (flag === '--allow-origin') {
      args.allowedOrigins.push(value);
    } else {
      args.bind = value;
    }
  }
  const fromEnv = env.FLAGHACK_PASSWORD;
  if (args.password === null && fromEnv && fromEnv.trim()) args.password = fromEnv;
  if (args.allowedOrigins.length === 0 && env.FLAGHACK_ALLOWED_ORIGINS) {
    args.allowedOrigins = env.FLAGHACK_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  args.allowedOrigins = [...new Set(args.allowedOrigins)];
  browserOriginPolicy(args.allowedOrigins);
  return args;
}

/**
 * Lore words for generated passwords. Four distinct ones plus two digits: 128·127·126·125·90
 * ≈ 2^34.4 passwords, years of guessing at the host's throttle ceilings (see server/room.ts).
 */
export const PASSWORD_WORDS: readonly string[] = [
  'saffron', 'pentacle', 'ley', 'crystal', 'phason', 'hearth', 'canton', 'finial',
  'hoist', 'quiver', 'beacon', 'effigy', 'survey', 'omega', 'zeno', 'ward',
  'drum', 'dust', 'moop', 'flagplaid', 'vexil', 'aurum', 'crocus', 'signifier',
  'mesh', 'tide', 'facet', 'node', 'lattice', 'penrose', 'rhombus', 'robe',
  'moebius', 'regalia', 'canon', 'labyrinth', 'flagartha', 'flagistan', 'dialectic', 'simulacrum',
  'dawn', 'ember', 'banner', 'pole', 'fabric', 'yellow', 'jaguar', 'scarecrow',
  'crow', 'ritual', 'chakra', 'stencil', 'tarp', 'deck', 'ramp', 'playa',
  'airhorn', 'antenna', 'compass', 'ensign', 'gaskeeper', 'airlock', 'quintessence', 'oracle',
  'sigil', 'rune', 'glyph', 'aura', 'halo', 'prism', 'vertex', 'pentagrid',
  'kite', 'dart', 'spire', 'lantern', 'totem', 'sanctum', 'schism', 'antimeme',
  'noosphere', 'egregore', 'akashic', 'ekstasis', 'kindling', 'empyreal', 'veil', 'sphere',
  'excelsior', 'balaclava', 'harvard', 'nobel', 'furl', 'mainframe', 'degen', 'lora',
  'retransmit', 'porto', 'tent', 'burn', 'gate', 'plaid', 'bortle', 'longitude',
  'latitude', 'yard', 'meridian', 'horizon', 'zenith', 'nadir', 'solstice', 'equinox',
  'comet', 'quasar', 'pulsar', 'nebula', 'helix', 'spiral', 'axiom', 'theorem',
  'tiling', 'golden', 'vexillum', 'aurac', 'relic', 'chalice', 'pilgrim', 'caravan',
];

export function memorablePassword(): string {
  const picked = new Set<string>();
  while (picked.size < 4) picked.add(PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]);
  return `${[...picked].join('-')}-${randomInt(10, 100)}`;
}

export interface BannerInfo {
  serverName: string;
  port: number;
  bind: string | null;
  password: string;
  generatedPassword: boolean;
}

/** What the host prints on start: where to connect, the password, a share link and network tips. */
export function banner(b: BannerInfo): string[] {
  const bind = b.bind;
  let local = 'localhost';
  let lan: string[];
  let alone = '(no network address found: only this machine can join)';
  if (bind === null || bind === '0.0.0.0' || bind === '::') {
    lan = lanAddresses();
  } else if (bind === '127.0.0.1' || bind === '::1' || bind === 'localhost') {
    local = bind;
    lan = [];
    alone = `(listening on ${bind} only: other machines cannot join)`;
  } else {
    local = bind;
    lan = [bind];
  }
  const url = (host: string): string => `http://${host.includes(':') ? `[${host}]` : host}:${b.port}/`;
  const share = `${url(lan[0] ?? local)}#pw=${encodeURIComponent(b.password)}`;
  const lines = [
    '',
    `FLAGHACK ∞ host "${b.serverName}" is burning on port ${b.port}`,
    `  This machine:  ${url(local)}`,
  ];
  for (const address of lan) lines.push(`  LAN:           ${url(address)}`);
  if (lan.length === 0) lines.push(`  LAN:           ${alone}`);
  lines.push(
    `  Password:      ${b.password}${b.generatedPassword ? '   (made up for you; choose your own with --password)' : ''}`,
    `  Share link:    ${share}`,
    '',
    'Friends open the share link (or the LAN address, then type the password), pick a handle',
    'and take a seat. The first to join leads: NPC difficulty, seed and Start.',
    '',
    'Tips:',
    `  Ubuntu firewall:            sudo ufw allow ${b.port}/tcp`,
    `  Internet via your router:   forward TCP ${b.port} to this machine, share http://<your public IP>:${b.port}/#pw=...`,
    `  Internet, no forwarding:    cloudflared tunnel --url http://localhost:${b.port}`,
    `                              then share the https://...trycloudflare.com address it prints + #pw=...`,
    '',
    'Ctrl+C ends the burn.',
    '',
  );
  return lines;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
