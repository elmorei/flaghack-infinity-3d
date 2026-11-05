import { npcTakeoverSeats } from '../sim/npcTakeover';
/**
 * Small online helpers shared by the lobby, the standings, the connection pill, the end screen
 * and the seat chooser: who holds a seat, who leads, how good a ping is, who may take a camp
 * mid-burn. Pure reads of the NetSession and World state.
 */
import { FACTION_IDS } from '../sim/types';
import type { AppApi } from '../game/app';
import type { LobbyPlayer, LobbyState } from '../net/protocol';
import type { FactionId } from '../sim/types';
import type { World } from '../sim/world';
import { matchScreen } from './core';

export type PingTone = 'good' | 'fair' | 'poor' | 'unknown';

/** Round-trip bands: under 90 ms feels local, under 180 ms is playable, above that drags. */
export function pingTone(ms: number): PingTone {
  if (ms <= 0) return 'unknown';
  return ms < 90 ? 'good' : ms < 180 ? 'fair' : 'poor';
}

/** "42 ms", or a dash until the host has measured anything. */
export function fmtPing(ms: number): string {
  return ms > 0 ? `${Math.round(ms)} ms` : '—';
}

/** The human holding a seat (connected or lost), or null when the rivals' AI plays it. */
export function seatPlayer(lobby: LobbyState | null, f: FactionId): LobbyPlayer | null {
  const id = lobby?.seats[f]?.playerId ?? null;
  if (id === null || !lobby) return null;
  return lobby.players.find((p) => p.id === id) ?? null;
}

/** The leader's handle (settings, Start, Back to lobby), or null between leaders. */
export function leaderName(lobby: LobbyState | null): string | null {
  if (!lobby?.leaderId) return null;
  return lobby.players.find((p) => p.id === lobby.leaderId)?.name ?? null;
}

/** Online and not commanding a living camp: a seatless watcher, or a Signifier whose camp fell. */
export function watchingOnline(app: AppApi, world: World): boolean {
  return !!app.net && matchScreen(app.session.screen) && world.phase === 'playing' &&
    (app.session.spectator || !world.factions[app.session.playerFaction]?.alive);
}

/**
 * A camp a watcher may take over mid-burn: alive, and steered by the rivals' AI (no Signifier
 * holds the seat). A disconnected human retains the reservation while their NPC stands in.
 */
export function takeableSeat(world: World, lobby: LobbyState | null, f: FactionId): boolean {
  return lobby?.phase === 'playing' && !!world.factions[f]?.alive &&
    lobby.seats.some(seat => seat.faction === f && seat.playerId === null);
}

/** An eliminated participant may keep playing in an available camp; spectators use campChoices. */
export function canRecoverBossCamp(app: AppApi, world: World): boolean {
  const s = app.session;
  return world.phase === 'playing' && !world.bossOutcome && !s.spectator &&
    world.options.humans.includes(s.playerFaction) && !world.factions[s.playerFaction].alive &&
    (!app.net || app.net.seat === s.playerFaction);
}

/** Available choices for either the encounter recovery or the ordinary online camp picker. */
export function campChoices(app: AppApi, world: World): FactionId[] {
  if (!canRecoverBossCamp(app, world) && !watchingOnline(app, world)) return [];
  const aiSeats = app.net
    ? app.net.lobby?.seats.filter(seat => seat.playerId === null).map(seat => seat.faction) ?? []
    : FACTION_IDS.filter(f => !world.options.humans.includes(f));
  return npcTakeoverSeats(world, app.session.spectator ? null : app.session.playerFaction, aiSeats);
}
