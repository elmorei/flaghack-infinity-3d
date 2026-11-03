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
      expect(readFileSync(new URL(`./assets/pixel/${name}`, import.meta.url), 'utf8')).toContain('SIL OPEN FONT LICENSE');
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
});
