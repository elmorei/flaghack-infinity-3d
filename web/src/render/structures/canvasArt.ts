/**
 * Procedural 2D art for the structures: every texture is painted onto a canvas at start-up
 * (no asset files). Deterministic per seed so camps look the same every match.
 *
 * Painted surfaces: wood grain, bark, stone blocks, bricks, festival tarp, the GCC's
 * spray-painted five-Flag pinwheel sigil, the lettered banner (front/back), string-art
 * pentagram drum tops, scroll parchment, glowing coal beds, the Ward's all-seeing eye and
 * runes, the Drug Lab bus livery, and soft sprites for smoke and light pools.
 */
import { seededRandom } from './util';

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas unavailable');
  return [c, g];
}

const TAU = Math.PI * 2;

// ── Natural materials ────────────────────────────────────────────────────────

/** Light warm wood grain along +u; material colour tints it (planks, posts, poles). */
export function paintWoodGrain(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  g.fillStyle = '#e9d2b0';
  g.fillRect(0, 0, size, size);
  // Long wavy grain lines, darker and denser in bands like growth rings.
  for (let i = 0; i < 90; i++) {
    const y0 = rnd() * size;
    const amp = 2 + rnd() * 6;
    const freq = (1 + rnd() * 2) * (TAU / size);
    const phase = rnd() * TAU;
    const dark = 0.06 + rnd() * 0.18;
    g.strokeStyle = `rgba(90, 52, 22, ${dark})`;
    g.lineWidth = 0.6 + rnd() * 1.8;
    g.beginPath();
    for (let x = -4; x <= size + 4; x += 4) {
      const y = y0 + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 3.1 + phase) * amp * 0.25;
      if (x === -4) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // A couple of knots with concentric rings.
  for (let k = 0; k < 2; k++) {
    const kx = rnd() * size;
    const ky = rnd() * size;
    for (let r = 10; r > 1; r -= 2) {
      g.strokeStyle = `rgba(80, 42, 16, ${0.12 + (10 - r) * 0.03})`;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(kx, ky, r * 1.8, r * 0.8, 0, 0, TAU);
      g.stroke();
    }
  }
  // Fine pores.
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(70, 40, 18, ${0.05 + rnd() * 0.08})`;
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 3, 1);
  }
  return c;
}

/** Furrowed dark bark running along +v (log seats). */
export function paintBark(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  g.fillStyle = '#6b5440';
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) {
    const x0 = rnd() * size;
    g.strokeStyle = `rgba(28, 18, 10, ${0.25 + rnd() * 0.45})`;
    g.lineWidth = 1.5 + rnd() * 4;
    g.beginPath();
    let x = x0;
    g.moveTo(x, -4);
    for (let y = 0; y <= size + 8; y += 8) {
      x += (rnd() - 0.5) * 4;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 500; i++) {
    g.fillStyle = `rgba(190, 170, 140, ${rnd() * 0.12})`;
    g.fillRect(rnd() * size, rnd() * size, 2, 2 + rnd() * 6);
  }
  return c;
}

/** Irregular rough-cut stone blocks with dark mortar (fire pit, obelisk). */
export function paintStoneBlocks(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  g.fillStyle = '#3a3632';
  g.fillRect(0, 0, size, size);
  const rows = 5;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * 40;
    while (x < size) {
      const w = 34 + rnd() * 50;
      const shade = 120 + rnd() * 70;
      const warm = rnd() * 18;
      g.fillStyle = `rgb(${shade + warm}, ${shade + warm * 0.6}, ${shade - 4})`;
      const inset = 2.5;
      g.beginPath();
      g.roundRect(x + inset, r * rh + inset, w - inset * 2, rh - inset * 2, 5);
      g.fill();
      // Top-edge highlight and bottom shadow give the blocks relief.
      g.fillStyle = 'rgba(255, 255, 255, 0.10)';
      g.fillRect(x + inset + 2, r * rh + inset, w - inset * 2 - 4, 3);
      g.fillStyle = 'rgba(0, 0, 0, 0.22)';
      g.fillRect(x + inset + 2, (r + 1) * rh - inset - 4, w - inset * 2 - 4, 4);
      x += w;
    }
  }
  for (let i = 0; i < 2600; i++) {
    const v = rnd() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v}, ${v}, ${v}, ${rnd() * 0.08})`;
    g.fillRect(rnd() * size, rnd() * size, 1 + rnd() * 2, 1 + rnd() * 2);
  }
  return c;
}

