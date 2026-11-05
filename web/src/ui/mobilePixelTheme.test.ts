import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const css = readFileSync(new URL('./mobilePixel.css', import.meta.url), 'utf8');
describe('mobile pixel presentation boundary', () => {
  it('scopes every style selector to explicit mobile layout, not viewport alone', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = withoutComments.split('{');
    for (const block of blocks.slice(0, -1)) {
      const selector = block.slice(block.lastIndexOf('}') + 1).trim();
      if (selector.startsWith('@')) continue;
      expect(selector, selector).toMatch(/^html\[data-device-layout='mobile'\]/);
    }
  });
  it('ships locally licensed pixel fonts instead of remote font requests', () => {
    expect(css).not.toMatch(/https?:\/\//);
    for (const name of ['vt323-latin-400-normal.woff2', 'press-start-2p-latin-400-normal.woff2']) {
      expect(statSync(new URL(`./assets/pixel/${name}`, import.meta.url)).size).toBeGreaterThan(1000);
    }
    for (const name of ['VT323-LICENSE.txt', 'PressStart2P-LICENSE.txt']) {
      const license = readFileSync(new URL(`./assets/pixel/${name}`, import.meta.url), 'utf8');
      expect(license).toContain('SIL OPEN FONT LICENSE');
      expect(readFileSync(new URL(`../../public/assets/licenses/pixel-fonts/${name}`, import.meta.url), 'utf8')).toBe(license);
    }
  });
  it('provides touch targets, focus, safe areas and bounded nonmodal dialogue', () => {
    expect(css).toContain('min-height: 44px');
    expect(css).toContain(':focus-visible');
    expect(css).toContain('env(safe-area-inset-bottom)');
    expect(css).toContain('max-height: min(300px, 44dvh)');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).not.toMatch(/(?:canvas|\.mc-bearing)[^{]*\{/);
  });
  it('bounds the original tutorial panel and enlarges its existing touch controls', () => {
    expect(css).toContain('width: min(560px, calc(100vw - 32px))');
    expect(css).toContain("html[data-device-layout='mobile'] .tb-tool");
    expect(css).toContain("html[data-device-layout='mobile'] .tb-next");
    expect(css).toContain("html[data-device-layout='mobile'] .tb-panel .tb-line");
    expect(css).toContain('flex: 0 0 44px; width: 44px; height: 44px; min-height: 44px');
  });
  it('keeps every command tab in a wrapping grid and themes the GCC title', () => {
    expect(css).toContain(".mc-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); overflow: visible;");
    expect(css).toContain(".mc-tabs { grid-template-columns: repeat(6, minmax(0, 1fr)); }");
    expect(css).toContain("html[data-device-layout='mobile'] .gb-main { font: 400 20px/1.1 var(--mp-body)");
  });
  it('keeps the card-game Flag counter on the same mobile pixel font, weight and background as gameplay', () => {
    expect(css).toContain("html[data-device-layout='mobile'] :is(.mc-status, .ff-flag-counter) .num { font-family: var(--mp-body); font-weight: 400; }");
    expect(css).toContain("html[data-device-layout='mobile'] .mc-status :is(.res, .clock, .boss-hud),\nhtml[data-device-layout='mobile'] .ff-flag-counter { background: #2a211e; }");
  });

});
