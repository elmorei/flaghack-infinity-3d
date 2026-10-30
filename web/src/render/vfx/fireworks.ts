/**
 * The Burn fireworks: a ~60 s show over the effigy (single burst at a time early on, salvos
 * every few seconds, a dense finale). Rockets are analytic particles; the CPU evaluates the
 * same ballistic formula to lay their spark trails and to find the burst point, then the
 * shell bursts into peony, ring, willow, crackle or pentagram patterns. Every spawn carries
 * its true start time (negative delay when it belongs to the past), so frame hitches never
 * smear the timing. Scheduling uses the match-seeded presentation PRNG.
 */
import * as THREE from 'three';
import * as P from './palette';
import { ParticleSpec, Shape, type ParticlePool } from './particles';
import type { Prng } from './prng';

/** Show length (s) after the 'burn' event. */
const SHOW = 60;
/** Show time when the finale's rapid fire starts. */
const FINALE = 50;
/** No launches after this, so the last shells burst before the show ends. */
const LAST_LAUNCH = SHOW - 3;
const ROCKET_G = 9;
const MAX_ROCKETS = 40;
const TRAIL_STEP = 1 / 90;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;

const SHELLS = ['peony', 'ring', 'willow', 'crackle', 'pentagram'] as const;
type ShellKind = (typeof SHELLS)[number];

interface Rocket {
  active: boolean;
  launch: number;
  burst: number;
  x0: number;
  y0: number;
  z0: number;
  vx: number;
  vy: number;
  vz: number;
  /** Rocket age up to which the trail has been laid. */
  trailAge: number;
  kind: ShellKind;
  a: THREE.Color;
  b: THREE.Color;
}

export class Fireworks {
  private readonly pool: ParticlePool;
  private readonly rng: Prng;
  private readonly cameraSource: THREE.Camera | (() => THREE.Camera);
  private get camera(): THREE.Camera { return typeof this.cameraSource === 'function' ? this.cameraSource() : this.cameraSource; }
  private readonly density: number;
  private readonly s = new ParticleSpec();
  private readonly dir = new THREE.Vector3();
  private readonly ax = new THREE.Vector3();
  private readonly ay = new THREE.Vector3();
  private readonly rockets: Rocket[] = [];
  /** Show start (presentation time), or -1 when no launches are scheduled. */
  private showStart = -1;
  private nextLaunch = 0;
  private nextSalvo = 0;
  private cx = 0;
  private cz = 0;
  private groundY: (x: number, z: number) => number = () => 0;

  constructor(pool: ParticlePool, rng: Prng, camera: THREE.Camera | (() => THREE.Camera), density: number) {
    this.pool = pool;
    this.rng = rng;
    this.cameraSource = camera;
    this.density = density;
    for (let i = 0; i < MAX_ROCKETS; i++) {
      this.rockets.push({
        active: false,
        launch: 0,
        burst: 0,
        x0: 0,
        y0: 0,
        z0: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        trailAge: 0,
        kind: 'peony',
        a: P.YELLOW,
        b: P.WHITE,
      });
    }
  }

  /** Quality-scaled particle count (at least one). */
  private n(count: number): number {
    return Math.max(1, Math.round(count * this.density));
  }

  /** Begin the show above (cx, cz). */
  start(now: number, cx: number, cz: number, groundY: (x: number, z: number) => number = () => 0): void {
    this.groundY = groundY;
    this.showStart = now;
    this.nextLaunch = now + 0.6;
    this.nextSalvo = now + 6;
    this.cx = cx;
    this.cz = cz;
  }

  update(now: number): void {
    const rng = this.rng;
    if (this.showStart >= 0) {
      if (now - this.showStart >= LAST_LAUNCH) {
        this.showStart = -1;
      } else {
        while (now >= this.nextLaunch) {
          this.launch(this.nextLaunch, now);
          this.nextLaunch += this.nextLaunch - this.showStart >= FINALE ? rng.range(0.16, 0.32) : rng.range(0.55, 1.35);
        }
        if (now >= this.nextSalvo && now - this.showStart < FINALE) {
          const count = 3 + rng.int(3);
          for (let i = 0; i < count; i++) this.launch(now + i * 0.12, now);
          this.nextSalvo = now + rng.range(6, 9);
        }
      }
    }
    for (let i = 0; i < this.rockets.length; i++) {
      const r = this.rockets[i];
      if (r.active) this.fly(r, now);
    }
  }

