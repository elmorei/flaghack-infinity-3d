import { endTime } from "../sim/matchSettings";
/**
 * Event feed (bottom-left): renders session.feed (shared with controls and other modules)
 * and translates GameEvents into lore-voice lines, banners and minimap flashes. Noisy event
 * families (pulls, KOs, recruits, decoherence) are aggregated over a short window so the feed
 * stays readable in a brawl.
 */
import type { FeedItem } from '../game/session';
import {
  CAPTURE,
  DAWN_TIME,
  GCC,
  SUDDEN_DEATH_PRESSURE_MULT,
  TIDE_INTERVAL_SUDDEN_DEATH,
  TIDE_WARNING,
} from '../sim/constants';
import type { GameEvent, Severity } from '../sim/events';
import type { V2, V3 } from '../sim/math';
import type { FactionId, Owner } from '../sim/types';
import type { World } from '../sim/world';
import { BUILDING_NAMES } from '../sim/systems/buildings';
import { CHAKRA_INFO, DRUG_INFO } from './catalog';
import { DAWN_BANNER_S, factionName, matchScreen, tutorialTarget } from './core';
import type { UiHost, UiPart } from './core';
import { el, fmtClock } from './dom';

const VISIBLE_ROWS = 6;
const ROW_LIFETIME_MS = 10_000;
const AGG_WINDOW_MS = 1200;

interface Aggregate {
  severity: Severity;
  count: number;
  firstAt: number;
  pos?: V2;
  render: (count: number) => string;
}

const VIA_TEXT: Record<'drumcircle' | 'gcc' | 'hand' | 'throw' | 'dialectics', string> = {
  drumcircle: 'at the Drum Circle',
  gcc: 'at the Geomantic Command Center',
  hand: 'for a handed Flag',
  throw: 'for a thrown Flag',
  dialectics: 'through Flagellian Dialectics',
};

const PIECE_NAME: Record<'wall' | 'floor' | 'ramp', string> = { wall: 'Tarp Walls', floor: 'Decks', ramp: 'Ramps' };

function flat(p: V3): V2 {
  return { x: p.x, z: p.z };
}

