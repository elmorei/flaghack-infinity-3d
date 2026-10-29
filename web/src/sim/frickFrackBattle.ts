import type { FrickFrackCard } from './frickFrack';

type CombatCard = FrickFrackCard & { value?: number };
export interface FrickFrackBattleResult { removedIds: number[]; remark: string }

/** Resolve only a newly PUBLICLY revealed CCG. Caller must omit the dealer hole card.
 * Arrays are the authoritative visible hands; order is the server's reveal order.
 * No draw, render, or private peek may call this twice for the same reveal event.
 */
export function resolveFrickFrackBattle(player: CombatCard[], dealerVisible: CombatCard[], newCardId: number, exposedOrder: readonly number[] = []): FrickFrackBattleResult {
  const visible = [...player, ...dealerVisible];
  const incoming = visible.find(card => card.id === newCardId);
  if (!incoming || incoming.parody === undefined) return { removedIds: [], remark: '' };
  const order = new Map(exposedOrder.map((id, index) => [id, index]));
  const opponents = player.some(card => card.id === newCardId) ? dealerVisible : player;
  const others = opponents.filter(card => card.parody !== undefined)
    .sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const removedIds: number[] = [], remarks: string[] = [];
  const value = (card: CombatCard) => card.value ?? card.rank;
  const remove = (id: number) => {
    for (const hand of [player, dealerVisible]) {
      const index = hand.findIndex(card => card.id === id);
      if (index >= 0) hand.splice(index, 1);
    }
    if (!removedIds.includes(id)) removedIds.push(id);
  };
  for (const defender of others) {
    const attack = value(incoming), defense = value(defender);
    if (attack === defense) {
      remove(incoming.id); remove(defender.id);
      remarks.push(`A ${attack} against a ${defense}: both cards perish.`);
      break;
    }
    if (attack < defense) {
      remove(incoming.id);
      remarks.push(`The ${defense} defeats the ${attack}. Remove the weaker card.`);
      break;
    }
    remove(defender.id);
    remarks.push(`The ${attack} defeats the ${defense}. Remove the weaker card.`);
  }
  return { removedIds, remark: remarks.join(' ') };
}