  /** Schedule one rocket leaving the ground at `at` (may be slightly in the future). */
  private launch(at: number, now: number): void {
    const rng = this.rng;
    let r: Rocket | null = null;
    for (let i = 0; i < this.rockets.length; i++) {
      const c = this.rockets[i];
      if (!c.active) {
        r = c;
        break;
      }
    }
    if (!r) return;
    const la = rng.next() * TAU;
    const lr = rng.range(14, 30);
    const ba = rng.next() * TAU;
    const br = rng.range(0, 28);
    const T = rng.range(1.7, 2.5);
    r.active = true;
    r.launch = at;
    r.burst = at + T;
    r.x0 = this.cx + Math.cos(la) * lr;
    r.z0 = this.cz + Math.sin(la) * lr;
    r.y0 = this.groundY(r.x0, r.z0);
    const bx = this.cx + Math.cos(ba) * br;
    const by = rng.range(42, 80);
    const bz = this.cz + Math.sin(ba) * br;
    // Solve p(T) = burst point for p(t) = p0 + v t - ½ g t² ŷ.
    r.vx = (bx - r.x0) / T;
    r.vy = (by - r.y0) / T + 0.5 * ROCKET_G * T;
    r.vz = (bz - r.z0) / T;
    r.trailAge = 0;
    r.kind = SHELLS[rng.int(SHELLS.length)];
    r.a = P.FIREWORK[rng.int(P.FIREWORK.length)];
    r.b = rng.next() < 0.5 ? P.WHITE : P.FIREWORK[rng.int(P.FIREWORK.length)];
    this.s
      .reset()
      .at(r.x0, r.y0, r.z0)
      .vel(r.vx, r.vy, r.vz)
      .time(T, at - now)
      .size(0.55, 0.4)
      .phys(ROCKET_G, 0)
      .from(P.WARM_WHITE, 3.2, 1)
      .to(P.GOLD, 2.4, 1)
      .anim(0.3, 0, 0.05);
    this.pool.emit(this.s);
  }

  /** Lay the rocket's spark trail up to now; burst it when its time comes. */
  private fly(r: Rocket, now: number): void {
    const age = now - r.launch;
    if (age < 0) return;
    const T = r.burst - r.launch;
    const until = Math.min(age, T);
    const s = this.s;
    const rng = this.rng;
    let laid = 0;
    while (r.trailAge + TRAIL_STEP <= until && laid < 10) {
      r.trailAge += TRAIL_STEP;
      const a = r.trailAge;
      s.reset()
        .at(r.x0 + r.vx * a, r.y0 + r.vy * a - 0.5 * ROCKET_G * a * a, r.z0 + r.vz * a)
        .vel(-r.vx * 0.08 + rng.signed() * 1.2, -r.vy * 0.08 + rng.signed() * 1.2, -r.vz * 0.08 + rng.signed() * 1.2)
        .time(rng.range(0.45, 0.8), r.launch + a - now)
        .size(0.16, 0)
        .phys(4, 2)
        .from(P.GOLD, 2.6, 1)
        .to(P.EMBER, 0.8, 0)
        .look(Shape.Spark, 0, 0, 0.05)
        .anim(0.5, 0);
      this.pool.emit(s);
      laid++;
    }
    if (laid === 10) r.trailAge = until;
    if (age >= T) {
      r.active = false;
      this.burst(r, now);
    }
  }

  private burst(r: Rocket, now: number): void {
    const T = r.burst - r.launch;
    const bx = r.x0 + r.vx * T;
    const by = r.y0 + r.vy * T - 0.5 * ROCKET_G * T * T;
    const bz = r.z0 + r.vz * T;
    const delay = r.burst - now;
    const k = this.rng.range(0.85, 1.2);
    this.s.reset().at(bx, by, bz).time(0.28, delay).size(16 * k, 3).from(r.a, 1, 1).to(P.WHITE, 0.4, 0);
    this.pool.emit(this.s);
    switch (r.kind) {
      case 'peony':
        this.peony(bx, by, bz, delay, k, r.a, r.b);
        break;
      case 'ring':
        this.ring(bx, by, bz, delay, k, r.a, r.b);
        break;
      case 'willow':
        this.willow(bx, by, bz, delay, k);
        break;
      case 'crackle':
        this.crackle(bx, by, bz, delay, k, r.a);
        break;
      case 'pentagram':
        this.pentagram(bx, by, bz, delay, k, r.a);
        break;
    }
  }

  /** Fibonacci-sphere direction i of n (even coverage), jittered, into this.dir. */
  private sphereDir(i: number, n: number): THREE.Vector3 {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * GOLDEN_ANGLE;
    const j = this.rng;
    return this.dir.set(Math.cos(phi) * rr + j.signed() * 0.06, y + j.signed() * 0.06, Math.sin(phi) * rr + j.signed() * 0.06).normalize();
  }