export class FeedPart implements UiPart {
  private host: UiHost;
  private list: HTMLElement;
  private rows = new Map<number, HTMLElement>();
  private lastId = 0;
  private aggregates = new Map<string, Aggregate>();
  /** Throttle stamps (performance.now()) for one-off warnings that may repeat quickly. */
  private throttles = new Map<string, number>();
  private nameRx: RegExp | null = null;
  private nameColor = new Map<string, string>();
  /** session.playerNames the tint table was built from (Controls replaces it per match). */
  private namesFor: Partial<Record<FactionId, string>> | null = null;

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    this.list = el('div', 'feed', parent);
    tutorialTarget(this.list, 'feed');
  }

  reset(world: World): void {
    this.aggregates.clear();
    this.throttles.clear();
    this.tintNames(world);
    for (const row of this.rows.values()) row.remove();
    this.rows.clear();
  }

  /**
   * Characters and, online, the Signifiers' handles are tinted with their camp's colour in feed
   * lines. Longest first, so a handle inside a character's name never splits it.
   */
  private tintNames(world: World): void {
    const handles = this.host.app.session.playerNames;
    this.namesFor = handles;
    this.nameColor.clear();
    for (const f of world.factions) {
      this.nameColor.set(f.name, f.css);
      const handle = handles[f.id];
      if (handle) this.nameColor.set(handle, f.css);
    }
    const names = [...this.nameColor.keys()].sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    this.nameRx = names.length > 0 ? new RegExp(`(${names.join('|')})`, 'g') : null;
  }

  onEvent(e: GameEvent, w: World): void {
    const s = this.host.app.session;
    if (!matchScreen(s.screen)) return;
    // A seatless online watcher has no camp: every line reads in the third person.
    const P: FactionId | null = s.spectator ? null : s.playerFaction;
    const name = (f: FactionId | null): string => factionName(w, f, s.playerNames);
    switch (e.t) {
      case 'flagPulled':
        if (e.prevOwner === P && e.faction !== P && e.faction !== -1) {
          const by = e.faction;
          this.bump(`pulledFrom${by}`, 'warn', flat(e.pos), (n) =>
            n > 1 ? `${name(by)} pulled ${n} of your Flags` : `${name(by)} pulled one of your Flags`,
          );
        } else if (e.faction === P && e.prevOwner !== P && e.prevOwner !== -1) {
          const from = e.prevOwner;
          this.bump(`pulledBy${from}`, 'good', undefined, (n) =>
            n > 1 ? `You pulled ${n} Flags from ${name(from)}` : `You pulled a Flag from ${name(from)}`,
          );
        }
        break;
      case 'flagDecohered':
        if (w.flags.get(e.flagId)?.owner === P) {
          this.bump('decohere', 'warn', flat(e.pos), (n) =>
            n > 1 ? `${n} of your Flags decohered as the Crystal turned` : 'One of your Flags decohered as the Crystal turned',
          );
        }
        break;
      case 'simulacrumCollapsed':
        if (e.faction === P) this.host.post('Your Simulacrum was observed and collapsed onto one node', 'info');
        break;
      case 'surveyChanged':
        if (e.faction === P && e.gained.length >= 3) {
          this.bumpBy('surveyUp', 'good', e.gained.length, (n) => `Survey expanded by ${n} facets (${e.size} enclosed)`);
        } else if (e.faction === P && e.lost.length >= 3) {
          this.bumpBy('surveyDown', 'danger', e.lost.length, (n) => `Your Survey lost ${n} facets (${e.size} left)`);
        }
        break;
      case 'tideWarning':
        this.host.post(`The Crystal is turning… Phason Tide in ${TIDE_WARNING} s. Close your loops.`, 'warn');
        break;
      case 'tide':
        // The wave sweeps the burn for e.duration seconds; keep the banner up until it has passed.
        this.host.banner({
          title: 'PHASON TIDE',
          sub: `The Crystal turns: ${e.flips} nodes turning · observed Flags hold`,
          tone: 'tide',
          dur: Math.max(2.6, (e.duration ?? 0) + 0.8),
        });
        break;
      case 'crystalManifest':
        if (e.faction === P) {
          this.host.banner({ title: 'CRYSTAL MANIFESTED', sub: 'Your pentacle holds: +Ritual, +pressure, +C.M.I.', tone: 'epic' });
          this.host.post('A Crystal manifests on your pentacle', 'epic', e.pos);
        } else {
          this.host.post(`${name(e.faction)} manifested a Crystal`, 'warn', e.pos);
        }
        break;
      case 'crystalShatter':
        if (e.faction === P) this.host.post('Your Crystal shattered', 'danger', e.pos);
        else this.host.post(`${name(e.faction)}'s Crystal shattered`, 'good', e.pos);
        break;
      case 'instability':
        if (e.level !== 'shimmer' && P !== null && w.inSurvey(e.facet, P) && this.throttle('instability', 12_000)) {
          this.host.post(
            e.level === 'storm' ? 'A phason storm rages inside your Survey' : 'Crystal discharge: interference inside your Survey',
            'warn',
            e.pos,
          );
        }
        break;
      case 'hearthStage':
        this.onHearthStage(e, w, P);
        break;
      case 'captured':
        if (e.to === P) {
          this.host.banner({ title: 'HEARTH CAPTURED', sub: `${name(this.ownerOf(e.from))}'s camp is now your outpost`, tone: 'epic' });
          this.host.post(`You captured ${name(this.ownerOf(e.from))}'s Hearth`, 'epic', e.pos);
        } else if (e.from === P) {
          this.host.post(`${name(e.to)} captured your Hearth`, 'danger', e.pos);
        } else {
          this.host.post(`${name(e.to)} captured ${name(this.ownerOf(e.from))}'s Hearth`, 'info', e.pos);
        }
        break;
      case 'eliminated':
        if (e.faction === P) {
          this.host.post('Your last Hearth has fallen', 'danger');
        } else {
          const f = w.factions[e.faction];
          this.host.banner({
            title: `${f ? name(f.id).toUpperCase() : 'A RIVAL'} ELIMINATED`,
            sub: P !== null && e.by === P ? 'Their Survey is yours' : e.by !== null ? `Overwritten by ${name(e.by)}` : 'The Crystal reclaims their Survey',
            tone: 'epic',
            color: f?.css,
          });
          this.host.post(`${name(e.faction)} has been eliminated`, P !== null && e.by === P ? 'epic' : 'info');
        }
        break;
      case 'burn':
        this.host.banner({
          title: 'THE BURN BEGINS',
          sub: `Sudden death · pressure ×${SUDDEN_DEATH_PRESSURE_MULT} and rising · Phason Tides every ${TIDE_INTERVAL_SUDDEN_DEATH} s`,
          tone: 'burn',
          dur: 4,
        });
        this.host.post(`The effigy burns. Sudden death until dawn at ${fmtClock(endTime(this.host.app.world!.options))}!`, 'epic');
        break;
      case 'victory':
        // A conquest needs no banner (the end screen says it); a dawn crowning gets its moment over the live burn.
        if (e.reason === 'dawn') {
          this.host.banner({
            title: 'DAWN OVER THE BURN',
            sub:
              P !== null && e.faction === P
                ? 'The Survey is completed. Your Survey stands dominant.'
                : `${name(e.faction)}'s Survey stands dominant.`,
            tone: 'dawn',
            dur: DAWN_BANNER_S,
            urgent: true,
          });
        }
        break;
      case 'ko':
        if (e.kind === 'avatar' && e.faction === P) {
          this.host.post('You were knocked Flagless. Respawning at your Hearth…', 'danger', flat(e.pos));
        } else if (e.kind === 'hippie' && e.faction === P) {
          const who = w.hippies.get(e.id)?.name ?? 'A Signifier';
          this.bump('ko', 'warn', flat(e.pos), (n) => (n > 1 ? `${n} of your Signifiers were knocked out` : `${who} was knocked out`));
        } else if (e.kind === 'avatar' && P !== null && e.faction !== -1 && e.by !== -1 && e.by === w.factions[P]?.avatarId) {
          this.host.post(`You knocked ${name(e.faction)} Flagless`, 'good', flat(e.pos));
        }
        break;
      case 'respawn':
        if (e.kind === 'avatar' && e.faction === P) this.host.post('You return to your Hearth', 'info');
        break;
      case 'recruited':
        if (e.faction === P) {
          const who = w.hippies.get(e.hippieId)?.name ?? 'A Signifier';
          const via = VIA_TEXT[e.via];
          this.bump(`recruit-${e.via}`, 'good', undefined, (n) =>
            n > 1 ? `${n} Signifiers joined your camp ${via}` : `${who} joined your camp ${via}`,
          );
        }
        break;
      case 'distracted':
        if (e.faction === P) {
          const who = w.hippies.get(e.hippieId)?.name ?? 'A Signifier';
          this.bump('distracted', 'info', undefined, (n) =>
            n > 1 ? `${n} Signifiers lost attention and wandered off` : `${who} lost attention and wandered off`,
          );
        }
        break;
      case 'pieceDestroyed':
        if (e.faction === P) {
          const kind = PIECE_NAME[e.kind];
          this.bump(`piece-${e.kind}`, 'warn', flat(e.pos), (n) => `${n} of your ${kind} torn down`);
        }
        break;
      case 'buildingPlaced':
        if (e.faction === P && e.kind !== 'hearth' && e.kind !== 'gcc') {
          this.host.post(`${BUILDING_NAMES[e.kind]} raised: construction begins`, 'info', e.pos);
        }
        break;
      case 'buildingDone':
        if (e.faction === P && e.kind !== 'hearth') this.host.post(`${BUILDING_NAMES[e.kind]} complete`, 'good', e.pos);
        break;
      case 'buildingDisabled':
        if (e.faction === P) this.host.post(`${BUILDING_NAMES[e.kind]} disabled. Signifiers can repair it`, 'danger', e.pos);
        break;
      case 'buildingRepaired':
        if (e.faction === P) this.host.post(`${BUILDING_NAMES[e.kind]} repaired`, 'good', e.pos);
        break;
      case 'brewed':
        if (e.faction === P) this.host.post(`A dose of ${DRUG_INFO[e.drug].name} is ready (${DRUG_INFO[e.drug].key})`, 'good');
        break;
      case 'drugUsed':
        if (e.faction === P) this.host.post(`${DRUG_INFO[e.drug].name} takes hold`, 'epic');
        break;
      case 'drugExpired':
        if (e.faction === P) {
          if (e.drug === 'saffron') this.host.post('The Saffron wears off… here comes the crash', 'warn');
          else this.host.post(`${DRUG_INFO[e.drug].name} wears off`, 'info');
        }
        break;
      case 'alignStart':
        if (e.faction === P) this.host.post(`Aligning the ${CHAKRA_INFO[e.chakra].name} chakra… hold still`, 'info');
        break;
      case 'aligned':
        if (e.faction === P) {
          const c = CHAKRA_INFO[e.chakra];
          this.host.banner({ title: `${c.name.toUpperCase()} ALIGNED`, sub: `${c.abilityName} · level ${e.level}`, tone: 'chakra' });
          this.host.post(`${c.name} chakra aligned: ${c.abilityName} level ${e.level} (${c.key})`, 'epic');
        }
        break;
      case 'alignInterrupted':
        if (e.faction === P) this.host.post(`The ${CHAKRA_INFO[e.chakra].name} alignment was interrupted`, 'warn');
        break;
      case 'gccAction':
        if (e.faction === P && e.action === 'dialectics') this.host.post('Flagellian Dialectics: the argument begins', 'info', e.pos);
        else if (e.faction === P && e.action === 'simulacra') this.host.post('A Flag Simulacrum enters superposition', 'good', e.pos);
        break;
      case 'gccDestroyed':
        if (e.faction === P) this.host.post(`Your Geomantic Command Center collapsed. Rebuilding in ${GCC.rebuildTime} s`, 'danger', e.pos);
        else this.host.post(`${name(e.faction)}'s Geomantic Command Center collapsed`, 'good', e.pos);
        break;
      case 'gccRebuilt':
        if (e.faction === P) this.host.post('Your Geomantic Command Center stands again', 'good', e.pos);
        break;
      case 'ping':
        if (e.faction === P && e.kind === 'sos' && this.throttle('sos', 4000)) {
          this.host.post('SOS on the mesh. Defenders are responding', 'warn', e.pos);
        }
        break;
      case 'meshTapped':
        if (e.faction === P) this.host.post(`Mesh tapped: ${name(e.target)}'s Signifiers revealed`, 'good');
        else if (e.target === P) this.host.post(`${name(e.faction)} is listening to your D.E.G.E.N. mesh`, 'warn');
        break;
      case 'retransmit':
        if (e.faction === P) this.host.post('TAKE A SHOT! The whole mesh perks up', 'good');
        break;
      case 'rejected':
        if (e.faction === P && this.throttle(`rej:${e.reason}`, 1500)) this.host.post(e.reason, 'warn');
        break;
      case 'notify':
        if (e.faction === 'all' || e.faction === P) this.host.post(e.text, e.severity, e.pos);
        break;
      default:
        break;
    }
  }

  update(world: World | null, now: number): void {
    if (world && this.host.app.session.playerNames !== this.namesFor) this.tintNames(world);
    for (const [key, a] of this.aggregates) {
      if (now - a.firstAt < AGG_WINDOW_MS) continue;
      this.host.post(a.render(a.count), a.severity, a.pos);
      this.aggregates.delete(key);
    }
    this.renderRows(this.host.app.session.feed, now);
  }

  private renderRows(feed: FeedItem[], now: number): void {
    for (const [id, row] of this.rows) {
      const item = feed.find((f) => f.id === id);
      if (!item || now - item.at > ROW_LIFETIME_MS) {
        row.remove();
        this.rows.delete(id);
      }
    }
    for (const item of feed) {
      if (item.id <= this.lastId) continue;
      this.lastId = item.id;
      if (now - item.at > ROW_LIFETIME_MS) continue;
      this.rows.set(item.id, this.buildRow(item));
    }
    while (this.rows.size > VISIBLE_ROWS) {
      const oldest = this.rows.keys().next();
      if (oldest.done) break;
      this.rows.get(oldest.value)?.remove();
      this.rows.delete(oldest.value);
    }
  }

  private buildRow(item: FeedItem): HTMLElement {
    const row = el('div', `feed-row sev-${item.severity}`, this.list);
    el('span', 'feed-pip', row);
    const text = el('span', 'feed-text', row);
    // Faction names are tinted with their colour; text is never parsed as HTML.
    if (this.nameRx) {
      for (const part of item.text.split(this.nameRx)) {
        const color = this.nameColor.get(part);
        if (color) {
          const span = el('span', 'feed-name', text, part);
          span.style.color = color;
        } else if (part) {
          text.appendChild(document.createTextNode(part));
        }
      }
    } else {
      text.textContent = item.text;
    }
    if (item.pos && (item.severity === 'danger' || item.severity === 'epic')) {
      this.host.flash(item.pos, item.severity === 'danger' ? '#ff4058' : '#ffd400');
    }
    return row;
  }

  private bump(key: string, severity: Severity, pos: V2 | undefined, render: (count: number) => string): void {
    this.bumpBy(key, severity, 1, render, pos);
  }

  private bumpBy(key: string, severity: Severity, amount: number, render: (count: number) => string, pos?: V2): void {
    const a = this.aggregates.get(key);
    if (a) {
      a.count += amount;
      a.render = render;
      return;
    }
    this.aggregates.set(key, { severity, count: amount, firstAt: performance.now(), pos, render });
  }

  /** True when `key` has not fired within `ms` (and stamps it). */
  private throttle(key: string, ms: number): boolean {
    const now = performance.now();
    const last = this.throttles.get(key);
    if (last !== undefined && now - last < ms) return false;
    this.throttles.set(key, now);
    return true;
  }

  private ownerOf(o: Owner): FactionId | null {
    return o === -1 ? null : o;
  }

  private onHearthStage(e: Extract<GameEvent, { t: 'hearthStage' }>, w: World, P: FactionId | null): void {
    const name = (f: FactionId | null): string => factionName(w, f, this.host.app.session.playerNames);
    const owner = this.ownerOf(e.faction);
    const pos = w.buildings.get(e.hearthId)?.pos;
    if (P !== null && owner === P) {
      switch (e.stage) {
        case 'threatened':
          if (e.prev === 'safe') this.host.post(`Your Hearth is threatened by ${name(e.attacker)}`, 'warn', pos);
          break;
        case 'contained':
          this.host.banner({ title: 'HEARTH CONTAINED', sub: `${name(e.attacker)} has enclosed your Hearth. Pull a loop Flag or Hold the Hearth!`, tone: 'danger', dur: 3.4 });
          this.host.post(`${name(e.attacker)} contains your Hearth`, 'danger', pos);
          break;
        case 'contested':
          this.host.post(
            `You Hold the Hearth in person: pressure builds at ${Math.round(CAPTURE.contestedMult * 100)}% while you stay within ${CAPTURE.holdRadius} m`,
            'warn',
            pos,
          );
          break;
        case 'overwritten':
          this.host.banner({ title: 'OVERWRITTEN', sub: `Your Hearth falls in ${CAPTURE.overwriteTime} s`, tone: 'danger', dur: CAPTURE.overwriteTime });
          break;
        case 'safe':
          if (e.prev === 'contained' || e.prev === 'contested') this.host.post('Your Hearth is safe again', 'good', pos);
          break;
        default:
          break;
      }
    } else if (P !== null && e.attacker === P && owner !== null) {
      const color = w.factions[owner]?.css;
      switch (e.stage) {
        case 'threatened':
          if (e.prev === 'safe') this.host.post(`Your Survey threatens ${name(owner)}'s Hearth`, 'info', pos);
          break;
        case 'contained':
          this.host.banner({ title: 'HEARTH CONTAINED', sub: `${name(owner)}'s Hearth is inside your Survey`, tone: 'good', color });
          this.host.post(`You contain ${name(owner)}'s Hearth. Hold the loop!`, 'good', pos);
          break;
        case 'overwritten':
          this.host.banner({ title: 'OVERWRITTEN', sub: `${name(owner)}'s camp falls to you`, tone: 'epic', color });
          break;
        default:
          break;
      }
    } else if (owner !== null && (e.stage === 'contained' || e.stage === 'overwritten')) {
      this.host.post(`${name(e.attacker)} ${e.stage === 'contained' ? 'contains' : 'overwrites'} ${name(owner)}'s Hearth`, 'info', pos);
    }
  }

  dispose(): void {
    this.list.remove();
  }
}
