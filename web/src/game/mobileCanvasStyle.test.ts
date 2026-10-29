import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const mainCss = readFileSync(new URL('../styles/main.css', import.meta.url), 'utf8');

describe('mobile field browser gestures', () => {
  it('disables browser pan and pinch on the mobile canvas before pointerdown', () => {
    const rule = mainCss.match(/html\[data-device-layout='mobile'\] canvas#game\s*\{([^}]+)\}/);
    expect(rule?.[1]).toMatch(/touch-action:\s*none\s*;/);
  });

  it('does not disable native gestures for desktop or the scrollable UI', () => {
    const gestureRules = [...mainCss.matchAll(/([^{}]+)\{([^{}]*touch-action:\s*none\s*;[^{}]*)\}/g)];
    expect(gestureRules.map((rule) => rule[1].replace(/\/\*[\s\S]*?\*\//g, '').trim()))
      .toEqual(["html[data-device-layout='mobile'] canvas#game"]);
  });
});