  /** Classic chrysanthemum: an even sphere of streaking stars with a pistil of the second colour. */
  private peony(x: number, y: number, z: number, delay: number, k: number, a: THREE.Color, b: THREE.Color): void {
    const s = this.s;
    const rng = this.rng;
    const S = 26 * k;
    for (let i = 0, n = this.n(150); i < n; i++) {
      const d = this.sphereDir(i, n);
      const sp = S * rng.range(0.94, 1.06);
      s.reset()
        .at(x, y, z)
        .vel(d.x * sp, d.y * sp, d.z * sp)
        .time(rng.range(1.9, 2.5), delay)
        .size(0.75 * k, 0.2)
        .phys(3.5, 1.4)
        .from(a, 3, 1)
        .to(b, 1.4, 0)
        .look(Shape.Spark, 0, 0, 0.06)
        .anim(0.2, 0, 0.02);
      this.pool.emit(s);
    }
    for (let i = 0, n = this.n(40); i < n; i++) {
      const d = this.sphereDir(i, n);
      const sp = S * 0.45;
      s.reset()
        .at(x, y, z)
        .vel(d.x * sp, d.y * sp, d.z * sp)
        .time(rng.range(1.4, 1.8), delay)
        .size(0.6 * k, 0.15)
        .phys(3, 1.6)
        .from(b, 3, 1)
        .to(P.WHITE, 1.2, 0)
        .look(Shape.Spark, 0, 0, 0.05);
      this.pool.emit(s);
    }
  }

  /** A ring of stars in a plane turned roughly toward the camera, with a small core. */
  private ring(x: number, y: number, z: number, delay: number, k: number, a: THREE.Color, b: THREE.Color): void {
    const s = this.s;
    const rng = this.rng;
    const S = 27 * k;
    const N = this.dir.set(this.camera.position.x - x, this.camera.position.y - y, this.camera.position.z - z).normalize();
    N.x += rng.signed() * 0.6;
    N.y += rng.signed() * 0.6;
    N.z += rng.signed() * 0.6;
    N.normalize();
    this.planeBasis(N);
    for (let i = 0, n = this.n(90); i < n; i++) {
      const t = (i / n) * TAU;
      const c = Math.cos(t);
      const sn = Math.sin(t);
      const sp = S * rng.range(0.97, 1.03);
      s.reset()
        .at(x, y, z)
        .vel((this.ax.x * c + this.ay.x * sn) * sp, (this.ax.y * c + this.ay.y * sn) * sp, (this.ax.z * c + this.ay.z * sn) * sp)
        .time(rng.range(1.8, 2.3), delay)
        .size(0.7 * k, 0.2)
        .phys(3, 1.4)
        .from(a, 3, 1)
        .to(b, 1.4, 0)
        .look(Shape.Spark, 0, 0, 0.05);
      this.pool.emit(s);
    }
    for (let i = 0, n = this.n(30); i < n; i++) {
      const d = this.sphereDir(i, n);
      const sp = S * 0.32;
      s.reset()
        .at(x, y, z)
        .vel(d.x * sp, d.y * sp, d.z * sp)
        .time(rng.range(1.2, 1.6), delay)
        .size(0.55 * k, 0.1)
        .phys(3, 1.6)
        .from(b, 3, 1)
        .to(a, 1.2, 0)
        .look(Shape.Spark, 0, 0, 0.04);
      this.pool.emit(s);
    }
  }

  /**
   * Golden willow: slow drooping stars with long trails. Each trail is made of time-delayed
   * copies of its star on the same analytic path (they emerge from the burst point later
   * and lag behind), so the trail costs no per-frame work.
   */
  private willow(x: number, y: number, z: number, delay: number, k: number): void {
    const s = this.s;
    const rng = this.rng;
    const S = 19 * k;
    const ghosts = 4;
    for (let i = 0, n = this.n(80); i < n; i++) {
      const d = this.sphereDir(i, n);
      const sp = S * rng.range(0.9, 1.1);
      const life = rng.range(3.6, 4.6);
      for (let g = 0; g <= ghosts; g++) {
        const lag = g * 0.085;
        s.reset()
          .at(x, y, z)
          .vel(d.x * sp, d.y * sp, d.z * sp)
          .time(life - lag, delay + lag)
          .size((0.55 - g * 0.07) * k, 0.12)
          .phys(7, 1)
          .from(P.GOLD, 2.4, 0.85 * Math.pow(0.62, g))
          .to(P.EMBER, 0.8, 0)
          .look(Shape.Spark, 0, 0, 0.1)
          .anim(0.35, 0);
        this.pool.emit(s);
      }
    }
  }

