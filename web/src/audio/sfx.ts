/**
 * Event SFX: one recipe per GameEvent that matters (design §14), plus UI blips and the
 * fireworks/alarm voices the soundscape triggers over time. Positional where the event has a
 * position; the player's own non-spatial moments (Survey gained, alignment, drugs, rejections)
 * play centred. Every pitched sound is in A minor pentatonic; plant chimes are keyed to the
 * planted node's 5D Ley coordinate so every node of the Crystal sings its own note.
 */
import type { V2 } from '../sim/math';
import type { GameEvent } from '../sim/events';
import { CHAKRAS } from '../sim/types';
import type { AbilityId, CaptureStage, ChakraId, DrugId, FactionId, GccAction, Owner, PingKind } from '../sim/types';
import type { World } from '../sim/world';
import type { AudioEngine, VoiceHandle } from './engine';
import { FESTIVAL_BPM } from '../sim/constants';
import { degreeHz, midiHz, nodeDegree } from './scale';
import { bell, brass, choir, envelope, fm, noise, tone } from './synth';

/** Who "I" am for this event batch: the player faction, or none on the title screen. */
export interface Perspective {
  me: FactionId | -1;
  /** The player's avatar entity id (-1 on the title screen). */
  myAvatar: number;
}

/** True when faction `f` is the player's (never on the title screen). */
function isMine(p: Perspective, f: number): boolean {
  return p.me !== -1 && f === p.me;
}

export class Sfx {
  private e: AudioEngine;
  private hornCurve: Float32Array<ArrayBuffer>;

