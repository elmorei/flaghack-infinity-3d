import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const name = 'FLAGHACK∞3D';

describe('player-facing product branding', () => {
  it('uses the exact product name in browser and startup labels', () => {
    const html = read('../../index.html');
    expect(html).toContain(`<title>${name}</title>`);
    expect(html).toContain(`class="startup-brand">${name}</div>`);
    expect(html).toContain(`aria-label="${name} startup"`);
  });

  it('names the title artwork and game references consistently', () => {
    expect(read('./title.ts')).toContain(`wordmark.alt = '${name} — SURVEY FLAGS'`);
    for (const path of ['./title.ts', './lore.ts']) {
      expect(read(path)).toContain(`claims to be ${name}.`);
    }
    expect(read('../game/app.ts')).toContain(`Open ${name} in a web browser`);
    expect(read('../net/endpoint.ts')).toContain(`${name} host information`);
    expect(read('../../server/cli.ts')).toContain(`Host a ${name} multiplayer burn`);
  });

  it('also names the unused Godot prototype consistently', () => {
    const project = read('../../../project.godot');
    expect(project).toContain(`config/name="${name}"`);
    expect(read('../../../scenes/main/main.gd')).toContain(`title_label.text = "${name}"`);
  });
});
