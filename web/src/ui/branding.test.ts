import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const name = 'FLAGHACK∞3D';

describe('player-facing product branding', () => {
  it('uses the exact product name in browser and startup labels', () => {
    const html = read('../../index.html');
    expect(html).toContain(`<title>${name}</title>`);
    expect(html).toContain(`class="startup-brand" data-game-name>${name}</div>`);
    expect(html).toContain(`aria-label="${name} startup"`);
  });

  it('names the title artwork and game references consistently', () => {
    expect(read('./title.ts')).toContain('wordmark.alt = `${gameName} — SURVEY FLAGS`');
    expect(read('./title.ts')).toContain('claims to be ${gameName}.');
    expect(read('./lore.ts')).toContain(`claims to be ${name}.`);
    expect(read('../game/app.ts')).toContain(`Open ${name} in a web browser`);
    expect(read('../net/endpoint.ts')).toContain(`${name} host information`);
    expect(read('../../server/cli.ts')).toContain(`Host a ${name} multiplayer burn`);
  });

  it('keeps the static HTML a desktop fallback, with no invented PWA identity', () => {
    const html = read('../../index.html');
    expect(html).toContain(`<meta name="application-name" content="${name}" />`);
    expect(html).toContain(`<meta name="apple-mobile-web-app-title" content="${name}" />`);
    expect(html).not.toMatch(/rel=["']manifest["']/);
  });

  it('also names the unused Godot prototype consistently', () => {
    const project = read('../../../project.godot');
    expect(project).toContain(`config/name="${name}"`);
    expect(read('../../../scenes/main/main.gd')).toContain(`title_label.text = "${name}"`);
  });
});