/** Running-bond fired bricks (Hearth pit wall facing). */
export function paintBricks(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  g.fillStyle = '#b9ab98';
  g.fillRect(0, 0, size, size);
  const rows = 8;
  const rh = size / rows;
  const bw = size / 4;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 === 0 ? 0 : bw / 2;
    for (let x = -bw + off; x < size; x += bw) {
      const red = 120 + rnd() * 60;
      g.fillStyle = `rgb(${red}, ${red * 0.45 + rnd() * 10}, ${red * 0.32})`;
      g.fillRect(x + 2, r * rh + 2, bw - 4, rh - 4);
      g.fillStyle = `rgba(0, 0, 0, ${rnd() * 0.25})`;
      g.fillRect(x + 2, r * rh + rh - 6, bw - 4, 4);
    }
  }
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(30, 10, 5, ${rnd() * 0.12})`;
    g.fillRect(rnd() * size, rnd() * size, 2, 2);
  }
  return c;
}

/**
 * Festival tarp for wall pieces: pale woven canvas (instance colour tints it per faction),
 * reinforced hem with brass grommets on every edge, creases and a little mud at the foot.
 */
export function paintTarp(w: number, h: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(seed);
  g.fillStyle = '#e4e1d8';
  g.fillRect(0, 0, w, h);
  // Weave.
  for (let y = 0; y < h; y += 2) {
    g.fillStyle = `rgba(0, 0, 0, ${0.025 + rnd() * 0.02})`;
    g.fillRect(0, y, w, 1);
  }
  for (let x = 0; x < w; x += 2) {
    g.fillStyle = `rgba(255, 255, 255, ${0.03 + rnd() * 0.03})`;
    g.fillRect(x, 0, 1, h);
  }
  // Creases: soft diagonal light/dark bands where the fabric folds against the frame.
  for (let i = 0; i < 7; i++) {
    const x = rnd() * w;
    const grad = g.createLinearGradient(x - 30, 0, x + 30, h * 0.4);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, `rgba(0,0,0,${0.05 + rnd() * 0.07})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }
  // Faded stencil: a five-Flag pentagram, the camp's mark.
  g.save();
  g.translate(w / 2, h / 2);
  g.strokeStyle = 'rgba(40, 40, 40, 0.10)';
  g.lineWidth = 7;
  g.beginPath();
  const R = h * 0.3;
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + ((k * 2) % 5) * (TAU / 5);
    if (k === 0) g.moveTo(Math.cos(a) * R, Math.sin(a) * R);
    else g.lineTo(Math.cos(a) * R, Math.sin(a) * R);
  }
  g.stroke();
  g.restore();
  // Mud splash at the foot.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * w;
    const y = h - Math.pow(rnd(), 2) * h * 0.25;
    g.fillStyle = `rgba(70, 52, 30, ${rnd() * 0.18})`;
    g.beginPath();
    g.arc(x, y, 0.5 + rnd() * 2.2, 0, TAU);
    g.fill();
  }
  // Hem.
  const hem = Math.round(h * 0.05);
  g.fillStyle = 'rgba(0, 0, 0, 0.13)';
  g.fillRect(0, 0, w, hem);
  g.fillRect(0, h - hem, w, hem);
  g.fillRect(0, 0, hem, h);
  g.fillRect(w - hem, 0, hem, h);
  g.strokeStyle = 'rgba(0, 0, 0, 0.25)';
  g.setLineDash([5, 4]);
  g.lineWidth = 1.5;
  g.strokeRect(hem + 2, hem + 2, w - hem * 2 - 4, h - hem * 2 - 4);
  g.setLineDash([]);
  // Grommets.
  const grommet = (x: number, y: number): void => {
    g.fillStyle = '#b8902e';
    g.beginPath();
    g.arc(x, y, hem * 0.42, 0, TAU);
    g.fill();
    g.fillStyle = '#2a241a';
    g.beginPath();
    g.arc(x, y, hem * 0.2, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255, 240, 190, 0.6)';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(x - 0.6, y - 0.6, hem * 0.33, Math.PI, Math.PI * 1.6);
    g.stroke();
  };
  const step = w / 8;
  for (let x = step / 2; x < w; x += step) {
    grommet(x, hem / 2);
    grommet(x, h - hem / 2);
  }
  for (let y = h / 4; y < h; y += h / 4) {
    grommet(hem / 2, y);
    grommet(w - hem / 2, y);
  }
  return c;
}

// ── The Geomantic Command Center ─────────────────────────────────────────────

/**
 * The five-Flag pinwheel sigil, spray-painted yellow on a black bevelled panel: five
 * Flags on poles radiating from the Omega point, their cloths all turning the same way
 * (pinwheel), the pentagram strung through the pole tips, with overspray haze, speckle
 * and drips like the 2017 cart.
 */
