import { describe, expect, it } from 'vitest';
import { applyPageBranding, gameDisplayName } from './branding';
import { deviceLayout } from './device';

describe('edition display names', () => {
  it('keeps desktop as the fallback and uses exact mobile capitalization', () => {
    expect(gameDisplayName(undefined)).toBe('FLAGHACK∞3D');
    expect(gameDisplayName('desktop')).toBe('FLAGHACK∞3D');
    expect(gameDisplayName('mobile')).toBe('Flaghack Gaiden');
  });

  it.each([
    ['iPhone', '', 'Flaghack Gaiden'],
    ['Android', '', 'Flaghack Gaiden'],
    ['Windows NT', '', 'FLAGHACK∞3D'],
    ['iPhone', '?view=desktop', 'FLAGHACK∞3D'],
    ['Windows NT', '?view=mobile', 'Flaghack Gaiden'],
  ])('follows the same device and override resolver as the game: %s %s', (userAgent, query, name) => {
    expect(gameDisplayName(deviceLayout({ url: `https://example.test/game/${query}`, userAgent }))).toBe(name);
  });

  it('updates tab, startup, accessible label and home-screen metadata together, including repeated application', () => {
    const node = () => ({ textContent: '', attrs: new Map(), setAttribute(key: string, value: string) { this.attrs.set(key, value); } });
    const label = node(), overlay = node(), application = node(), apple = node();
    const page = { title: '', querySelectorAll: (selector: string) => selector === '[data-game-name]' ? [label]
      : selector === '#startup' ? [overlay] : [application, apple] };
    for (const layout of ['mobile', 'mobile', 'desktop'] as const) {
      applyPageBranding(layout, page as unknown as Document);
      const name = gameDisplayName(layout);
      expect(page.title).toBe(name);
      expect(label.textContent).toBe(name);
      expect(overlay.attrs.get('aria-label')).toBe(`${name} startup`);
      expect(application.attrs.get('content')).toBe(name);
      expect(apple.attrs.get('content')).toBe(name);
    }
  });
});
