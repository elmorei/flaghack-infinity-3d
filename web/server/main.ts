/**
 * Entry point of the host process (bundled to dist-server/main.js): parse the command line,
 * start the host, print where to connect, stop gracefully on Ctrl+C / SIGTERM.
 */
import { banner, memorablePassword, parseArgs, USAGE } from './cli';
import type { HostArgs } from './cli';
import { startHost } from './host';
import type { RunningHost } from './host';

/** Gracefully closing sockets may take a moment; after this the process exits regardless. */
const FORCE_EXIT_MS = 3000;

async function main(): Promise<void> {
  let args: HostArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('Run with --help for the options.');
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  // Last resort: a bug must not end everyone's burn. Handlers already catch client-caused errors.
  process.on('uncaughtException', (err) => console.error('host error (still running):', err));
  process.on('unhandledRejection', (err) => console.error('host error (still running):', err));

  const password = args.password ?? memorablePassword();
  let host: RunningHost;
  try {
    host = await startHost({ password, port: args.port, bind: args.bind ?? undefined, serverName: args.name ?? undefined, allowedOrigins: args.allowedOrigins });
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : null;
    if (code === 'EADDRINUSE') console.error(`Port ${args.port} is already in use (another host running?). Pick another with --port.`);
    else if (code === 'EACCES') console.error(`Not allowed to listen on port ${args.port}. Ports below 1024 need root: pick another with --port.`);
    else console.error('The host could not start:', err);
    process.exit(1);
  }
  for (const line of banner({ serverName: host.serverName, port: host.port, bind: args.bind, password, generatedPassword: args.password === null })) {
    console.log(line);
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${signal}: telling everyone and closing the burn...`);
    setTimeout(() => process.exit(0), FORCE_EXIT_MS).unref();
    host.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

void main();