export function paintSigil(w: number, h: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(seed);
  // Satin black with faint brush streaks.
  g.fillStyle = '#0c0c0e';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 160; i++) {
    const y = rnd() * h;
    g.strokeStyle = `rgba(255, 255, 255, ${0.01 + rnd() * 0.025})`;
    g.lineWidth = 1 + rnd() * 3;
    g.beginPath();
    g.moveTo(rnd() * w * 0.3, y);
    g.lineTo(w * (0.6 + rnd() * 0.4), y + (rnd() - 0.5) * 6);
    g.stroke();
  }
  // Bevel catchlight around the panel edge.
  g.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  g.lineWidth = 6;
  g.strokeRect(5, 5, w - 10, h - 10);
  g.strokeStyle = 'rgba(0, 0, 0, 0.6)';
  g.lineWidth = 3;
  g.strokeRect(11, 11, w - 22, h - 22);

  const cx = w / 2;
  const cy = h / 2 + h * 0.02;
  const R = Math.min(w, h) * 0.4;
  const yellow = '#ffd21a';
  const tips: [number, number][] = [];
  const dirs: [number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (TAU / 5);
    dirs.push([Math.cos(a), Math.sin(a)]);
    tips.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
  }
  // Collected stroke segments for overspray speckle.
  const segs: number[] = [];

  const drawFigure = (): void => {
    // Pentagram through the tips.
    g.lineWidth = R * 0.045;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.beginPath();
    for (let k = 0; k <= 5; k++) {
      const t = tips[(k * 2) % 5];
      if (k === 0) g.moveTo(t[0], t[1]);
      else g.lineTo(t[0], t[1]);
    }
    g.stroke();
    // Poles from the Omega ring to the tips.
    g.lineWidth = R * 0.055;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(cx + dirs[k][0] * R * 0.14, cy + dirs[k][1] * R * 0.14);
      g.lineTo(tips[k][0] + dirs[k][0] * R * 0.06, tips[k][1] + dirs[k][1] * R * 0.06);
      g.stroke();
    }
    // Pinwheel Flags: each hoisted just below its pole tip, flying clockwise with an S-wave,
    // a finial knob above the hoist.
    for (let k = 0; k < 5; k++) {
      const [dx, dz] = dirs[k];
      const px = -dz;
      const pz = dx;
      const hoist = R * 0.3;
      const fly = R * 0.52;
      const amp = R * 0.06;
      const ax = tips[k][0] - dx * R * 0.02;
      const az = tips[k][1] - dz * R * 0.02;
      const bx = ax - dx * hoist;
      const bz = az - dz * hoist;
      g.beginPath();
      g.moveTo(ax, az);
      g.bezierCurveTo(
        ax + px * fly * 0.33 + dx * amp,
        az + pz * fly * 0.33 + dz * amp,
        ax + px * fly * 0.66 - dx * amp,
        az + pz * fly * 0.66 - dz * amp,
        ax + px * fly + dx * amp * 0.4,
        az + pz * fly + dz * amp * 0.4,
      );
      g.lineTo(bx + px * fly + dx * amp * 0.4, bz + pz * fly + dz * amp * 0.4);
      g.bezierCurveTo(
        bx + px * fly * 0.66 - dx * amp,
        bz + pz * fly * 0.66 - dz * amp,
        bx + px * fly * 0.33 + dx * amp,
        bz + pz * fly * 0.33 + dz * amp,
        bx,
        bz,
      );
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(tips[k][0] + dx * R * 0.07, tips[k][1] + dz * R * 0.07, R * 0.05, 0, TAU);
      g.fill();
    }
    // The Omega point.
    g.lineWidth = R * 0.04;
    g.beginPath();
    g.arc(cx, cy, R * 0.12, 0, TAU);
    g.stroke();
    g.beginPath();
    g.arc(cx, cy, R * 0.045, 0, TAU);
    g.fill();
  };

  for (let k = 0; k < 5; k++) {
    const a = tips[k];
    const b = tips[(k + 2) % 5];
    segs.push(a[0], a[1], b[0], b[1]);
    segs.push(cx, cy, a[0], a[1]);
  }

  // Overspray haze, then the crisp coat.
  g.save();
  g.fillStyle = yellow;
  g.strokeStyle = yellow;
  g.globalAlpha = 0.55;
  g.shadowColor = 'rgba(255, 205, 30, 0.9)';
  g.shadowBlur = R * 0.12;
  drawFigure();
  g.restore();
  g.save();
  g.fillStyle = yellow;
  g.strokeStyle = yellow;
  g.shadowColor = 'rgba(255, 200, 20, 0.6)';
  g.shadowBlur = R * 0.03;
  drawFigure();
  g.restore();

  // Speckle scattered around the strokes.
  g.fillStyle = yellow;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const ay = segs[s + 1];
    const bx = segs[s + 2];
    const by = segs[s + 3];
    for (let i = 0; i < 90; i++) {
      const t = rnd();
      const spread = (rnd() + rnd() + rnd() - 1.5) * R * 0.12;
      const len = Math.hypot(bx - ax, by - ay) || 1;
      const nx = -(by - ay) / len;
      const ny = (bx - ax) / len;
      g.globalAlpha = 0.25 + rnd() * 0.6;
      g.beginPath();
      g.arc(ax + (bx - ax) * t + nx * spread, ay + (by - ay) * t + ny * spread, 0.4 + rnd() * 1.3, 0, TAU);
      g.fill();
    }
  }
  // Drips from the lower strokes.
  g.globalAlpha = 0.9;
  g.strokeStyle = yellow;
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const k = Math.floor(rnd() * 5);
    const t = 0.3 + rnd() * 0.6;
    const x = cx + (tips[k][0] - cx) * t + (rnd() - 0.5) * 8;
    const y = cy + (tips[k][1] - cy) * t;
    const len = 8 + rnd() * R * 0.35;
    g.lineWidth = 1.5 + rnd() * 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 2, y + len);
    g.stroke();
    g.beginPath();
    g.arc(x, y + len, g.lineWidth * 0.9, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

/**
 * Hand-painted line of lettering, kept tall by condensing it horizontally to fit `maxW`
 * (down to 72%, then the size drops): a soft paint-bleed pass, then the crisp pass, with a
 * slight wobble.
 */
function paintLettering(
  g: CanvasRenderingContext2D,
  text: string,
  font: string,
  size: number,
  x: number,
  y: number,
  maxW: number,
  rnd: () => number,
): void {
  let s = size;
  g.font = `${font.replace('{s}', String(s))}`;
  let squeeze = Math.min(1, maxW / g.measureText(text).width);
  if (squeeze < 0.72) {
    s = Math.floor((s * squeeze) / 0.72);
    g.font = `${font.replace('{s}', String(s))}`;
    squeeze = Math.min(1, maxW / g.measureText(text).width);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(x, y);
  g.rotate((rnd() - 0.5) * 0.012);
  g.scale(squeeze, 1);
  g.fillStyle = 'rgba(20, 14, 6, 0.35)';
  g.fillText(text, 1.5, 1.5);
  g.fillStyle = '#17110a';
  g.strokeStyle = '#17110a';
  g.lineWidth = s * 0.025;
  g.fillText(text, 0, 0);
  g.strokeText(text, 0, 0);
  g.restore();
}

function paintStar(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + ((k * 2) % 5) * (TAU / 5);
    if (k === 0) g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    else g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  g.closePath();
  g.fill('evenodd');
  g.stroke();
}

/** Yellow fabric ground shared by both banner faces: weave, hem stitching, corner grommets. */
function paintBannerCloth(g: CanvasRenderingContext2D, w: number, h: number, rnd: () => number): void {
  g.fillStyle = '#ffd400';
  g.fillRect(0, 0, w, h);
  const shade = g.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, w * 0.62);
  shade.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  shade.addColorStop(1, 'rgba(120, 70, 0, 0.22)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 3) {
    g.fillStyle = `rgba(120, 80, 0, ${0.03 + rnd() * 0.03})`;
    g.fillRect(0, y, w, 1);
  }
  for (let x = 0; x < w; x += 3) {
    g.fillStyle = `rgba(255, 255, 255, ${0.02 + rnd() * 0.03})`;
    g.fillRect(x, 0, 1, h);
  }
  // Hem and stitching.
  g.strokeStyle = 'rgba(70, 45, 0, 0.55)';
  g.lineWidth = 3;
  g.setLineDash([10, 7]);
  g.strokeRect(16, 16, w - 32, h - 32);
  g.setLineDash([]);
  g.strokeStyle = 'rgba(20, 14, 6, 0.85)';
  g.lineWidth = 5;
  g.strokeRect(30, 30, w - 60, h - 60);
  // Grommets where the banner is lashed to the poles.
  for (const [x, y] of [
    [14, 14],
    [w - 14, 14],
    [14, h - 14],
    [w - 14, h - 14],
    [14, h / 2],
    [w - 14, h / 2],
  ]) {
    g.fillStyle = '#9a8a60';
    g.beginPath();
    g.arc(x, y, 9, 0, TAU);
    g.fill();
    g.fillStyle = '#2a2418';
    g.beginPath();
    g.arc(x, y, 4.5, 0, TAU);
    g.fill();
  }
}

/** Front of the GCC banner: the four services, lettered like the 2017 original. */
export function paintBannerFront(w: number, h: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(1423);
  paintBannerCloth(g, w, h, rnd);
  const stencil = '700 {s}px "Stardos Stencil"';
  const bungee = '400 {s}px "Bungee"';
  paintLettering(g, 'GEOMANTIC COMMAND CENTER', stencil, Math.round(h * 0.22), w / 2, h * 0.205, w - 90, rnd);
  // Divider: rule with five-pointed stars.
  g.strokeStyle = '#17110a';
  g.fillStyle = '#17110a';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(w * 0.1, h * 0.355);
  g.lineTo(w * 0.9, h * 0.355);
  g.stroke();
  g.lineWidth = 1.5;
  for (const fx of [0.1, 0.5, 0.9]) paintStar(g, w * fx, h * 0.355, h * 0.03);
  const sub = Math.round(h * 0.118);
  paintLettering(g, 'FLAG REPAIR \u2013 RECRUITMENT', bungee, sub, w / 2, h * 0.47, w * 0.8, rnd);
  paintLettering(g, 'GEOMANTIC ADVICE', bungee, sub, w / 2, h * 0.625, w * 0.8, rnd);
  paintLettering(g, 'FLAGELLIAN DIALECTICS', bungee, sub, w / 2, h * 0.78, w * 0.8, rnd);
  return c;
}

/** Back of the banner, seen while pushing the cart: COMMAND CENTER / FLAG SIMULACRA. */
export function paintBannerBack(w: number, h: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(2017);
  paintBannerCloth(g, w, h, rnd);
  paintLettering(g, 'COMMAND CENTER', '700 {s}px "Stardos Stencil"', Math.round(h * 0.25), w / 2, h * 0.3, w - 140, rnd);
  // Small pinwheel emblem between the lines.
  g.save();
  g.translate(w / 2, h * 0.53);
  g.fillStyle = '#17110a';
  g.strokeStyle = '#17110a';
  g.lineWidth = 2;
  const r = h * 0.075;
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (TAU / 5);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(dx * r, dz * r);
    g.stroke();
    g.beginPath();
    g.moveTo(dx * r, dz * r);
    g.lineTo(dx * r - dz * r * 0.6, dz * r + dx * r * 0.6);
    g.lineTo(dx * r * 0.6 - dz * r * 0.6, dz * r * 0.6 + dx * r * 0.6);
    g.lineTo(dx * r * 0.6, dz * r * 0.6);
    g.closePath();
    g.fill();
  }
  g.restore();
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(w * 0.14, h * 0.53);
  g.lineTo(w / 2 - h * 0.12, h * 0.53);
  g.moveTo(w / 2 + h * 0.12, h * 0.53);
  g.lineTo(w * 0.86, h * 0.53);
  g.stroke();
  paintLettering(g, 'FLAG SIMULACRA', '400 {s}px "Bungee"', Math.round(h * 0.19), w / 2, h * 0.76, w - 160, rnd);
  return c;
}

