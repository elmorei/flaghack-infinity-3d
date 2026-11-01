import {describe, expect, it} from 'vitest';
import type {World} from '../sim/world';
import type {FrickFrackCard} from '../sim/frickFrack';
import {droppedCardPrompt, nearbyPickupTag} from './cardPickup';
import {Picker} from './picking';
import {FRICK_FRACK_SIDEBOARD_CAP} from '../sim/frickFrack';

function fixture() {
  const av = {pos: {x: 0, y: 7, z: 0}, koUntil: 0};
  const card: FrickFrackCard = {id: 90, rank: 12, suit: 2};
  const drop = {id: 90, card, pos: {x: 2, z: 0}, createdAt: 0};
  const world = {time: 0, factions: [{controlMode: 'avatar'}], avatarOf: () => av, collision: {groundHeight: () => 7},
    frickFrack: {drops: [drop], sideboards: {0: []}},
    flags: new Map(), hippies: new Map(), avatars: new Map(), buildings: new Map(), piles: new Map(), beacons: new Map(), pieces: new Map(),
  } as unknown as World;
  return {world, av, card, drop};
}

describe('dropped-card tags', () => {
  it('uses the actual card name and auto-pickup instruction without implying an E action', () => {
    const {world} = fixture(); const before = JSON.stringify(world.frickFrack);
    expect(droppedCardPrompt(world, 0, -1)).toBe('Queen of Diamonds · Walk over to collect');
    expect(JSON.stringify(world.frickFrack)).toBe(before);
  });
  it.each([
    [{id: 90, rank: 0, suit: 0, arcana: 0}, 'The Fool'],
    [{id: 90, rank: 14, suit: 3, tarot: true}, 'King of Wands'],
    [{id: 90, rank: 1, suit: 0, parody: 0}, '']
  ] as [FrickFrackCard, string][])('keeps specialty card identity in its pickup tag', (card, name) => {
    const {world, drop} = fixture(); drop.card = card;
    const prompt = droppedCardPrompt(world, 0, 90)!;
    if (name) expect(prompt).toContain(name);
    else expect(prompt).not.toContain('Ace of Spades');
    expect(prompt).not.toContain('?');
  });
  it('reports a full sleeve instead of promising pickup', () => {
    const {world, card} = fixture(); world.frickFrack.sideboards[0] = Array(FRICK_FRACK_SIDEBOARD_CAP).fill(card);
    expect(droppedCardPrompt(world, 0, 90)).toBe('Queen of Diamonds · Sleeve full');
  });
  it('disappears after pickup and does not point through another terrain level', () => {
    const {world, av} = fixture(); av.pos.y = 15;
    expect(droppedCardPrompt(world, 0, 90)).toBeNull(); av.pos.y = 7;
    world.frickFrack.drops.length = 0; expect(droppedCardPrompt(world, 0, 90)).toBeNull();
  });
  it('hides when KO or out of range, and prioritizes a nearby hovered card', () => {
    const {world, av, drop} = fixture(); av.koUntil = 2;
    expect(droppedCardPrompt(world, 0, 90)).toBeNull(); av.koUntil = 0;
    drop.pos.x = 4; expect(droppedCardPrompt(world, 0, 90)).toBeNull(); drop.pos.x = 2;
    world.frickFrack.drops.push({...drop, id: 91, card: {id: 91, rank: 1, suit: 0}, pos: {x: 2.5, z: 0}});
    expect(droppedCardPrompt(world, 0, 91)).toContain('Ace of Spades');
    expect(droppedCardPrompt(world, 0, -1)).toContain('Queen of Diamonds');
  });
  it('uses one bounded informational mobile tag for both pickups and never offers a Degen action', () => {
    const {world} = fixture(); world.beacons.set(91, {id:91,type:'beacon',faction:1,pos:{x:1,z:1},until:30});
    expect(nearbyPickupTag(world,0,90)).toContain('Queen of Diamonds');
    expect(nearbyPickupTag(world,0,90)).toContain('D.E.G.E.N. Beacon');
    world.factions[0].controlMode='rts'; expect(nearbyPickupTag(world,0,90)).toBeNull();
  });
  it('picks a grounded card using the same ray extent as a beacon', () => {
    const {world} = fixture(), picker = new Picker();
    expect(picker.entityAlong(world, 0, 2, 15, 0, 0, -1, 0, 8, 0, false)).toBe(90);
    world.frickFrack.drops.length = 0;
    world.beacons.set(91, {id: 91, faction: 1, pos: {x: 2, z: 0}, until: 20, type: 'beacon'});
    expect(picker.entityAlong(world, 0, 2, 15, 0, 0, -1, 0, 8, 0, false)).toBe(91);
  });
});