  /** Crackle: a white-gold shell whose stars burst into a storm of tiny delayed flashes. */
  private crackle(x: number, y: number, z: number, delay: number, k: number, a: THREE.Color): void {
    const s = this.s;
    const rng = this.rng;
    const S = 21 * k;
    const drag = 1.6;
    const grav = 4;
    for (let i = 0, n = this.n(70); i < n; i++) {
      const d = this.sphereDir(i, n);
      const sp = S * rng.range(0.92, 1.08);
      const vx = d.x * sp;
      const vy = d.y * sp;
      const vz = d.z * sp;
      s.reset()
        .at(x, y, z)
        .vel(vx, vy, vz)
        .time(1.1, delay)
        .size(0.5 * k, 0.15)
        .phys(grav, drag)
        .from(P.WARM_WHITE, 2.5, 1)
        .to(P.GOLD, 1.5, 0)
        .look(Shape.Spark, 0, 0, 0.05);
      this.pool.emit(s);
      for (let c = 0; c < 3; c++) {
        // Where the star is at the crackle time (same analytic path as the shader).
        const tc = rng.range(0.7, 1.5);
        const f = (1 - Math.exp(-drag * tc)) / drag;
        s.reset()
          .at(x + vx * f, y + vy * f - 0.5 * grav * tc * tc, z + vz * f)
          .vel(rng.signed() * 1.5, rng.signed() * 1.5, rng.signed() * 1.5)
          .time(rng.range(0.07, 0.16), delay + tc)
          .size(rng.range(0.6, 1), 0.2)
          .from(P.WHITE, 4, 1)
          .to(a, 2, 0)
          .anim(0.6, 0, 0);
        this.pool.emit(s);
      }
    }
  }

  /**
   * Pentacle shell: stars on the five chords of a {5/2} star inside a circle, in a plane
   * facing the camera, point up. All stars share one drag, so positions scale uniformly
   * and the figure keeps its shape while it expands and droops.
   */
  private pentagram(x: number, y: number, z: number, delay: number, k: number, a: THREE.Color): void {
    const s = this.s;
    const S = 22 * k;
    const N = this.dir.set(this.camera.position.x - x, this.camera.position.y - y, this.camera.position.z - z).normalize();
    this.planeBasis(N);
    const perEdge = this.n(26);
    for (let e = 0; e < 5; e++) {
      const a0 = Math.PI / 2 + (e / 5) * TAU;
      const a1 = Math.PI / 2 + (((e + 2) % 5) / 5) * TAU;
      for (let j = 0; j < perEdge; j++) {
        const t = (j + 0.5) / perEdge;
        const px = Math.cos(a0) + (Math.cos(a1) - Math.cos(a0)) * t;
        const py = Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * t;
        this.figureStar(x, y, z, px, py, S, delay, P.YELLOW, P.GOLD, 0.6 * k);
      }
    }
    for (let i = 0, n = this.n(48); i < n; i++) {
      const t = (i / n) * TAU;
      this.figureStar(x, y, z, Math.cos(t), Math.sin(t), S, delay, a, P.WHITE, 0.5 * k);
    }
    s.reset().at(x, y, z).time(0.5, delay).size(5 * k, 1).from(P.YELLOW, 2.5, 1).to(a, 1, 0);
    this.pool.emit(s);
  }

  /** One star of a planar figure at figure point (px, py) (unit radius) in the ax/ay plane. */
  private figureStar(x: number, y: number, z: number, px: number, py: number, S: number, delay: number, c0: THREE.Color, c1: THREE.Color, size: number): void {
    const ax = this.ax;
    const ay = this.ay;
    this.s
      .reset()
      .at(x, y, z)
      .vel((ax.x * px + ay.x * py) * S, (ax.y * px + ay.y * py) * S, (ax.z * px + ay.z * py) * S)
      .time(2.6, delay)
      .size(size, 0.15)
      .phys(1.2, 1.5)
      .from(c0, 3, 1)
      .to(c1, 1.4, 0)
      .look(Shape.Spark, 0, 0, 0.03);
    this.pool.emit(this.s);
  }

  /** Orthonormal basis (ax right, ay up-ish) of the plane with normal N. */
  private planeBasis(N: THREE.Vector3): void {
    this.ax.set(N.z, 0, -N.x);
    if (this.ax.lengthSq() < 1e-6) this.ax.set(1, 0, 0);
    this.ax.normalize();
    this.ay.crossVectors(N, this.ax).normalize();
  }
}