/**
 * String-art pentagram on a round drum top: a ring of nails, coloured thread envelopes
 * (parabolic string curves) in every star point, and the bold pentagram in white thread.
 */
export function paintStringArt(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  const cx = size / 2;
  const cy = size / 2;
  const wood = g.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.5);
  wood.addColorStop(0, '#3a2414');
  wood.addColorStop(0.85, '#22140a');
  wood.addColorStop(1, '#120a05');
  g.fillStyle = wood;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 60; i++) {
    g.strokeStyle = `rgba(255, 220, 180, ${rnd() * 0.04})`;
    g.lineWidth = 1 + rnd() * 2;
    g.beginPath();
    g.arc(cx, cy, rnd() * size * 0.48, 0, TAU);
    g.stroke();
  }
  const R = size * 0.42;
  const tips: [number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (TAU / 5) + seed * 0.1;
    tips.push([cx + Math.cos(a) * R, cy + Math.sin(a) * R]);
  }
  const hue0 = rnd() * 360;
  g.lineWidth = size / 512;
  // Envelope in each star point: strings joining the two star edges that meet there.
  for (let k = 0; k < 5; k++) {
    const t = tips[k];
    const a = tips[(k + 2) % 5];
    const b = tips[(k + 3) % 5];
    const hue = (hue0 + k * 72) % 360;
    const n = 22;
    for (let i = 0; i <= n; i++) {
      const s = i / n;
      const p0x = t[0] + (a[0] - t[0]) * s * 0.62;
      const p0y = t[1] + (a[1] - t[1]) * s * 0.62;
      const p1x = t[0] + (b[0] - t[0]) * (1 - s) * 0.62;
      const p1y = t[1] + (b[1] - t[1]) * (1 - s) * 0.62;
      g.strokeStyle = `hsla(${hue + s * 40}, 95%, 60%, 0.9)`;
      g.beginPath();
      g.moveTo(p0x, p0y);
      g.lineTo(p1x, p1y);
      g.stroke();
    }
  }
  // Inner pentagon envelope (between adjacent tips through the centre region).
  for (let k = 0; k < 5; k++) {
    const a = tips[k];
    const b = tips[(k + 1) % 5];
    const hue = (hue0 + 180 + k * 72) % 360;
    for (let i = 0; i <= 12; i++) {
      const s = i / 12;
      g.strokeStyle = `hsla(${hue}, 90%, 62%, 0.7)`;
      g.beginPath();
      g.moveTo(a[0] + (cx - a[0]) * s, a[1] + (cy - a[1]) * s);
      g.lineTo(b[0] + (cx - b[0]) * (1 - s), b[1] + (cy - b[1]) * (1 - s));
      g.stroke();
    }
  }
  // The pentagram itself, triple-wound in white thread.
  g.strokeStyle = 'rgba(255, 252, 240, 0.95)';
  for (let pass = 0; pass < 3; pass++) {
    g.lineWidth = size / 300;
    g.beginPath();
    for (let k = 0; k <= 5; k++) {
      const t = tips[(k * 2) % 5];
      if (k === 0) g.moveTo(t[0] + pass * 0.6, t[1]);
      else g.lineTo(t[0] + pass * 0.6, t[1]);
    }
    g.stroke();
  }
  // Nail ring.
  const nails = 50;
  for (let i = 0; i < nails; i++) {
    const a = (i / nails) * TAU;
    const x = cx + Math.cos(a) * size * 0.455;
    const y = cy + Math.sin(a) * size * 0.455;
    g.fillStyle = '#8c8c88';
    g.beginPath();
    g.arc(x, y, size / 140, 0, TAU);
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.7)';
    g.beginPath();
    g.arc(x - 0.8, y - 0.8, size / 400, 0, TAU);
    g.fill();
  }
  for (const t of tips) {
    g.fillStyle = '#c9c9c4';
    g.beginPath();
    g.arc(t[0], t[1], size / 110, 0, TAU);
    g.fill();
  }
  return c;
}

