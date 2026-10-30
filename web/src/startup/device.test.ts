import { describe, expect, it } from 'vitest';
import { deviceLayout, useMobileIntro } from './device';
const url = 'https://example.github.io/game/?host=wss%3A%2F%2Fexample.com#invite';
describe('device presentation routing', () => {
  it.each(['Android', 'iPhone', 'iPad', 'iPod'])('uses mobile for %s without depending on orientation', userAgent => {
    expect(deviceLayout({ url, userAgent, width: 900, height: 400 })).toBe('mobile');
  });
  it('recognizes iPadOS desktop Safari', () => {
    expect(deviceLayout({ url, userAgent: 'Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 5 })).toBe('mobile');
  });
  it('uses the mobile client hint', () => expect(deviceLayout({ url, mobileHint: true })).toBe('mobile'));
  it('does not misroute narrow touch Windows or Linux desktops', () => {
    for (const userAgent of ['Windows NT', 'X11; Linux', 'CrOS', 'Macintosh']) {
      expect(deviceLayout({ url, userAgent, width: 390, height: 844, maxTouchPoints: 10, coarsePointer: true })).toBe('desktop');
    }
  });
  it('supports an unknown small touch device but not mere narrow desktop width', () => {
    expect(deviceLayout({ url, width: 390, height: 844, maxTouchPoints: 1, coarsePointer: true })).toBe('mobile');
    expect(deviceLayout({ url, width: 390, height: 844 })).toBe('desktop');
  });
  it('allows both explicit versions without consuming invitation parameters', () => {
    expect(deviceLayout({ url: url.replace('?', '?view=desktop&'), userAgent: 'Android' })).toBe('desktop');
    expect(deviceLayout({ url: url.replace('?', '?view=mobile&'), userAgent: 'Windows NT' })).toBe('mobile');
    expect(url).toContain('#invite');
  });
  it('ignores invalid overrides and malformed URLs safely', () => {
    expect(deviceLayout({ url: '?view=bogus', userAgent: 'iPhone' })).toBe('mobile');
  });
  it('uses the square intro for every mobile visit', () => {
    expect(useMobileIntro('mobile')).toBe(true);
    expect(useMobileIntro('desktop')).toBe(false);
  });
});
