import { describe, expect, it } from 'vitest';
import wordmark from './assets/title-wordmark.svg?raw';

describe('title wordmark asset', () => {
  it('keeps the title, infinity and subtitle as one accessible vector image', () => {
    expect(wordmark).toContain('<title id="wordmark-title">FLAGHACK∞3D — SURVEY FLAGS</title>');
    for (const id of ['title-lettering', 'infinity', 'dimension-lettering', 'subtitle-lettering']) {
      expect(wordmark).toMatch(new RegExp(`<g id="${id}"[^>]*><path d="[^"]{100,}"`));
    }
    expect(wordmark).toContain('viewBox="-72 -151 918 252"');
    expect(wordmark).toContain('width="918" height="252"');
  });

  it('does not rely on live text, font loading, raster images or external resources', () => {
    expect(wordmark).not.toMatch(/<(?:text|tspan|image|foreignObject|script|font)\b/i);
    expect(wordmark).not.toMatch(/font-family|@font-face|(?:href|src)\s*=|data:/i);
    for (const [, target] of wordmark.matchAll(/url\(([^)]+)\)/g)) {
      expect(target).toMatch(/^#[a-z-]+$/);
      expect(wordmark).toContain(`id="${target.slice(1)}"`);
    }
  });
});
