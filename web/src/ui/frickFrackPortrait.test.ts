import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { frickFrackPortrait } from './frickFrackPortrait';

describe('mobile wizard dialogue portrait', () => {
  it('uses an original inline pixel wizard with separately animated face and body', () => {
    const markup = frickFrackPortrait();
    expect(markup).toContain('viewBox="0 0 64 80"');
    for (const name of ['breathe', 'blink', 'mouth', 'spark']) expect(markup).toContain(`ff-portrait-${name}`);
    expect(markup).not.toMatch(/https?:|<script|<image/);
  });
  it('keeps the portrait mobile-only and honors reduced motion', () => {
    const css = readFileSync(new URL('./frickFrack.css', import.meta.url), 'utf8');
    expect(css).toContain('.ff-wizard-portrait { display: none; }');
    expect(css).toContain("html[data-device-layout='mobile'] .ff-in-world .ff-wizard-portrait");
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.ff-speaking .ff-portrait-mouth');
  });
});
