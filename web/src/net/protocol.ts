/**
 * FLAGHACK ∞ multiplayer wire protocol (contract shared by the host server, the browser client,
 * the replication codec and the UI). Transport: one WebSocket per player at WS_PATH on the
 * host's HTTP port, JSON text frames, permessage-deflate. The host is authoritative: it runs
 * the only Simulation (plus AI for every seat without a connected human) and clients render a
 * replicated mirror of its World.
 *
 * Flow:
 *   client                                   host
 *   hello{name,password,token} ───────────▶  validate (constant-time), throttle failures
 *                             ◀───────────  welcome{playerId,token,lobby} | denied{reason}
 *   seat / ready / settings / start / chat ▶  lobby broadcast to everyone
 *                             ◀───────────  matchStart{options, seat, snapshot}   (also on rejoin)
 *   input{seq, input, cmds} @ 60 Hz ──────▶  per-player FIFO, one frame consumed per sim tick
 *                             ◀───────────  state{frame} @ NET_HZ (shared by all clients)
 *   ping ─────────────────────────────────▶  pong (RTT, server clock)
 *   backToLobby (leader, after match end) ▶  lobby
 */
import type { AvatarInput, Difficulty, FactionId, MatchOptions } from '../sim/types';
import type { Command } from '../sim/commands';
import type { GameEvent } from '../sim/events';
import type { DeltaSnapshot, FullSnapshot } from './codec';

/** Bump on any incompatible change; mismatched clients are denied with a reload hint. */
export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 8787;
export const WS_PATH = '/ws';
/** GET → HostInfo (JSON). Only a host server answers it: the client uses it to detect online mode. */
export const INFO_PATH = '/api/info';
/** State frames per second (every second sim tick at 60 Hz). */
export const NET_HZ = 30;
export const MAX_NAME_LENGTH = 24;
export const MAX_CHAT_LENGTH = 280;
/** Largest client message the host accepts (bytes); bigger frames close the socket. */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
/** Longest lobby map seed the host keeps (code points). */
export const MAX_SEED_LENGTH = 64;
/** Most commands one `input` frame may carry; the host drops bigger frames whole, so spill extras into the next frame. */
export const MAX_FRAME_COMMANDS = 16;
/** Seats are the four factions; further players spectate. */
export const SEAT_COUNT = 4;

export interface HostInfo {
  serverName: string;
  protocol: number;
  phase: LobbyPhase;
  /** Connected players (seated + spectators). */
  players: number;
  /** Seats currently held by humans. */
  seated: number;
}

export type LobbyPhase = 'lobby' | 'playing' | 'ended';

export interface LobbySettings {
  match?: import("../sim/matchSettings").MatchSettings;
  /** Difficulty of the AI seats. */
  difficulty: Difficulty;
  /** Map seed; null = a fresh random burn each match. */
  seed: string | null;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  /** Faction seat, or null for a spectator. */
  seat: FactionId | null;
  ready: boolean;
  connected: boolean;
  /** Smoothed round-trip time (ms) as measured by the host, 0 if unknown. */
  ping: number;
}

export interface LobbyState {
  serverName: string;
  phase: LobbyPhase;
  /** Player who may change settings, start the match and return to the lobby. */
  leaderId: string | null;
  settings: LobbySettings;
  /** Index = faction id. playerId null ⇒ the seat is played by the AI. */
  seats: { faction: FactionId; playerId: string | null }[];
  players: LobbyPlayer[];
  /** During 'playing'/'ended': elapsed match time (s) and the winner (null while running). */
  match: { time: number; winner: FactionId | null } | null;
}

export type DenyReason = 'password' | 'protocol' | 'full' | 'name' | 'throttled' | 'banned';

export interface ChatLine {
  /** Sender handle, or null for a host/system line ("alice joined the burn"). */
  from: string | null;
  playerId: string | null;
  seat: FactionId | null;
  text: string;
  /** Host wall clock (ms since epoch). */
  at: number;
}

/**
 * One replication frame. Shared by every client (identical bytes), so per-player data travels
 * in maps keyed by playerId.
 */
export interface StateFrame {
  tick: number;
  /** World time (s) after `tick`. */
  time: number;
  /** Last input `seq` the host consumed for each player (client prediction reconciles to it). */
  acks: Record<string, number>;
  delta: DeltaSnapshot;
  /** Every GameEvent emitted since the previous frame, in emission order. */
  events: GameEvent[];
}

// ── Client → host ────────────────────────────────────────────────────────────
export type ClientMessage =
  /** First message. `token` (from a previous welcome) reclaims the same player/seat. */
  | { t: 'hello'; protocol: number; name: string; password: string; token: string | null }
  /** Lobby: take a seat (null = spectate). In a running match only an AI-held, alive seat can be taken. */
  | { t: 'seat'; seat: FactionId | null }
  | { t: 'ready'; ready: boolean }
  /** Leader only. */
  | { t: 'settings'; settings: Partial<LobbySettings> }
  /** Leader only: start the match (empty seats are AI). */
  | { t: 'start' }
  /** Leader only, after the match ended. */
  | { t: 'backToLobby' }
  | { t: 'chat'; text: string }
  /**
   * One client sim tick: the avatar input for that tick plus discrete commands queued since the
   * previous frame. `seq` increases by 1 per tick from 1 for each match. The host stamps every
   * command's `faction` with the sender's seat; spectators' inputs are ignored.
   */
  | { t: 'input'; seq: number; input: AvatarInput; cmds: Command[] }
  | { t: 'ping'; id: number; clientTime: number };

// ── Host → client ────────────────────────────────────────────────────────────
export type ServerMessage =
  | { t: 'welcome'; protocol: number; playerId: string; token: string; lobby: LobbyState }
  | { t: 'denied'; reason: DenyReason; message: string }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'chat'; line: ChatLine }
  /**
   * Sent to everyone when a match starts, and to a single client that (re)joins mid-match.
   * The client rebuilds static content with createMatch(options) and overwrites every dynamic
   * field from `snapshot` (see net/mirror.ts). `seat` is this client's faction (null: spectator).
   */
  | { t: 'matchStart'; options: MatchOptions; seat: FactionId | null; snapshot: FullSnapshot }
  | { t: 'state'; frame: StateFrame }
  | { t: 'pong'; id: number; clientTime: number; serverTime: number }
  /** Host notices shown as a banner (e.g. "The host is shutting down"). */
  | { t: 'notice'; text: string };