  constructor(engine: AudioEngine) {
    this.e = engine;
    // Soft-clip curve: the airhorn's reedy blare comes from overdriving a saw stack.
    const n = 1024;
    this.hornCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      this.hornCurve[i] = Math.tanh(x * 3.2);
    }
  }

  play(ev: GameEvent, w: World, p: Perspective): void {
    switch (ev.t) {
      case 'flagPlanted':
        this.plant(w, ev.node, ev.pos, isMine(p, ev.faction));
        break;
      case 'flagPulled':
        this.pull(w, ev.node, ev.pos, isMine(p, ev.faction));
        if (p.me !== -1 && ev.prevOwner === p.me && !isMine(p, ev.faction)) this.warnBlip();
        break;
      case 'flagThrown':
        this.whoosh(ev.from, isMine(p, ev.faction) ? 0.7 : 0.45, 'throw', 0.32);
        break;
      case 'flagLanded':
        this.thud(ev.pos, 0.5);
        break;
      case 'flagDecohered':
        this.decohere(w, ev.node, ev.pos);
        break;
      case 'flagCrafted':
        if (isMine(p, ev.faction)) this.crafted(w, ev.at);
        break;
      case 'simulacrumCollapsed':
        if (isMine(p, ev.faction)) this.collapse(w, ev.kept);
        break;
      case 'leyLine':
        this.ley(w, ev.edge, ev.on, isMine(p, ev.faction));
        break;
      case 'facetCrystallized':
        this.facetTing(w, ev.facet, isMine(p, ev.faction));
        break;
      case 'surveyChanged':
        this.survey(w, ev.faction, ev.gained, ev.lost, isMine(p, ev.faction));
        break;
      case 'phasonFlip':
        this.phason(ev.to, ev.cause === 'ability' ? 1 : 0.6);
        break;
      case 'tideWarning':
        this.tideWarning();
        break;
      case 'tide':
        this.tide(ev.flips);
        break;
      case 'crystalManifest':
        this.crystalManifest(w, ev.node, ev.pos, isMine(p, ev.faction));
        break;
      case 'crystalShatter':
        this.crystalShatter(ev.pos, isMine(p, ev.faction));
        break;
      case 'instability':
        this.instability(ev.level, ev.pos);
        break;
      case 'discharge':
        this.discharge(ev.to);
        break;
      case 'hearthStage':
        this.hearthStage(ev.faction, ev.stage, ev.prev, ev.attacker, p);
        break;
      case 'captured':
        this.captured(ev.pos, ev.from === p.me && p.me !== -1, isMine(p, ev.to));
        break;
      case 'eliminated':
        this.eliminated(isMine(p, ev.faction));
        break;
      case 'victory':
        this.victory(p.me === -1 || isMine(p, ev.faction));
        break;
      case 'burn':
        this.burn(w);
        break;
      case 'swing':
        this.whoosh(ev.pos, ev.by === p.myAvatar ? 0.6 : 0.4, 'swing', 0.16);
        break;
      case 'hit':
        this.hit(ev.pos, ev.amount, ev.target === p.myAvatar);
        break;
      case 'ko':
        this.ko(ev.pos, ev.kind === 'avatar', ev.id === p.myAvatar);
        break;
      case 'respawn':
        if (ev.id === p.myAvatar) this.respawn();
        break;
      case 'recruited': {
        const h = w.hippies.get(ev.hippieId);
        if (h) this.recruited(h.pos, isMine(p, ev.faction));
        break;
      }
      case 'distracted': {
        const h = w.hippies.get(ev.hippieId);
        if (h) this.distracted(h.pos);
        break;
      }
      case 'harvest':
        this.chop(ev.pos);
        break;
      case 'lumberDelivered':
        if (isMine(p, ev.faction)) this.lumber(ev.pos);
        break;
      case 'pieceBuilt':
        this.piecePop(ev.pos, ev.kind, isMine(p, ev.faction));
        break;
      case 'pieceDestroyed':
        this.crash(ev.pos, 0.8, 1);
        break;
      case 'buildingPlaced':
        this.hammer(ev.pos, isMine(p, ev.faction) ? 0.7 : 0.5);
        break;
      case 'buildingDone':
        this.jingle(ev.pos, isMine(p, ev.faction));
        break;
      case 'buildingDisabled':
        this.powerDown(ev.pos);
        break;
      case 'buildingRepaired':
        this.powerUp(ev.pos);
        break;
      case 'wardPulse':
        this.wardZap(ev.pos);
        break;
      case 'brewed':
        if (isMine(p, ev.faction)) this.bubbles();
        break;
      case 'drugUsed':
        if (isMine(p, ev.faction)) this.drug(ev.drug);
        break;
      case 'drugExpired':
        if (isMine(p, ev.faction)) this.fadeBlip();
        break;
      case 'alignStart':
        if (isMine(p, ev.faction)) this.alignDrone(ev.chakra);
        break;
      case 'aligned':
        if (isMine(p, ev.faction)) this.aligned(ev.chakra, ev.level);
        break;
      case 'alignInterrupted':
        if (isMine(p, ev.faction)) this.alignBroken(ev.chakra);
        break;
      case 'ability':
        this.ability(ev.ability, ev.pos, isMine(p, ev.faction));
        break;
      case 'gccAction':
        this.gcc(ev.action, ev.pos, isMine(p, ev.faction));
        break;
      case 'gccDestroyed':
        this.crash(ev.pos, 1, 2.5);
        break;
      case 'gccRebuilt':
        this.jingle(ev.pos, isMine(p, ev.faction));
        break;
      case 'ping':
        if (isMine(p, ev.faction)) this.loraChirp(ev.kind, ev.pos);
        break;
      case 'meshTapped':
        if (isMine(p, ev.faction)) this.meshTap();
        break;
      case 'retransmit': {
        const fs = w.factions[ev.faction];
        const av = fs ? w.avatars.get(fs.avatarId) : undefined;
        this.airhorn(isMine(p, ev.faction) || !av ? undefined : av.pos);
        break;
      }
      case 'rejected':
        if (isMine(p, ev.faction)) this.uiError();
        break;
      default:
        break;
    }
  }

  // ── Flags ──────────────────────────────────────────────────────────────────
  /** Wooden thunk + the node's own pentatonic chime. */
  private plant(w: World, node: number, at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'plant', at, dur: 2.4, gain: mine ? 0.95 : 0.75, wet: 0.35, priority: mine ? 2 : 1 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { f: 170, f2: 52, glide: 0.09, env: { d: 0.16, peak: 0.85 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 950, q: 1.6, env: { d: 0.05, peak: 0.45 } });
    const deg = node >= 0 ? nodeDegree(w.lattice, node) : 0;
    const f = degreeHz(deg + 10);
    bell(c, v.input, v.t + 0.025, f, 1.9, 0.32);
    if (mine) fm(c, v.input, v.t + 0.03, f * 2, 3.5, 1.1, { a: 0.01, d: 0.7, peak: 0.05 });
  }

  /** Yank + the node's chime played backwards (a swell cut short). */
  private pull(w: World, node: number, at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'pull', at, dur: 0.8, gain: mine ? 0.9 : 0.7, wet: 0.25, priority: mine ? 2 : 1 });
    if (!v) return;
    const c = this.e.ctx;
    const deg = node >= 0 ? nodeDegree(w.lattice, node) : 0;
    const f = degreeHz(deg + 10);
    tone(c, v.input, v.t, { f, env: { a: 0.32, d: 0.04, peak: 0.24 } });
    tone(c, v.input, v.t, { f: f * 2.76, env: { a: 0.3, d: 0.03, peak: 0.07 } });
    noise(c, v.input, v.t + 0.3, { buf: this.e.white, filter: 'bandpass', f: 380, f2: 2600, sweep: 0.12, q: 1.4, env: { a: 0.01, d: 0.16, peak: 0.55 } });
    tone(c, v.input, v.t + 0.3, { type: 'sawtooth', f: 190, f2: 105, glide: 0.12, env: { d: 0.13, peak: 0.07 } });
  }

  private whoosh(at: V2, gain: number, key: string, len: number): void {
    const v = this.e.voice({ key, at, dur: len + 0.1, gain, wet: 0.1, priority: 0 });
    if (!v) return;
    noise(this.e.ctx, v.input, v.t, {
      buf: this.e.white,
      filter: 'bandpass',
      f: 320,
      f2: 2400,
      sweep: len * 0.6,
      q: 1.3,
      env: { a: len * 0.35, d: len * 0.65, peak: 0.6 },
    });
  }

  private thud(at: V2, gain: number): void {
    const v = this.e.voice({ key: 'land', at, dur: 0.3, gain, wet: 0.1 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { f: 115, f2: 48, glide: 0.1, env: { d: 0.14, peak: 0.7 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'lowpass', f: 520, env: { d: 0.08, peak: 0.35 } });
  }

  /** A Flag losing its classical state: the node note bending away into glass grains. */
  private decohere(w: World, node: number, at: V2): void {
    const v = this.e.voice({ key: 'phason', at, dur: 1.2, gain: 0.7, wet: 0.5 });
    if (!v) return;
    const c = this.e.ctx;
    const f = degreeHz((node >= 0 ? nodeDegree(w.lattice, node) : 0) + 15);
    tone(c, v.input, v.t, { f, f2: f * 0.5, glide: 0.9, vib: 35, vibRate: 7, env: { a: 0.02, d: 0.95, peak: 0.18 } });
    this.grains(v, v.t, 6, 0.5, 2000, 6000, 0.07);
  }

  private crafted(w: World, at: number): void {
    const b = w.buildings.get(at);
    const v = this.e.voice({ key: 'craft', at: b?.pos, range: 3, dur: 1.2, gain: 0.55, wet: 0.3 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { type: 'triangle', f: 620, env: { d: 0.04, peak: 0.25 } });
    bell(c, v.input, v.t + 0.06, degreeHz(22), 0.9, 0.18);
  }

  /** Superposed twin collapses: two detuned bells converge onto one note. */
  private collapse(w: World, kept: number): void {
    const v = this.e.voice({ key: 'collapse', dur: 1.6, gain: 0.6, wet: 0.5, priority: 2 });
    if (!v) return;
    const c = this.e.ctx;
    const f = degreeHz((kept >= 0 ? nodeDegree(w.lattice, kept) : 0) + 15);
    tone(c, v.input, v.t, { f: f * 1.07, f2: f, glide: 0.45, env: { a: 0.01, d: 1.3, peak: 0.16 } });
    tone(c, v.input, v.t, { f: f * 0.93, f2: f, glide: 0.45, env: { a: 0.01, d: 1.3, peak: 0.16 } });
    bell(c, v.input, v.t + 0.45, f * 2, 0.9, 0.12);
  }

  // ── Survey geometry ────────────────────────────────────────────────────────
  /** Ley Line hum: a soft dyad of its two endpoint notes (each family has its own interval). */
  private ley(w: World, edge: number, on: boolean, mine: boolean): void {
    const ed = w.lattice.edges[edge];
    if (!ed) return;
    const a = w.lattice.nodes[ed.a];
    const b = w.lattice.nodes[ed.b];
    const at = { x: (a.x + b.x) * 0.5, z: (a.z + b.z) * 0.5 };
    const v = this.e.voice({ key: on ? 'ley' : 'leyOff', at, dur: on ? 1.8 : 0.9, gain: mine ? 0.8 : 0.55, wet: 0.45, priority: 0 });
    if (!v) return;
    const c = this.e.ctx;
    const f1 = degreeHz(nodeDegree(w.lattice, ed.a) + 5);
    const f2 = degreeHz(nodeDegree(w.lattice, ed.b) + 5);
    if (on) {
      const env = { a: 0.28, h: 0.35, d: 1.0, peak: 0.12 };
      tone(c, v.input, v.t, { f: f1, env });
      tone(c, v.input, v.t, { f: f2, env, detune: 4 });
      tone(c, v.input, v.t, { type: 'triangle', f: f1 * 2, env: { a: 0.35, h: 0.2, d: 0.8, peak: 0.025 } });
    } else {
      tone(c, v.input, v.t, { f: f1, f2: f1 * 0.94, glide: 0.6, env: { a: 0.02, d: 0.6, peak: 0.07 } });
      tone(c, v.input, v.t, { f: f2, f2: f2 * 0.94, glide: 0.6, env: { a: 0.02, d: 0.6, peak: 0.07 } });
    }
  }

  private facetTing(w: World, facet: number, mine: boolean): void {
    const fc = w.lattice.facets[facet];
    if (!fc) return;
    const v = this.e.voice({ key: 'facet', at: { x: fc.cx, z: fc.cz }, dur: 0.9, gain: mine ? 0.7 : 0.5, wet: 0.4, priority: 0 });
    if (!v) return;
    bell(this.e.ctx, v.input, v.t, degreeHz(nodeDegree(w.lattice, fc.nodes[0]) + 20), 0.75, 0.16, 3);
  }

  /**
   * The loop-closed moment: a rising shimmering arpeggio whose length follows the facets
   * gained, a sub whomp for big closes and a choir bloom for huge ones. Losses fall away.
   * Rivals' big gains sound as a dim distant motif from where it happened.
   */
  private survey(w: World, faction: FactionId, gained: number[], lost: number[], mine: boolean): void {
    const c = this.e.ctx;
    const firstFacet = gained.length ? w.lattice.facets[gained[0]] : undefined;
    const root = firstFacet ? nodeDegree(w.lattice, firstFacet.nodes[0]) % 5 : 0;
    if (mine && gained.length) {
      const n = Math.min(14, 3 + Math.ceil(gained.length * 0.6));
      const v = this.e.voice({ key: 'surveyGain', dur: 3.5 + n * 0.06, gain: 0.85, wet: 0.5, priority: 3 });
      if (!v) return;
      for (let i = 0; i < n; i++) {
        const t = v.t + i * 0.055;
        const f = degreeHz(root + 15 + i);
        const k = 1 - i / (n * 1.6);
        bell(c, v.input, t, f, 1.3, 0.2 * k, 3);
        fm(c, v.input, t, f * 2, 2, 0.6, { a: 0.005, d: 0.35, peak: 0.035 * k });
      }
      if (gained.length >= 4) tone(c, v.input, v.t, { f: 72, f2: 44, glide: 0.4, env: { a: 0.01, d: 0.6, peak: 0.45 } });
      if (gained.length >= 8) {
        const tEnd = v.t + n * 0.055;
        choir(c, v.input, tEnd, [degreeHz(root + 10), degreeHz(root + 12), degreeHz(root + 14)], 'a', { a: 0.25, h: 0.5, d: 1.6, peak: 0.22 });
      }
    } else if (!mine && gained.length >= 6 && firstFacet) {
      const v = this.e.voice({ key: 'rivalSurvey', at: { x: firstFacet.cx, z: firstFacet.cz }, range: 3, dur: 2, gain: 0.5, wet: 0.6, priority: 1 });
      if (!v) return;
      for (let i = 0; i < 3; i++) bell(c, v.input, v.t + i * 0.12, degreeHz(root + 12 - i * 2), 1.2, 0.18, 2);
    }
    if (mine && lost.length) {
      const n = Math.min(6, 2 + Math.ceil(lost.length / 2));
      const v = this.e.voice({ key: 'surveyLoss', dur: 1.2 + n * 0.09, gain: 0.7, wet: 0.35, priority: 3 });
      if (!v) return;
      for (let i = 0; i < n; i++) {
        const f = degreeHz(20 - i);
        tone(c, v.input, v.t + i * 0.09, { type: 'triangle', f, f2: f * 0.92, glide: 0.35, env: { a: 0.005, d: 0.4, peak: 0.13 } });
      }
    }
  }

  /** Glass grains: tiny high sine blips scattered over `spread` seconds. */
  private grains(v: VoiceHandle, t: number, n: number, spread: number, lo: number, hi: number, peak: number): void {
    const c = this.e.ctx;
    for (let i = 0; i < n; i++) {
      const f = lo + Math.random() * (hi - lo);
      tone(c, v.input, t + Math.random() * spread, { f, env: { a: 0.002, d: 0.025 + Math.random() * 0.05, peak: peak * (0.5 + Math.random() * 0.5) } });
    }
  }

  private phason(at: V2, gain: number): void {
    const v = this.e.voice({ key: 'phason', at, range: 1.5, dur: 0.7, gain, wet: 0.5, priority: 1 });
    if (!v) return;
    this.grains(v, v.t, 9, 0.28, 1500, 5200, 0.12);
    tone(this.e.ctx, v.input, v.t, { type: 'triangle', f: 1760, f2: 880, glide: 0.3, env: { a: 0.01, d: 0.34, peak: 0.07 } });
  }

  /** The Phason Tide is coming: a rising filtered drone everyone hears. */
  private tideWarning(): void {
    const v = this.e.voice({ key: 'tideWarn', dur: 4.6, gain: 0.8, wet: 0.5, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(180, v.t);
    lp.frequency.exponentialRampToValueAtTime(3200, v.t + 3.6);
    lp.connect(v.input);
    const env = { a: 3.3, h: 0.3, d: 0.8, peak: 0.08 };
    for (const m of [45, 52, 57]) {
      tone(c, lp, v.t, { type: 'sawtooth', f: midiHz(m), env, detune: -6 });
      tone(c, lp, v.t, { type: 'sawtooth', f: midiHz(m), env, detune: 7 });
    }
    tone(c, v.input, v.t, { f: 220, f2: 880, glide: 3.8, env: { a: 3, h: 0.5, d: 0.4, peak: 0.05 } });
  }

  /** The Crystal turns: a cascade of glass falling across the whole burn. */
  private tide(flips: number): void {
    const v = this.e.voice({ key: 'tide', dur: 3, gain: 0.9, wet: 0.6, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    const n = Math.min(32, 10 + Math.floor(flips / 2));
    for (let i = 0; i < n; i++) {
      const k = i / n;
      const f = 5200 * Math.pow(800 / 5200, k) * (0.9 + Math.random() * 0.2);
      tone(c, v.input, v.t + k * 1.6 + Math.random() * 0.04, { f, env: { a: 0.002, d: 0.08 + k * 0.2, peak: 0.08 } });
    }
    tone(c, v.input, v.t, { f: 62, f2: 28, glide: 1.4, env: { a: 0.02, d: 1.4, peak: 0.6 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 8000, f2: 900, sweep: 1.6, env: { a: 0.1, d: 1.5, peak: 0.18 } });
    this.e.duck(0.3, 1.5);
  }

  private crystalManifest(w: World, node: number, at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'crystal', at: mine ? undefined : at, range: 4, dur: 6.5, gain: mine ? 0.8 : 0.7, wet: 0.75, priority: mine ? 3 : 2 });
    if (!v) return;
    const c = this.e.ctx;
    const r = node >= 0 ? nodeDegree(w.lattice, node) % 5 : 0;
    choir(c, v.input, v.t, [degreeHz(r + 10), degreeHz(r + 12), degreeHz(r + 14), degreeHz(r + 15)], 'a', { a: 1.2, h: 1.4, d: 2.6, peak: 0.32 });
    bell(c, v.input, v.t + 0.9, degreeHz(r + 20), 3.2, 0.28);
    bell(c, v.input, v.t + 1.25, degreeHz(r + 22), 2.6, 0.14);
    tone(c, v.input, v.t, { f: degreeHz(r), env: { a: 1.5, h: 1, d: 2, peak: 0.2 } });
  }

  private crystalShatter(at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'shatter', at, range: 3, dur: 1.6, gain: 0.85, wet: 0.45, priority: mine ? 3 : 2 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 2600, env: { a: 0.001, d: 0.5, peak: 0.55 } });
    for (let i = 0; i < 12; i++) bell(c, v.input, v.t + Math.random() * 0.18, 2000 + Math.random() * 5000, 0.25 + Math.random() * 0.4, 0.06, 2);
    tone(c, v.input, v.t, { f: 320, f2: 80, glide: 0.3, env: { d: 0.32, peak: 0.3 } });
    if (mine) tone(c, v.input, v.t + 0.1, { type: 'triangle', f: degreeHz(10), f2: degreeHz(7), glide: 1, env: { a: 0.05, d: 1.2, peak: 0.12 } });
  }

  private instability(level: 'shimmer' | 'discharge' | 'storm', at: V2): void {
    if (level === 'discharge') return; // the discharge event carries the crack
    const storm = level === 'storm';
    const v = this.e.voice({ key: 'instability', at, range: storm ? 2 : 1, dur: storm ? 2.2 : 0.5, gain: storm ? 0.8 : 0.35, wet: 0.4, priority: 0 });
    if (!v) return;
    this.grains(v, v.t, storm ? 14 : 4, storm ? 1.2 : 0.3, 2500, 7000, 0.06);
    if (storm) noise(this.e.ctx, v.input, v.t, { buf: this.e.pink, filter: 'lowpass', f: 140, env: { a: 0.3, h: 0.6, d: 1.2, peak: 0.7 } });
  }

  private discharge(at: V2): void {
    const v = this.e.voice({ key: 'discharge', at, range: 1.5, dur: 0.45, gain: 0.9, wet: 0.3, priority: 2 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 1800, env: { a: 0.001, d: 0.12, peak: 0.85 } });
    tone(c, v.input, v.t, { type: 'sawtooth', f: 60, env: { a: 0.001, d: 0.26, peak: 0.22 } });
    tone(c, v.input, v.t, { type: 'square', f: 2400, f2: 200, glide: 0.15, env: { d: 0.18, peak: 0.1 } });
  }

  // ── Conquest ───────────────────────────────────────────────────────────────
  private hearthStage(faction: Owner, stage: CaptureStage, prev: CaptureStage, attacker: FactionId | null, p: Perspective): void {
    if (p.me === -1) return;
    const danger = stage === 'contained' || stage === 'contested' || stage === 'overwritten';
    if (faction === p.me) {
      if (danger) this.alarm(1);
      else if (stage === 'threatened' && prev === 'safe') this.warnBlip();
      else if (stage === 'safe' && prev !== 'safe') this.relief();
    } else if (attacker === p.me && danger && prev !== stage) this.horn();
  }

  /** Own Hearth contained: urgent two-tone alarm pulses (also re-armed by the soundscape). */
  alarm(gain: number): void {
    const v = this.e.voice({ key: 'alarm', dur: 1.2, gain, wet: 0.2, priority: 3, bus: 'ui' });
    if (!v) return;
    const c = this.e.ctx;
    for (let i = 0; i < 3; i++) {
      const t = v.t + i * 0.3;
      tone(c, v.input, t, { type: 'square', f: midiHz(81), env: { a: 0.004, h: 0.09, d: 0.03, peak: 0.07 } });
      tone(c, v.input, t + 0.13, { type: 'square', f: midiHz(76), env: { a: 0.004, h: 0.09, d: 0.03, peak: 0.07 } });
    }
    tone(c, v.input, v.t, { f: 55, env: { a: 0.01, h: 0.7, d: 0.2, peak: 0.3 } });
    this.e.duck(0.2, 0.8);
  }

  private warnBlip(): void {
    const v = this.e.voice({ key: 'warn', dur: 0.5, gain: 0.7, wet: 0.2, priority: 2, bus: 'ui' });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { type: 'triangle', f: midiHz(76), env: { h: 0.08, d: 0.08, peak: 0.16 } });
    tone(c, v.input, v.t + 0.16, { type: 'triangle', f: midiHz(69), env: { h: 0.08, d: 0.15, peak: 0.16 } });
  }

  private relief(): void {
    const v = this.e.voice({ key: 'relief', dur: 1.8, gain: 0.7, wet: 0.5, priority: 2, bus: 'ui' });
    if (!v) return;
    const degs = [10, 12, 15];
    for (let i = 0; i < 3; i++) bell(this.e.ctx, v.input, v.t + i * 0.09, degreeHz(degs[i] + 5), 1.3, 0.16, 3);
  }

  /** Enemy Hearth contained by us: an ominous low horn. */
  private horn(): void {
    const v = this.e.voice({ key: 'horn', dur: 2.6, gain: 0.8, wet: 0.55, priority: 3 });
    if (!v) return;
    brass(this.e.ctx, v.input, v.t, [midiHz(33), midiHz(40), midiHz(45)], 0.3, 0.7, 1.4, 0.55, 1300);
  }

  private captured(at: V2, weLost: boolean, weWon: boolean): void {
    const v = this.e.voice({ key: 'captured', at: weLost || weWon ? undefined : at, range: 6, dur: 6.5, gain: 0.95, wet: 0.6, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    fm(c, v.input, v.t, 92, 1.41, 3, { a: 0.004, d: 5.2, peak: 0.42 });
    bell(c, v.input, v.t, 184, 4, 0.12, 3);
    tone(c, v.input, v.t, { f: 72, f2: 28, glide: 0.9, env: { a: 0.005, d: 1.4, peak: 0.85 } });
    noise(c, v.input, v.t, { buf: this.e.pink, filter: 'lowpass', f: 320, env: { a: 0.005, d: 1.1, peak: 0.6 } });
    if (weLost) brass(this.e.ctx, v.input, v.t + 0.4, [midiHz(31), midiHz(34), midiHz(38)], 0.4, 1, 2, 0.4, 900);
    if (weWon) brass(this.e.ctx, v.input, v.t + 0.35, [midiHz(48), midiHz(55), midiHz(60), midiHz(64)], 0.08, 0.6, 1.4, 0.5, 2600);
    this.e.duck(0.45, 2);
  }

  private eliminated(me: boolean): void {
    const v = this.e.voice({ key: 'eliminated', dur: 5, gain: me ? 1 : 0.7, wet: 0.6, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    const seq = me ? [57, 55, 52, 45] : [52, 45];
    for (let i = 0; i < seq.length; i++) brass(this.e.ctx, v.input, v.t + i * 0.42, [midiHz(seq[i] - 12), midiHz(seq[i])], 0.06, 0.25, 0.5, 0.4, 1500);
    fm(c, v.input, v.t + seq.length * 0.42, 70, 1.41, 2.5, { a: 0.004, d: 3.5, peak: 0.4 });
    this.e.duck(0.5, 2.5);
  }

  /** Victory fanfare (C major inside the pentatonic: G C E G → C E G C), or a minor cadence in defeat. */
  private victory(won: boolean): void {
    const v = this.e.voice({ key: 'victory', dur: 7, gain: 1, wet: 0.55, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    if (won) {
      const seq = [55, 60, 64, 67];
      const times = [0, 0.16, 0.32, 0.48];
      for (let i = 0; i < 4; i++) brass(this.e.ctx, v.input, v.t + times[i], [midiHz(seq[i]), midiHz(seq[i] - 12)], 0.03, 0.08, 0.15, 0.5, 3000);
      brass(this.e.ctx, v.input, v.t + 0.7, [midiHz(48), midiHz(60), midiHz(64), midiHz(67), midiHz(72)], 0.05, 1.6, 2.4, 0.8, 3600);
      for (let i = 0; i < 8; i++) tone(c, v.input, v.t + 0.7 - 0.25 + i * 0.03, { f: 92, f2: 70, glide: 0.1, env: { d: 0.12, peak: 0.25 + i * 0.03 } });
      noise(c, v.input, v.t + 0.7, { buf: this.e.white, filter: 'highpass', f: 5000, env: { a: 0.005, d: 2.6, peak: 0.28 } });
      for (let i = 0; i < 6; i++) bell(c, v.input, v.t + 0.8 + i * 0.08, degreeHz(25 + i), 1.4, 0.1, 3);
    } else {
      const seq = [57, 55, 52];
      for (let i = 0; i < 3; i++) brass(this.e.ctx, v.input, v.t + i * 0.55, [midiHz(seq[i])], 0.1, 0.3, 0.4, 0.35, 1400);
      brass(this.e.ctx, v.input, v.t + 1.7, [midiHz(33), midiHz(45), midiHz(48), midiHz(52)], 0.4, 1.2, 2.5, 0.6, 1100);
    }
    this.e.duck(0.7, 4);
  }

  /** The Burn: a fire roar swells and the first salvo of fireworks goes up. */
  private burn(w: World): void {
    const v = this.e.voice({ key: 'burn', dur: 8, gain: 1, wet: 0.5, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.pink, filter: 'lowpass', f: 200, f2: 1100, sweep: 3, env: { a: 2, h: 2, d: 3.5, peak: 0.7 } });
    tone(c, v.input, v.t, { f: 60, f2: 25, glide: 2, env: { a: 0.01, d: 2.5, peak: 0.8 } });
    this.e.duck(0.35, 3);
    const eff = w.map.effigy;
    for (let i = 0; i < 6; i++) this.firework({ x: eff.x + (Math.random() - 0.5) * 50, z: eff.z + (Math.random() - 0.5) * 50 }, 0.8 + i * 0.6 + Math.random() * 0.4);
  }

  /** Launch whistle, bang and crackle; positional, low priority (the sky is full of them). */
  firework(at: V2, delay: number): void {
    const v = this.e.voice({ key: 'firework', at, range: 5, dur: 3.2, gain: 0.8, wet: 0.6, priority: 0, delay });
    if (!v) return;
    const c = this.e.ctx;
    const up = 0.8 + Math.random() * 0.5;
    tone(c, v.input, v.t, { f: 700 + Math.random() * 300, f2: 2400 + Math.random() * 800, glide: up, vib: 20, vibRate: 11, env: { a: 0.05, h: up - 0.2, d: 0.15, peak: 0.06 } });
    const tb = v.t + up;
    noise(c, v.input, tb, { buf: this.e.pink, filter: 'lowpass', f: 1600, f2: 300, sweep: 0.5, env: { a: 0.002, d: 0.55, peak: 0.75 } });
    tone(c, v.input, tb, { f: 85, f2: 30, glide: 0.4, env: { d: 0.45, peak: 0.55 } });
    noise(c, v.input, tb + 0.15, { buf: this.e.crackle, filter: 'highpass', f: 2200, env: { a: 0.05, h: 0.7, d: 0.7, peak: 1.2 } });
  }

  // ── Units ──────────────────────────────────────────────────────────────────
  private hit(at: V2, amount: number, onMe: boolean): void {
    const v = this.e.voice({ key: 'hit', at: onMe ? undefined : at, dur: 0.3, gain: onMe ? 0.9 : 0.7, wet: 0.08, priority: onMe ? 3 : 1 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { f: 155, f2: 55, glide: 0.1, env: { d: 0.16, peak: Math.min(1, 0.45 + amount / 40) } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'lowpass', f: 1300, env: { d: 0.06, peak: 0.5 } });
    if (onMe) tone(c, v.input, v.t, { f: 60, env: { a: 0.002, d: 0.25, peak: 0.5 } });
  }

  /** Comedic fall: slide whistle down, then a thud. */
  private ko(at: V2, avatar: boolean, me: boolean): void {
    const v = this.e.voice({ key: 'ko', at: me ? undefined : at, dur: 1.1, gain: avatar ? 0.9 : 0.6, wet: 0.2, priority: avatar ? 2 : 0 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { f: 1300, f2: 240, glide: 0.55, vib: 45, vibRate: 9, env: { a: 0.01, h: 0.35, d: 0.22, peak: 0.12 } });
    tone(c, v.input, v.t + 0.6, { f: 95, f2: 40, glide: 0.18, env: { d: 0.22, peak: 0.6 } });
    noise(c, v.input, v.t + 0.6, { buf: this.e.white, filter: 'lowpass', f: 420, env: { d: 0.15, peak: 0.35 } });
  }

  private respawn(): void {
    const v = this.e.voice({ key: 'respawn', dur: 1.5, gain: 0.6, wet: 0.5, priority: 2 });
    if (!v) return;
    for (let i = 0; i < 5; i++) bell(this.e.ctx, v.input, v.t + i * 0.07, degreeHz(15 + i * 2), 1, 0.12, 3);
  }

  /** A hippie joins: a little crowd "yay" and a sparkle. */
  private recruited(at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'recruit', at, range: 1.5, dur: 1, gain: mine ? 0.8 : 0.55, wet: 0.3, priority: mine ? 1 : 0 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 750, f2: 1400, sweep: 0.25, q: 3, env: { a: 0.05, h: 0.12, d: 0.3, peak: 0.35 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 2400, q: 4, env: { a: 0.05, h: 0.12, d: 0.3, peak: 0.15 } });
    for (let i = 0; i < 4; i++) bell(c, v.input, v.t + 0.1 + i * 0.05, degreeHz(22 + Math.floor(Math.random() * 6)), 0.5, 0.07, 2);
  }

  private distracted(at: V2): void {
    const v = this.e.voice({ key: 'distract', at, dur: 0.6, gain: 0.5, wet: 0.3, priority: 0 });
    if (!v) return;
    tone(this.e.ctx, v.input, v.t, { type: 'triangle', f: 620, vib: 90, vibRate: 7, env: { a: 0.05, d: 0.5, peak: 0.06 } });
  }

  private chop(at: V2): void {
    const v = this.e.voice({ key: 'harvest', at, dur: 0.2, gain: 0.7, wet: 0.15, priority: 0 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 1500, q: 2, env: { a: 0.001, d: 0.06, peak: 0.7 } });
    tone(c, v.input, v.t, { f: 250, f2: 140, glide: 0.08, env: { d: 0.09, peak: 0.4 } });
  }

  private lumber(at: V2): void {
    const v = this.e.voice({ key: 'lumber', at, range: 2, dur: 0.4, gain: 0.6, wet: 0.15, priority: 0 });
    if (!v) return;
    const fs = [300, 260, 340];
    for (let i = 0; i < 3; i++) tone(this.e.ctx, v.input, v.t + i * 0.06, { type: 'triangle', f: fs[i], env: { d: 0.05, peak: 0.25 } });
  }

  // ── Structures ─────────────────────────────────────────────────────────────
  private piecePop(at: V2, kind: 'wall' | 'floor' | 'ramp', mine: boolean): void {
    const v = this.e.voice({ key: 'piece', at, dur: 0.3, gain: mine ? 0.75 : 0.55, wet: 0.12, priority: mine ? 1 : 0 });
    if (!v) return;
    const c = this.e.ctx;
    const base = kind === 'wall' ? 210 : kind === 'floor' ? 260 : 300;
    tone(c, v.input, v.t, { f: base, f2: base * (kind === 'ramp' ? 2.4 : 2), glide: 0.06, env: { d: 0.12, peak: 0.45 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 2100, q: 1.5, env: { a: 0.001, d: 0.03, peak: 0.3 } });
  }

  private crash(at: V2, gain: number, range: number): void {
    const v = this.e.voice({ key: 'crash', at, range, dur: 0.7, gain, wet: 0.25, priority: 1 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'lowpass', f: 2600, f2: 400, sweep: 0.45, env: { a: 0.002, d: 0.5, peak: 0.65 } });
    for (let i = 0; i < 4; i++) tone(c, v.input, v.t + Math.random() * 0.22, { type: 'triangle', f: 150 + Math.random() * 260, env: { d: 0.06, peak: 0.3 } });
    tone(c, v.input, v.t, { f: 72, f2: 35, glide: 0.3, env: { d: 0.3, peak: 0.4 } });
  }

  private hammer(at: V2, gain: number): void {
    const v = this.e.voice({ key: 'hammer', at, dur: 0.4, gain, wet: 0.2, priority: 0 });
    if (!v) return;
    const c = this.e.ctx;
    for (let i = 0; i < 2; i++) {
      noise(c, v.input, v.t + i * 0.15, { buf: this.e.white, filter: 'bandpass', f: 2600, q: 2, env: { a: 0.001, d: 0.03, peak: 0.45 } });
      tone(c, v.input, v.t + i * 0.15, { type: 'triangle', f: 900, env: { d: 0.05, peak: 0.18 } });
    }
  }

  /** Construction complete: hammer taps and a three-bell jingle. */
  private jingle(at: V2, mine: boolean): void {
    const v = this.e.voice({ key: 'built', at, range: 1.5, dur: 1.5, gain: mine ? 0.8 : 0.55, wet: 0.35, priority: mine ? 2 : 0 });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 2600, q: 2, env: { a: 0.001, d: 0.03, peak: 0.4 } });
    const degs = [15, 17, 20];
    for (let i = 0; i < 3; i++) bell(c, v.input, v.t + 0.1 + i * 0.1, degreeHz(degs[i]), 1, 0.17, 3);
  }

  private powerDown(at: V2): void {
    const v = this.e.voice({ key: 'disabled', at, range: 1.5, dur: 0.9, gain: 0.7, wet: 0.25, priority: 1 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { type: 'sawtooth', f: 420, f2: 55, glide: 0.65, env: { a: 0.01, d: 0.7, peak: 0.1 } });
    noise(c, v.input, v.t, { buf: this.e.crackle, filter: 'highpass', f: 1500, env: { a: 0.01, h: 0.3, d: 0.3, peak: 0.8 } });
  }

  private powerUp(at: V2): void {
    const v = this.e.voice({ key: 'repaired', at, range: 1.5, dur: 1, gain: 0.6, wet: 0.3, priority: 0 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { type: 'triangle', f: 200, f2: 600, glide: 0.4, env: { a: 0.02, d: 0.4, peak: 0.12 } });
    bell(c, v.input, v.t + 0.38, degreeHz(20), 0.6, 0.12, 2);
  }

  private wardZap(at: V2): void {
    const v = this.e.voice({ key: 'ward', at, range: 1.5, dur: 0.4, gain: 0.6, wet: 0.3, priority: 0 });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { f: 2000, f2: 180, glide: 0.25, env: { a: 0.002, d: 0.3, peak: 0.22 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 3000, env: { a: 0.001, d: 0.1, peak: 0.15 } });
    tone(c, v.input, v.t, { f: 52, env: { a: 0.002, d: 0.3, peak: 0.3 } });
  }

  // ── Economy / progression ──────────────────────────────────────────────────
  private bubbles(): void {
    const v = this.e.voice({ key: 'brew', dur: 0.8, gain: 0.6, wet: 0.3, priority: 1 });
    if (!v) return;
    for (let i = 0; i < 7; i++) {
      const f = 300 + Math.random() * 600;
      tone(this.e.ctx, v.input, v.t + Math.random() * 0.45, { f, f2: f * 1.6, glide: 0.05, env: { a: 0.003, d: 0.06, peak: 0.12 } });
    }
  }

  private drug(d: DrugId): void {
    const v = this.e.voice({ key: 'drug', dur: 2.2, gain: 0.75, wet: 0.5, priority: 2 });
    if (!v) return;
    const c = this.e.ctx;
    if (d === 'saffron') {
      const degs = [15, 17, 19, 20, 22, 25];
      for (let i = 0; i < degs.length; i++) bell(c, v.input, v.t + i * 0.045, degreeHz(degs[i]), 1.1, 0.13, 3);
      fm(c, v.input, v.t, degreeHz(20), 2, 2, { a: 0.3, d: 1.5, peak: 0.08 });
    } else if (d === 'dust') {
      noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 3000, f2: 9000, sweep: 0.9, env: { a: 0.3, d: 0.9, peak: 0.18 } });
      this.grains(v, v.t, 16, 1.1, 3000, 8000, 0.06);
    } else {
      // Acid Cop Vision: a resonant squelch warbling through a sweeping filter.
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 14;
      lp.frequency.setValueAtTime(300, v.t);
      lp.frequency.exponentialRampToValueAtTime(2600, v.t + 0.6);
      lp.frequency.exponentialRampToValueAtTime(260, v.t + 1.6);
      lp.connect(v.input);
      tone(c, lp, v.t, { type: 'sawtooth', f: 110, vib: 70, vibRate: 6, env: { a: 0.02, h: 1, d: 0.6, peak: 0.25 } });
      tone(c, lp, v.t, { type: 'square', f: 55, vib: 40, vibRate: 4, env: { a: 0.02, h: 1, d: 0.6, peak: 0.1 } });
    }
  }

  private fadeBlip(): void {
    const v = this.e.voice({ key: 'drugEnd', dur: 0.5, gain: 0.6, wet: 0.3, priority: 1, bus: 'ui' });
    if (!v) return;
    tone(this.e.ctx, v.input, v.t, { type: 'triangle', f: 880, f2: 330, glide: 0.3, env: { d: 0.35, peak: 0.1 } });
  }

  private alignDrone(ch: ChakraId): void {
    const v = this.e.voice({ key: 'align', dur: 4.6, gain: 0.7, wet: 0.5, priority: 2 });
    if (!v) return;
    const c = this.e.ctx;
    const r = CHAKRAS.indexOf(ch);
    tone(c, v.input, v.t, { f: degreeHz(r + 5), env: { a: 0.8, h: 2.6, d: 1, peak: 0.16 } });
    tone(c, v.input, v.t, { f: degreeHz(r + 8), vib: 8, vibRate: 0.5, env: { a: 1.4, h: 2, d: 1, peak: 0.06 } });
  }

  /** Chakra aligned: choral resonance on the chakra's own degree, brighter per level. */
  private aligned(ch: ChakraId, level: number): void {
    const v = this.e.voice({ key: 'aligned', dur: 4, gain: 0.85, wet: 0.65, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    const r = CHAKRAS.indexOf(ch);
    choir(c, v.input, v.t, [degreeHz(r + 10), degreeHz(r + 12), degreeHz(r + 14), degreeHz(r + 15)], 'o', { a: 0.4, h: 1, d: 2, peak: 0.3 });
    for (let i = 0; i <= level; i++) bell(c, v.input, v.t + 0.3 + i * 0.12, degreeHz(r + 20 + i * 2), 2, 0.16, 3);
  }

  private alignBroken(ch: ChakraId): void {
    const v = this.e.voice({ key: 'alignBroken', dur: 0.8, gain: 0.7, wet: 0.3, priority: 2 });
    if (!v) return;
    const c = this.e.ctx;
    const f = degreeHz(CHAKRAS.indexOf(ch) + 10);
    tone(c, v.input, v.t, { type: 'triangle', f, f2: f * 0.5, glide: 0.5, env: { d: 0.6, peak: 0.15 } });
    noise(c, v.input, v.t, { buf: this.e.crackle, filter: 'highpass', f: 2000, env: { a: 0.01, h: 0.2, d: 0.3, peak: 0.9 } });
  }

  private ability(id: AbilityId, at: V2, mine: boolean): void {
    const big = id === 'omega';
    const v = this.e.voice({ key: `ab-${id}`, at, range: big ? 8 : 4, dur: big ? 5.5 : 2.6, gain: mine ? 0.95 : 0.75, wet: 0.5, priority: big || mine ? 3 : 2 });
    if (!v) return;
    const c = this.e.ctx;
    switch (id) {
      case 'beacon':
        for (let i = 0; i < 3; i++) {
          const k = Math.pow(0.45, i);
          tone(c, v.input, v.t + i * 0.45, { f: midiHz(91), env: { a: 0.002, d: 1.1, peak: 0.3 * k } });
          tone(c, v.input, v.t + i * 0.45, { f: midiHz(79), env: { a: 0.002, d: 0.7, peak: 0.08 * k } });
        }
        break;
      case 'march': {
        const step = 60 / FESTIVAL_BPM / 4;
        const snare = [0, 2, 3, 4, 6, 8, 10, 11, 12, 14, 16, 18, 19, 20, 22, 24, 26, 27, 28, 29, 30, 31];
        for (const s of snare) {
          const t = v.t + s * step;
          noise(c, v.input, t, { buf: this.e.white, filter: 'bandpass', f: 1800, q: 0.8, env: { a: 0.001, d: 0.08, peak: 0.4 } });
          tone(c, v.input, t, { f: 190, f2: 150, glide: 0.05, env: { d: 0.06, peak: 0.18 } });
        }
        for (const s of [0, 8, 16, 24]) tone(c, v.input, v.t + s * step, { f: 92, f2: 45, glide: 0.15, env: { d: 0.22, peak: 0.65 } });
        break;
      }
      case 'stabilize':
        for (const m of [45, 52, 57, 60]) tone(c, v.input, v.t, { f: midiHz(m), detune: (Math.random() - 0.5) * 8, vib: 5, vibRate: 0.7, env: { a: 0.5, h: 1.2, d: 0.9, peak: 0.09 } });
        noise(c, v.input, v.t, { buf: this.e.pink, filter: 'bandpass', f: 400, q: 6, env: { a: 0.5, h: 1, d: 0.8, peak: 0.12 } });
        break;
      case 'phason':
        tone(c, v.input, v.t, { type: 'triangle', f: 1400, f2: 700, glide: 1, vib: 25, vibRate: 5, env: { a: 0.02, d: 1.1, peak: 0.15 } });
        this.grains(v, v.t, 14, 0.8, 1500, 6000, 0.08);
        bell(c, v.input, v.t + 0.1, midiHz(88), 1, 0.12, 3);
        break;
      case 'omega':
        // Reverse swell into a sub boom, a long bell and an open-fifth choir.
        noise(c, v.input, v.t, { buf: this.e.pink, filter: 'lowpass', f: 200, f2: 5000, sweep: 1, env: { a: 1, d: 0.04, peak: 0.45 } });
        tone(c, v.input, v.t + 1, { f: 55, f2: 22, glide: 2, env: { a: 0.005, d: 2.5, peak: 1 } });
        noise(c, v.input, v.t + 1, { buf: this.e.pink, filter: 'lowpass', f: 420, env: { a: 0.005, d: 1.5, peak: 0.7 } });
        bell(c, v.input, v.t + 1, degreeHz(10), 4, 0.3);
        choir(c, v.input, v.t + 1, [midiHz(45), midiHz(52), midiHz(57)], 'a', { a: 0.1, h: 1.2, d: 2.4, peak: 0.25 });
        this.e.duck(0.5, 2.5);
        break;
    }
  }

  private gcc(action: GccAction, at: V2, mine: boolean): void {
    const v = this.e.voice({ key: `gcc-${action}`, at, range: 2, dur: 1.8, gain: mine ? 0.85 : 0.6, wet: 0.4, priority: mine ? 2 : 1 });
    if (!v) return;
    const c = this.e.ctx;
    if (action === 'dialectics') {
      // Flagellian dialectics: two formant voices arguing, thesis and antithesis.
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1000;
      bp.Q.value = 2.5;
      bp.connect(v.input);
      for (let i = 0; i < 7; i++) {
        const hi = i % 2 === 0;
        tone(c, bp, v.t + i * 0.14, { type: 'sawtooth', f: hi ? 200 : 140, f2: hi ? 240 : 115, glide: 0.1, vib: 60, vibRate: 12, env: { a: 0.01, d: 0.11, peak: 0.5 } });
      }
      bell(c, v.input, v.t + 1.05, degreeHz(15), 0.8, 0.14, 3);
    } else {
      const f = degreeHz(20);
      tone(c, v.input, v.t, { f, f2: f * 1.06, glide: 0.4, env: { a: 0.01, d: 1.3, peak: 0.14 } });
      tone(c, v.input, v.t, { f, f2: f / 1.06, glide: 0.4, env: { a: 0.01, d: 1.3, peak: 0.14 } });
      this.grains(v, v.t + 0.1, 6, 0.6, 3000, 7000, 0.05);
    }
  }

  // ── D.E.G.E.N. mesh ────────────────────────────────────────────────────────
  /** LoRa chirp spread spectrum: up-chirp preamble then a sync down-chirp, panned toward the ping. */
  private loraChirp(kind: PingKind, at: V2): void {
    const v = this.e.voice({ key: 'ping', at, range: 20, dur: 1.4, gain: 0.7, wet: 0.2, priority: 2, bus: 'ui' });
    if (!v) return;
    const c = this.e.ctx;
    const lo = kind === 'sos' ? 1200 : kind === 'attack' ? 700 : 900;
    const hi = lo * 3;
    const type: OscillatorType = kind === 'attack' ? 'square' : 'sine';
    const peak = type === 'square' ? 0.05 : 0.12;
    const reps = kind === 'sos' ? 2 : 1;
    for (let r = 0; r < reps; r++) {
      const t0 = v.t + r * 0.5;
      for (let i = 0; i < 3; i++) tone(c, v.input, t0 + i * 0.1, { type, f: lo, f2: hi, glide: 0.09, env: { a: 0.004, h: 0.075, d: 0.015, peak } });
      tone(c, v.input, t0 + 0.32, { type, f: hi, f2: lo, glide: 0.09, env: { a: 0.004, h: 0.075, d: 0.015, peak } });
    }
  }

  private meshTap(): void {
    const v = this.e.voice({ key: 'tap', dur: 0.9, gain: 0.6, wet: 0.2, priority: 2, bus: 'ui' });
    if (!v) return;
    const c = this.e.ctx;
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'bandpass', f: 2500, q: 0.7, env: { a: 0.02, h: 0.3, d: 0.2, peak: 0.2 } });
    tone(c, v.input, v.t + 0.45, { f: 900, f2: 2700, glide: 0.09, env: { a: 0.004, h: 0.07, d: 0.02, peak: 0.12 } });
  }

  /** 'TAKE A SHOT': the primordial bwehhhhh. Bwe, bwe, bweeeehhh. */
  private airhorn(at: V2 | undefined): void {
    const v = this.e.voice({ key: 'airhorn', at, range: 10, dur: 1.6, gain: 0.85, wet: 0.35, priority: 3 });
    if (!v) return;
    const c = this.e.ctx;
    const drive = c.createWaveShaper();
    drive.curve = this.hornCurve;
    const horn = c.createBiquadFilter();
    horn.type = 'peaking';
    horn.frequency.value = 1400;
    horn.Q.value = 1.2;
    horn.gain.value = 9;
    const g = c.createGain();
    g.gain.value = 0.35;
    drive.connect(horn).connect(g).connect(v.input);
    const blasts: readonly [number, number][] = [
      [0, 0.11],
      [0.18, 0.11],
      [0.36, 0.95],
    ];
    for (const [start, len] of blasts) {
      const t = v.t + start;
      for (const f of [466, 470, 233]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f * 0.93, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
        const eg = c.createGain();
        const end = envelope(eg.gain, t, { a: 0.012, h: len, d: 0.06, peak: 0.6 });
        o.connect(eg).connect(drive);
        o.start(t);
        o.stop(end + 0.05);
      }
    }
  }

  // ── UI blips (public: called by the UI) ────────────────────────────────────
  uiHover(): void {
    const v = this.e.voice({ key: 'ui', dur: 0.08, gain: 0.5, wet: 0, priority: 0, bus: 'ui' });
    if (!v) return;
    tone(this.e.ctx, v.input, v.t, { f: 1760, env: { a: 0.002, d: 0.035, peak: 0.05 } });
  }

  uiClick(): void {
    const v = this.e.voice({ key: 'ui', dur: 0.12, gain: 0.7, wet: 0.05, priority: 1, bus: 'ui' });
    if (!v) return;
    const c = this.e.ctx;
    tone(c, v.input, v.t, { type: 'triangle', f: 880, f2: 1320, glide: 0.02, env: { a: 0.002, d: 0.06, peak: 0.14 } });
    noise(c, v.input, v.t, { buf: this.e.white, filter: 'highpass', f: 4000, env: { a: 0.001, d: 0.012, peak: 0.12 } });
  }

  uiConfirm(): void {
    const v = this.e.voice({ key: 'ui', dur: 0.8, gain: 0.7, wet: 0.3, priority: 1, bus: 'ui' });
    if (!v) return;
    bell(this.e.ctx, v.input, v.t, degreeHz(20), 0.6, 0.13, 3);
    bell(this.e.ctx, v.input, v.t + 0.07, degreeHz(23), 0.7, 0.13, 3);
  }

  uiBack(): void {
    const v = this.e.voice({ key: 'ui', dur: 0.15, gain: 0.7, wet: 0.05, priority: 1, bus: 'ui' });
    if (!v) return;
    tone(this.e.ctx, v.input, v.t, { type: 'triangle', f: 660, f2: 440, glide: 0.07, env: { a: 0.002, d: 0.09, peak: 0.12 } });
  }

  uiToggle(on: boolean): void {
    const v = this.e.voice({ key: 'ui', dur: 0.2, gain: 0.6, wet: 0.05, priority: 1, bus: 'ui' });
    if (!v) return;
    const a = on ? midiHz(76) : midiHz(81);
    const b = on ? midiHz(81) : midiHz(76);
    tone(this.e.ctx, v.input, v.t, { type: 'triangle', f: a, env: { a: 0.002, d: 0.05, peak: 0.1 } });
    tone(this.e.ctx, v.input, v.t + 0.06, { type: 'triangle', f: b, env: { a: 0.002, d: 0.07, peak: 0.1 } });
  }

  /** Soft error blip (also the sound of a rejected command). */
  uiError(): void {
    const v = this.e.voice({ key: 'ui', dur: 0.3, gain: 0.6, wet: 0.05, priority: 1, bus: 'ui' });
    if (!v) return;
    tone(this.e.ctx, v.input, v.t, { type: 'square', f: 330, env: { a: 0.003, d: 0.07, peak: 0.06 } });
    tone(this.e.ctx, v.input, v.t + 0.085, { type: 'square', f: 247, env: { a: 0.003, d: 0.1, peak: 0.06 } });
  }
}
