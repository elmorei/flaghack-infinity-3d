import { describe, expect, it } from 'vitest';
import { renderPrompt } from './hud';

describe('shared pickup prompt formatting', () => {
  it('renders a card tag following a beacon key/label as plain label, not a giant keycap', () => {
    const html = renderPrompt('E  Pick up D.E.G.E.N. Beacon · Convert 1–2 Signifiers   Queen of Diamonds · Walk over to collect');
    expect(html.match(/<kbd/g)).toHaveLength(1);
    expect(html).toContain('<span class="pl">Queen of Diamonds · Walk over to collect</span>');
  });
  it('keeps standalone tags escaped and preserves existing key pairs', () => {
    expect(renderPrompt('The <Sun> · Walk over to collect')).toBe('<span class="pl">The &lt;Sun&gt; · Walk over to collect</span>');
    const html = renderPrompt('LMB  Build   Hold E  Push');
    expect(html.match(/<kbd/g)).toHaveLength(2);
    expect(html).toContain('<span class="ph">Hold</span>');
  });
});
