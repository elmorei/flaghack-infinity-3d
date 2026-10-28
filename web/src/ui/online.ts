/**
 * Small online helpers shared by the lobby, the standings, the connection pill, the end screen
 * and the seat chooser: who holds a seat, who leads, how good a ping is, who may take a camp
 * mid-burn. Pure reads of the NetSession and World state.
 */
import { bossTakeoverSeats, isBossTakeoverActive } from '../sim/bossTakeover';
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
  const s = app.session;
  if (!app.net || !matchScreen(s.screen)) return false;
  if (isBossTakeoverActive(world)) return canRecoverBossCamp(app, world);
  return s.spectator || !(world.factions[s.playerFaction]?.alive ?? false);
}

/**
 * A camp a watcher may take over mid-burn: alive, and steered by the rivals' AI (no Signifier
 * holds the seat, or theirs is away). The host refuses an away seat for its first few seconds.
 */
export function takeableSeat(world: World, lobby: LobbyState | null, f: FactionId): boolean {
  if (lobby?.phase !== 'playing' || !(world.factions[f]?.alive ?? false)) return false;
  if (isBossTakeoverActive(world)) return lobby.seats.some((seat) => seat.faction === f && seat.playerId === null);
  const holder = seatPlayer(lobby, f);
  return !holder || !holder.connected;
}

/** Only an eliminated participant gets the encounter's second chance; joining as a watcher never does. */
export function canRecoverBossCamp(app: AppApi, world: World): boolean {
  const s = app.session;
  return isBossTakeoverActive(world) && !s.spectator &&
    world.options.humans.includes(s.playerFaction) && !world.factions[s.playerFaction].alive &&
    (!app.net || app.net.seat === s.playerFaction);
}

/** Available choices for either the encounter recovery or the ordinary online camp picker. */
export function campChoices(app: AppApi, world: World): FactionId[] {
  if (isBossTakeoverActive(world)) {
    if (!canRecoverBossCamp(app, world)) return [];
    const aiSeats = app.net
      ? app.net.lobby?.seats.filter((seat) => seat.playerId === null).map((seat) => seat.faction) ?? []
      : FACTION_IDS.filter((f) => !world.options.humans.includes(f));
    return bossTakeoverSeats(world, app.session.playerFaction, aiSeats);
  }
  const rtsOnly = app.net?.lobby?.players.find(p => p.id === app.net?.playerId)?.controlMode === 'rts';
  return watchingOnline(app, world) ? FACTION_IDS.filter((f) => (!rtsOnly || world.factions[f].controlMode === 'rts') && takeableSeat(world, app.net?.lobby ?? null, f)) : [];
}