/** Aged parchment with ink: scroll sheet (title flourish, script, a Flag diagram, wax seal). */
export function paintScroll(w: number, h: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(seed);
  g.fillStyle = '#e7d3a4';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 10 + rnd() * 50;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(150, 100, 40, ${rnd() * 0.12})`);
    gr.addColorStop(1, 'rgba(150, 100, 40, 0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const edge = g.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, 'rgba(110, 70, 20, 0.35)');
  edge.addColorStop(0.12, 'rgba(110, 70, 20, 0)');
  edge.addColorStop(0.88, 'rgba(110, 70, 20, 0)');
  edge.addColorStop(1, 'rgba(110, 70, 20, 0.35)');
  g.fillStyle = edge;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#3a2410';
  g.font = `700 ${Math.round(w * 0.11)}px "Cinzel"`;
  g.textAlign = 'center';
  g.fillText('VEXILLORAMANOMICON', w / 2, h * 0.09, w * 0.9);
  g.strokeStyle = 'rgba(58, 36, 16, 0.85)';
  g.lineWidth = 1.2;
  for (let line = 0; line < 14; line++) {
    const y = h * 0.14 + line * h * 0.028;
    let x = w * 0.1;
    g.beginPath();
    g.moveTo(x, y);
    while (x < w * 0.9) {
      const step = 3 + rnd() * 6;
      g.lineTo(x + step, y + (rnd() - 0.5) * 3);
      x += step;
      if (rnd() < 0.12) {
        x += 6;
        g.moveTo(x, y);
      }
    }
    g.stroke();
  }
  // Diagram: five Flags on a pentagon with red ley lines.
  const dx = w / 2;
  const dy = h * 0.66;
  const R = w * 0.25;
  g.strokeStyle = '#b3121b';
  g.lineWidth = 2;
  g.beginPath();
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + ((k * 2) % 5) * (TAU / 5);
    if (k === 0) g.moveTo(dx + Math.cos(a) * R, dy + Math.sin(a) * R);
    else g.lineTo(dx + Math.cos(a) * R, dy + Math.sin(a) * R);
  }
  g.stroke();
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (TAU / 5);
    const x = dx + Math.cos(a) * R;
    const y = dy + Math.sin(a) * R;
    g.strokeStyle = '#3a2410';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x, y - 14);
    g.stroke();
    g.fillStyle = '#e8b800';
    g.fillRect(x, y - 14, 9, 6);
  }
  // Wax seal.
  g.fillStyle = '#8e1018';
  g.beginPath();
  g.arc(w * 0.78, h * 0.9, w * 0.07, 0, TAU);
  g.fill();
  g.fillStyle = 'rgba(255, 180, 160, 0.35)';
  g.beginPath();
  g.arc(w * 0.77, h * 0.89, w * 0.035, 0, TAU);
  g.fill();
  return c;
}

// ── Light, fire, smoke ───────────────────────────────────────────────────────

/** Glowing coal bed for emissive maps: black with branching orange-hot cracks and hot spots. */
export function paintEmbers(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  g.fillStyle = '#000';
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';
  for (let i = 0; i < 70; i++) {
    let x = rnd() * size;
    let y = rnd() * size;
    let a = rnd() * TAU;
    const heat = rnd();
    g.strokeStyle = `rgba(255, ${90 + heat * 120}, ${20 + heat * 40}, ${0.4 + heat * 0.6})`;
    g.lineWidth = 1 + rnd() * 3;
    g.shadowColor = 'rgba(255, 120, 20, 1)';
    g.shadowBlur = 8;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      a += (rnd() - 0.5) * 1.4;
      x += Math.cos(a) * 12;
      y += Math.sin(a) * 12;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  g.shadowBlur = 0;
  for (let i = 0; i < 40; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const r = 4 + rnd() * 14;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255, 220, 120, 0.95)');
    gr.addColorStop(1, 'rgba(255, 80, 0, 0)');
    g.fillStyle = gr;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

/** Soft cloudy puff sprite (white, alpha in the canvas) for smoke and vapour. */
export function paintPuff(size: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const rnd = seededRandom(seed);
  const cx = size / 2;
  for (let i = 0; i < 14; i++) {
    const a = rnd() * TAU;
    const d = rnd() * size * 0.18;
    const x = cx + Math.cos(a) * d;
    const y = cx + Math.sin(a) * d;
    const r = size * (0.16 + rnd() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
    gr.addColorStop(1, 'rgba(255, 255, 255, 0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, size, size);
  }
  return c;
}

/** Radial falloff (light pools, pulse glows). */
export function paintRadialGlow(size: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, 'rgba(255, 255, 255, 1)');
  gr.addColorStop(0.35, 'rgba(255, 255, 255, 0.55)');
  gr.addColorStop(0.7, 'rgba(255, 255, 255, 0.15)');
  gr.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

// ── Hearth Ward ──────────────────────────────────────────────────────────────

/**
 * The Ward's lens face: a gilded triangle with rays around an almond eye. The iris and
 * pupil are separate (faction-lit) geometry, so the iris area is left pale.
 */
export function paintEye(size: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const cx = size / 2;
  const cy = size / 2;
  const disc = g.createRadialGradient(cx, cy, 0, cx, cy, size / 2);
  disc.addColorStop(0, '#2a1d08');
  disc.addColorStop(0.9, '#120c04');
  disc.addColorStop(1, '#5a4210');
  g.fillStyle = disc;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = 'rgba(255, 210, 90, 0.55)';
  g.lineWidth = size / 128;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * TAU;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * size * 0.3, cy + Math.sin(a) * size * 0.3);
    g.lineTo(cx + Math.cos(a) * size * (i % 2 === 0 ? 0.48 : 0.42), cy + Math.sin(a) * size * (i % 2 === 0 ? 0.48 : 0.42));
    g.stroke();
  }
  // Gilded triangle.
  const tr = size * 0.36;
  g.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + k * (TAU / 3);
    const x = cx + Math.cos(a) * tr;
    const y = cy + 12 + Math.sin(a) * tr;
    if (k === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
  const gold = g.createLinearGradient(0, cy - tr, 0, cy + tr);
  gold.addColorStop(0, '#ffe9a0');
  gold.addColorStop(0.5, '#d9a321');
  gold.addColorStop(1, '#8a5a0c');
  g.fillStyle = gold;
  g.fill();
  g.strokeStyle = '#3a2404';
  g.lineWidth = size / 64;
  g.stroke();
  // Almond eye.
  const ew = size * 0.2;
  const eh = size * 0.085;
  const ey = cy + size * 0.06;
  g.beginPath();
  g.moveTo(cx - ew, ey);
  g.quadraticCurveTo(cx, ey - eh * 2, cx + ew, ey);
  g.quadraticCurveTo(cx, ey + eh * 2, cx - ew, ey);
  g.closePath();
  g.fillStyle = '#fbf6e8';
  g.fill();
  g.strokeStyle = '#1c1206';
  g.lineWidth = size / 50;
  g.stroke();
  for (let i = 0; i < 7; i++) {
    const t = (i + 1) / 8;
    const x = cx - ew + t * ew * 2;
    const y = ey - Math.sin(t * Math.PI) * eh * 1.0;
    g.lineWidth = size / 160;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (t - 0.5) * size * 0.03, y - size * 0.035);
    g.stroke();
  }
  return c;
}

/** Carved rune bands for the Ward obelisk (emissive map; five faces across u). */
export function paintRunes(w: number, h: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(seed);
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineCap = 'round';
  const faces = 5;
  const fw = w / faces;
  for (let f = 0; f < faces; f++) {
    const cx = f * fw + fw / 2;
    for (let row = 0; row < 7; row++) {
      const cy = h * 0.12 + row * h * 0.105;
      const s = fw * 0.22;
      g.lineWidth = Math.max(1.5, fw / 40);
      g.beginPath();
      const kind = Math.floor(rnd() * 5);
      if (kind === 0) {
        g.moveTo(cx, cy - s);
        g.lineTo(cx, cy + s);
        g.moveTo(cx, cy - s * 0.3);
        g.lineTo(cx + s * 0.7, cy - s);
      } else if (kind === 1) {
        g.arc(cx, cy, s * 0.6, 0, TAU);
        g.moveTo(cx - s, cy + s);
        g.lineTo(cx + s, cy + s);
      } else if (kind === 2) {
        for (let k = 0; k <= 5; k++) {
          const a = -Math.PI / 2 + ((k * 2) % 5) * (TAU / 5);
          if (k === 0) g.moveTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
          else g.lineTo(cx + Math.cos(a) * s, cy + Math.sin(a) * s);
        }
      } else if (kind === 3) {
        g.moveTo(cx - s, cy - s);
        g.lineTo(cx, cy + s);
        g.lineTo(cx + s, cy - s);
        g.moveTo(cx - s * 0.5, cy);
        g.lineTo(cx + s * 0.5, cy);
      } else {
        g.moveTo(cx, cy - s);
        g.lineTo(cx, cy + s);
        g.moveTo(cx, cy - s);
        g.lineTo(cx + s * 0.6, cy - s * 0.6);
        g.lineTo(cx, cy - s * 0.2);
      }
      g.stroke();
    }
    // Band lines between rune rows.
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(f * fw + fw * 0.15, h * 0.05);
    g.lineTo(f * fw + fw * 0.85, h * 0.05);
    g.moveTo(f * fw + fw * 0.15, h * 0.86);
    g.lineTo(f * fw + fw * 0.85, h * 0.86);
    g.stroke();
  }
  return c;
}

// ── Drug Lab ─────────────────────────────────────────────────────────────────

/**
 * Livery for the converted school bus: school-bus chrome-yellow repainted with rainbow
 * waves, flowers, spirals and a five-Flag eye, lettered VEXIHERBOLOGY.
 */
export function paintBusSide(w: number, h: number, seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(w, h);
  const rnd = seededRandom(seed);
  g.fillStyle = '#f2b705';
  g.fillRect(0, 0, w, h);
  // Rainbow waves along the lower body.
  const hues = [0, 30, 55, 120, 200, 270];
  for (let i = 0; i < hues.length; i++) {
    g.strokeStyle = `hsl(${hues[i]}, 85%, 52%)`;
    g.lineWidth = h * 0.045;
    g.beginPath();
    for (let x = -10; x <= w + 10; x += 8) {
      const y = h * (0.62 + i * 0.05) + Math.sin(x * 0.012 + i * 0.5) * h * 0.06;
      if (x === -10) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  // Flowers.
  for (let i = 0; i < 9; i++) {
    const x = rnd() * w;
    const y = h * (0.1 + rnd() * 0.4);
    const r = h * (0.04 + rnd() * 0.05);
    const hue = rnd() * 360;
    for (let p = 0; p < 5; p++) {
      const a = (p / 5) * TAU;
      g.fillStyle = `hsl(${hue}, 90%, 60%)`;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.8, r * 0.45, a, 0, TAU);
      g.fill();
    }
    g.fillStyle = '#fff6c0';
    g.beginPath();
    g.arc(x, y, r * 0.45, 0, TAU);
    g.fill();
  }
  // Spirals.
  for (let i = 0; i < 4; i++) {
    const x = rnd() * w;
    const y = h * (0.15 + rnd() * 0.35);
    g.strokeStyle = `hsl(${rnd() * 360}, 80%, 40%)`;
    g.lineWidth = 3;
    g.beginPath();
    for (let t = 0; t < 18; t += 0.2) {
      const r = t * h * 0.006;
      const px = x + Math.cos(t) * r;
      const py = y + Math.sin(t) * r;
      if (t === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }
  // Big emblem: an eye inside a pentagram.
  const ex = w * 0.78;
  const ey = h * 0.33;
  const R = h * 0.22;
  g.fillStyle = '#1a0f2e';
  g.beginPath();
  g.arc(ex, ey, R * 1.12, 0, TAU);
  g.fill();
  g.strokeStyle = '#ffd400';
  g.lineWidth = 5;
  g.beginPath();
  for (let k = 0; k <= 5; k++) {
    const a = -Math.PI / 2 + ((k * 2) % 5) * (TAU / 5);
    if (k === 0) g.moveTo(ex + Math.cos(a) * R, ey + Math.sin(a) * R);
    else g.lineTo(ex + Math.cos(a) * R, ey + Math.sin(a) * R);
  }
  g.stroke();
  g.fillStyle = '#ff4fd8';
  g.beginPath();
  g.ellipse(ex, ey, R * 0.32, R * 0.16, 0, 0, TAU);
  g.fill();
  g.fillStyle = '#120818';
  g.beginPath();
  g.arc(ex, ey, R * 0.1, 0, TAU);
  g.fill();
  // Lettering.
  g.font = `400 ${Math.round(h * 0.13)}px "Bungee"`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = '#2a0b3a';
  g.strokeText('VEXIHERBOLOGY', w * 0.05, h * 0.47, w * 0.6);
  g.fillStyle = '#ff5ab8';
  g.fillText('VEXIHERBOLOGY', w * 0.05, h * 0.47, w * 0.6);
  // Rust and road grime at the very bottom.
  const grime = g.createLinearGradient(0, h * 0.85, 0, h);
  grime.addColorStop(0, 'rgba(60, 40, 20, 0)');
  grime.addColorStop(1, 'rgba(60, 40, 20, 0.6)');
  g.fillStyle = grime;
  g.fillRect(0, h * 0.85, w, h * 0.15);
  return c;
}
