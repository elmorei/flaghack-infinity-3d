import { normalizeMatch } from "../sim/matchSettings";
import { normalizeControls } from "../game/bindings";
import { controlSettings } from "./controlSettings";
/**
 * Settings panel (session.panels.settings; from title or pause): master/music/sfx volume,
 * mouse sensitivity, invert Y, render quality, FPS overlay. Values write straight into
 * session.settings (audio/controls/renderer read them live) and persist in localStorage.
 */
import type { Settings } from '../game/session';
import type { World } from '../sim/world';
import { DIFFICULTIES } from './catalog';
import type { UiHost, UiPart } from './core';
import { button, el, setClass, setText, show } from './dom';
import { iconSvg } from './icons';

const STORAGE_KEY = 'fh.settings.v1';
const QUALITIES: readonly Settings['quality'][] = ['low', 'medium', 'high'];

type RangeKey = 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'mouseSensitivity';

interface RangeDef {
  key: RangeKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}

const RANGES: readonly RangeDef[] = [
  { key: 'masterVolume', label: 'Master volume', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'musicVolume', label: 'Music', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'sfxVolume', label: 'Effects', min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
  { key: 'mouseSensitivity', label: 'Mouse sensitivity', min: 0.2, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×` },
];

/** Restore persisted settings, ignoring anything malformed (old versions, hand edits). */
export function loadSettings(target: Settings): void {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return;
  }
  if (typeof raw !== 'object' || raw === null) return;
  const src: Record<string, unknown> = { ...raw };
  target.match = normalizeMatch(src.match as never);
  target.controls = normalizeControls(src.controls);
  for (const r of RANGES) {
    const v = src[r.key];
    if (typeof v === 'number' && Number.isFinite(v)) target[r.key] = Math.min(r.max, Math.max(r.min, v));
  }
  if (typeof src.invertY === 'boolean') target.invertY = src.invertY;
  if (typeof src.showFps === 'boolean') target.showFps = src.showFps;
  const q = QUALITIES.find((x) => x === src.quality);
  if (q) target.quality = q;
  const d = DIFFICULTIES.find((x) => x === src.difficulty);
  if (d) target.difficulty = d;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Private mode / quota: settings still apply for this session.
  }
}

interface RangeRow {
  def: RangeDef;
  input: HTMLInputElement;
  val: HTMLElement;
}

export class SettingsPanel implements UiPart {
  private host: UiHost;
  private root: HTMLElement;
  private ranges: RangeRow[] = [];
  private invert: HTMLButtonElement;
  private fps: HTMLButtonElement;
  private quality = new Map<Settings['quality'], HTMLButtonElement>();
  private lastSaved = '';

  constructor(host: UiHost, parent: HTMLElement) {
    this.host = host;
    loadSettings(host.app.session.settings);
    this.lastSaved = JSON.stringify(host.app.session.settings);
    this.root = el('div', 'modal settings ix is-off', parent);
    const box = el('div', 'modal-box frame settings-box', this.root);
    const head = el('div', 'modal-head', box);
    el('h2', '', head, 'Settings');
    button('panel-x', head, iconSvg('close'), () => this.close(), 'back');
    const grid = el('div', 'set-grid', box);

    for (const def of RANGES) {
      el('label', 'set-l', grid, def.label);
      const input = el('input', 'range', grid);
      input.type = 'range';
      input.min = String(def.min);
      input.max = String(def.max);
      input.step = String(def.step);
      const val = el('span', 'set-v num', grid, '');
      input.addEventListener('input', () => {
        this.host.app.session.settings[def.key] = Number(input.value);
        this.persist();
      });
      this.ranges.push({ def, input, val });
    }

    el('label', 'set-l', grid, 'Invert Y');
    this.invert = button(
      'toggle',
      grid,
      '',
      () => {
        const st = this.host.app.session.settings;
        st.invertY = !st.invertY;
        this.persist();
      },
      'toggle',
    );
    el('span', 'set-v', grid, '');

    el('label', 'set-l', grid, 'Quality');
    const seg = el('div', 'seg', grid);
    for (const q of QUALITIES) {
      this.quality.set(
        q,
        button(
          'seg-btn',
          seg,
          q[0].toUpperCase() + q.slice(1),
          () => {
            this.host.app.session.settings.quality = q;
            this.persist();
          },
          'pick',
        ),
      );
    }
    el('span', 'set-v', grid, '');

    el('label', 'set-l', grid, 'Show FPS');
    this.fps = button(
      'toggle',
      grid,
      '',
      () => {
        const st = this.host.app.session.settings;
        st.showFps = !st.showFps;
        this.persist();
      },
      'toggle',
    );
    el('span', 'set-v', grid, '');

    controlSettings(box,host.app.session.settings,()=>this.persist());
    const foot = el('div', 'modal-foot', box);
    el('span', 'panel-hint', foot, 'Quality applies to the next Survey you begin.');
    button('btn btn-primary', foot, 'Done', () => this.close(), 'back');
  }

  private close(): void {
    this.host.app.session.panels.settings = false;
  }

  private persist(): void {
    const json = JSON.stringify(this.host.app.session.settings);
    if (json === this.lastSaved) return;
    this.lastSaved = json;
    saveSettings(this.host.app.session.settings);
  }

  update(_world: World | null, _now: number): void {
    const s = this.host.app.session;
    show(this.root, s.panels.settings);
    if (!s.panels.settings) return;
    const st = s.settings;
    for (const r of this.ranges) {
      const v = st[r.def.key];
      // Never fight the user's drag: only sync the thumb when the value changed elsewhere.
      if (document.activeElement !== r.input && Number(r.input.value) !== v) r.input.value = String(v);
      setText(r.val, r.def.format(v));
    }
    setText(this.invert, st.invertY ? 'On' : 'Off');
    setClass(this.invert, 'on', st.invertY);
    setText(this.fps, st.showFps ? 'On' : 'Off');
    setClass(this.fps, 'on', st.showFps);
    for (const [q, b] of this.quality) setClass(b, 'on', st.quality === q);
    // Difficulty is picked on the title screen but persisted with the rest.
    this.persist();
  }

  dispose(): void {
    this.root.remove();
  }
}
