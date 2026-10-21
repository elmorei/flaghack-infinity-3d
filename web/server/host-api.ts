/** Importable entry for the standalone host app. Importing this module never starts a server. */
export { startHost } from './host';
export type { HostOptions, RunningHost } from './host';
export { BUILD_ID } from '../src/net/build';
export { PROTOCOL_VERSION } from '../src/net/protocol';
