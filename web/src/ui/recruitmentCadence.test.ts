import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILD_INFO } from './catalog';
import { CODEX_CAMP } from './lore';

describe('player-facing recruitment cadence', () => {
  it('documents five-second Workshops and fourteen-second Drum Circles', () => {
    expect(BUILD_INFO.workshop.effect).toContain('Recruits a nearby neutral every 5 s within 15 m');
    expect(BUILD_INFO.drumcircle.effect).toContain('Recruits a nearby neutral every 14 s within 15 m');
    const lore = JSON.stringify(CODEX_CAMP);
    expect(lore).toContain('Recruits a nearby neutral every 5 s within 15 m');
    expect(lore).toContain('Automatically recruits one existing neutral within 15 m every 14 s');
    expect(lore).toContain('**Recruitment**: automatically recruits one existing neutral within 15 m every 5 s');
  });

  it('uses the Command Center interval in the shared desktop/mobile status panel', () => {
    const command = readFileSync(new URL('./command.ts', import.meta.url), 'utf8');
    expect(command).toContain('Recruits nearby neutrals (${RECRUIT_RADIUS} m / ${GCC_RECRUIT_INTERVAL} s)');
  });
});
