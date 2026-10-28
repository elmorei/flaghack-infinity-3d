/**
 * Client-side online session API (what the UI reads and calls). Implemented by net/client.ts;
 * the App exposes the active one as `app.net`. The UI polls: compare `version` each update.
 */
import type { FactionId } from '../sim/types';
import type { ChatLine, LobbySettings, LobbyState } from './protocol';

/**
 * connecting → joining (hello sent) → lobby ⇄ match → closed.
 * 'closed' carries `error` when it was not a voluntary leave (bad password, host gone, …).
 */
export type NetStatus = 'connecting' | 'joining' | 'lobby' | 'match' | 'closed';

export interface NetSession {
  readonly status: NetStatus;
  /** Human-readable reason for a denial or lost connection, else null. */
  readonly error: string | null;
  /** Increments on every change to anything below (UI polls and compares). */
  readonly version: number;
  readonly serverName: string;
  readonly lobby: LobbyState | null;
  /** Local cumulative setup while awaiting the host; never authoritative simulation state. */
  readonly setupSettings: LobbySettings | null;
  readonly settingsPending: boolean;
  readonly settingsError: string | null;
  readonly startPending: boolean;
  readonly playerId: string | null;
  /** This client's seat (null: spectator or not yet seated). */
  readonly seat: FactionId | null;
  readonly isLeader: boolean;
  readonly chat: readonly ChatLine[];
  /** Smoothed round-trip time (ms), 0 until measured. */
  readonly ping: number;
  /** True while the connection is down and the client is retrying with its token. */
  readonly reconnecting: boolean;
  /** Host notices ("The host is shutting down"), newest last. */
  readonly notices: readonly string[];
  /** Requested camp while waiting for the authoritative handoff snapshot. */
  readonly pendingBossTakeover: FactionId | null;
  readonly bossTakeoverError: string | null;

  setSeat(seat: FactionId | null): void;
  requestBossTakeover(seat: FactionId): void;
  setReady(ready: boolean): void;
  /** Leader only. */
  setSettings(settings: Partial<LobbySettings>): void;
  /** Leader only. */
  start(): void;
  /** Leader only, after the match ended. */
  backToLobby(): void;
  sendChat(text: string): void;
  /** Disconnect for good and return to the local title screen. */
  leave(): void;
}
