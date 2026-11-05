import "./mobilePowers.css";
/** Touch Powers menu. Every action remains a host-validated command. */
import { ABILITY, ALIGN_COST, DRUG } from '../sim/constants';
import { CHAKRAS, DRUGS } from '../sim/types';
import type { AbilityId, ChakraId, DrugId, RitualId } from '../sim/types';
import { ABILITY_NAMES, abilityBlocker, alignBlocker } from '../sim/systems/abilities';
import { DRUG_NAMES, drugBlocker } from '../sim/systems/drugs';
import { RITUAL_NAMES, ritualBlocker } from '../sim/systems/rituals';
import type { World } from '../sim/world';
import type { Session } from '../game/session';
import type { UiHost } from './core';
import { button, el, setText, show } from './dom';

export type MobilePower = AbilityId | RitualId;
export const MOBILE_POWER_NAMES = { ...ABILITY_NAMES, ...RITUAL_NAMES };
export const DRUG_RISKS: Record<DrugId, string> = {
  saffron: '40 s: +50% movement/work and +0.3 Ritual/s. Then 20 s at −30%; 25% of Signifiers wander for 8–15 s.',
  dust: '30 s: reveals lattice and hidden information. Risk: 3–5 false Flags near your avatar or camp, rerolled every 10 s.',
  acidcop: '30 s: taps rival command meshes. Risk: your Signifiers lose attention twice as fast.',
};
export function mobilePowerBlocker(world: World, s: Session, id: MobilePower): string {
  return id === 'redtape' || id === 'patchwork' ? ritualBlocker(world, s.playerFaction, id) : abilityBlocker(world, s.playerFaction, id);
}
/** Arming never spends resources or selects a Signifier. The next field tap supplies the point. */
export function armMobilePower(world: World, s: Session, id: MobilePower): string {
  const why = mobilePowerBlocker(world, s, id); if (why) return why;
  s.mobileAbility = null; s.mobileRitual = null; s.mobileBoxSelect = false; s.recruitTargeting = false;
  s.mobileBuildFacet = -1; s.mobileBuildConfirm = false; s.tool = 'flag'; s.planPreview = [];
  if (id === 'redtape' || id === 'patchwork') s.mobileRitual = id; else s.mobileAbility = id;
  s.mobileMenu = null; s.mobileCancelSerial++; return '';
}
export class MobilePowers {
  private cards = new Map<MobilePower, { root: HTMLElement; button: HTMLButtonElement; detail: HTMLElement }>();
  private alignments = new Map<ChakraId, HTMLButtonElement>();
  private drugs = new Map<DrugId, HTMLButtonElement>();
  private progress: HTMLElement;
  constructor(private host: UiHost, root: HTMLElement) {
    const s = host.app.session;
    el('p', 'mc-hint', root, 'Choose a power, then tap anywhere on the field. No selected Signifier needed. Drag to pan; Cancel abandons targeting.');
    for (const id of Object.keys(MOBILE_POWER_NAMES) as MobilePower[]) {
      const card = el('section', 'mc-power-card', root);
      const b = button('btn', card, MOBILE_POWER_NAMES[id], () => {
        const w = host.app.world; if (!w) return;
        const why = armMobilePower(w, s, id); if (why) host.blocked(why);
      });
      b.dataset.power = id;
      this.cards.set(id, { root: card, button: b, detail: el('p', 'mc-hint', card) });
    }
    el('h3', '', root, 'Chakra alignment');
    this.progress = el('p', 'mc-hint', root); this.progress.setAttribute('role', 'status');
    for (const chakra of CHAKRAS) {
      const b = button('btn', root, chakra, () => {
        const w = host.app.world; if (!w) return;
        const why = alignBlocker(w, s.playerFaction, chakra); if (why) { host.blocked(why); return; }
        host.app.submit({ t: 'align', faction: s.playerFaction, chakra });
      });
      b.dataset.align = chakra; this.alignments.set(chakra, b);
    }
    el('h3', '', root, 'Drugs');
    el('p', 'mc-hint', root, 'One dose per use. Drug Labs brew each dose for 25 Lumber in 22 s.');
    for (const drug of DRUGS) {
      const card = el('section', 'mc-power-card', root);
      const b = button('btn', card, DRUG_NAMES[drug], () => {
        const w = host.app.world; if (!w) return;
        const why = drugBlocker(w, s.playerFaction, drug); if (why) { host.blocked(why); return; }
        host.app.submit({ t: 'drug', faction: s.playerFaction, drug });
      });
      b.dataset.useDrug = drug; this.drugs.set(drug, b);
      el('p', 'mc-hint', card, DRUG_RISKS[drug]);
    }
  }
  update(world: World): void {
    const s = this.host.app.session, f = world.factions[s.playerFaction], degen = f.controlMode === 'rts';
    for (const [id, card] of this.cards) {
      const rite = id === 'redtape' || id === 'patchwork';
      show(card.root, rite ? degen : !degen || id === 'omega' || id === 'stabilize');
      const why = mobilePowerBlocker(world, s, id);
      card.button.disabled = !!why; card.button.title = why || 'Choose, then tap a field target.';
      card.button.setAttribute('aria-disabled', String(!!why));
      let detail = '';
      if (id === 'redtape') detail = '15 Ritual · 45 s cooldown · 14 m radius. 1 s warning, then 12 s of −25% rival Signifier movement. No damage or work slowdown.';
      else if (id === 'patchwork') detail = '20 Ritual · 60 s cooldown · 16 m radius · 15 s. Repairs up to 4 nearest standing own structures at 8 HP/s after 3 s without damage. Excludes Altars and Command Centers.';
      else if (id === 'omega') detail = `${ABILITY.omega.radius[Math.max(0, f.chakras.finial - 1)]} m radius · 75 s cooldown. ${degen ? '2 s warning at your tapped point; Altar damage interrupts. ' : 'Centered on your avatar. '}40 damage and knockback; loosens rival Flags. Level 3 plants up to 6 actual carried friendly Flags${degen ? ' from Signifiers in the circle' : ''}.`;
      else if (id === 'stabilize') detail = `${ABILITY.stabilize.radius[Math.max(0, f.chakras.canton - 1)]} m radius · 20 s · 35 s cooldown.${degen ? '' : ' Target within 60 m of your avatar.'} Stabilizes the lattice; level 3 protects your Flags from pulling and Omega.`;
      else detail = `${ABILITY_NAMES[id]} · ${ABILITY[id].cooldown} s cooldown.`;
      setText(card.detail, `${detail}${why ? ` ${why}` : ''}`);
    }
    const pending = [...world.zones.values()].find(z => z.kind === 'alignment' && z.faction === s.playerFaction);
    setText(this.progress, pending ? `Aligning ${CHAKRAS[pending.level - 1]}: ${Math.max(0, Math.ceil(pending.until - world.time))} s. Altar damage interrupts; Ritual is spent on completion.` : 'Each upgrade takes 4 s and costs 30 / 70 / 130 Ritual.');
    for (const [chakra, b] of this.alignments) {
      show(b, !degen || chakra === 'canton' || chakra === 'finial');
      const why = alignBlocker(world, s.playerFaction, chakra), level = f.chakras[chakra];
      b.disabled = !!why; b.title = why || 'Begin alignment'; b.setAttribute('aria-disabled', String(!!why));
      setText(b, `${chakra[0].toUpperCase() + chakra.slice(1)} ${level}/3${level < 3 ? ` · ${ALIGN_COST[level]} Ritual` : ''}`);
    }
    for (const [drug, b] of this.drugs) {
      const remaining = Math.max(0, Math.ceil(f.drugActive[drug] - world.time)), why = drugBlocker(world, s.playerFaction, drug);
      b.disabled = !!why; b.title = why || `Use one dose for ${DRUG.duration[drug]} s`; b.setAttribute('aria-disabled', String(!!why));
      setText(b, `${DRUG_NAMES[drug]} · ${f.drugs[drug]} doses${remaining ? ` · ${remaining} s active` : drug === 'saffron' && f.saffronCrashUntil > world.time ? ` · ${Math.ceil(f.saffronCrashUntil - world.time)} s crash` : ''}`);
    }
  }
}
