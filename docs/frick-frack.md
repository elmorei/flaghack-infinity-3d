# Frick-frack

Frick-frack is a Regular-playstyle diversion using only in-match Flags. It has no purchases, real-money bets, or cash-out.

Find the unique wizard hippie and give him a Flag. He appears in standard matches with a human Regular player and at least two neutral hippies, so he never takes the last recruit needed for recovery. The Flag is not an admission fee: it remains available for betting. His three-part, letter-by-letter introduction ends with a choice to play or decline. The burn continues while talking or playing, and the avatar cannot move or issue ordinary commands from the table. Knockout, elimination, match end, or disconnect closes the session safely.

Throwing a Flag to the wizard gets his attention: he pursues its giver through the field before starting the conversation at close range. The player remains free to move during pursuit. Conversation uses a locked, rotated camera showing both characters above a lower dialogue panel. Only accepting the invitation opens the full-screen card table; declining or leaving restores the normal camera and controls.

If either actor is knocked far away or launched out of conversational reach, the encounter ends rather than leaving the player trapped in the camera scene. Only an already committed wager is forfeited. Pending pursuits expire after two minutes if the wizard cannot reach the player.

## Table rules

- Target 21; aces count as 1 or 11, faces as 10.
- Each shuffled hand uses 136 cards: the full 52-card playing deck, all 56 Rider–Waite–Smith Minor Arcana, and 28 original parody cards (four families, each valued 1–7). Tarot aces count as 1 or 11, numbered cards retain their number, and Page, Knight, Queen and King each count as 10. Major Arcana are excluded from the draw deck and available only as one-use sideboard effects. Card identity and the displayed blackjack value are preserved across draws and network snapshots.
- Choose a whole-Flag wager up to the Flags currently held. Altar stock is not automatically withdrawn.
- Hit or stand. The wizard stands on all 17s, including soft 17.
- All wins pay 1:1, including two-card blackjack. Equal results push and return the wager.
- Play as many hands as desired, or leave before betting. Exiting an unfinished hand forfeits the committed wager.
- Winnings fill the quiver; surplus goes to an owned altar's stock. If no altar exists, surplus remains as real loose Flags rather than disappearing.
- With no Flags left to bet, the wizard asks the player to return later.

The suggested dice-selected target is not part of this release.

## Cards up your sleeve

A hippie knockdown has a 3.5% chance to leave a card. A nearby Regular avatar picks it up automatically, up to 12 sideboard cards. Numeric sideboard cards are known, one-use substitutes for a random Hit. Major Arcana instead apply their named effect without adding a numeric card to the hand. Playing it consumes it immediately. Numeric cards are separate from the Flag wager and can still bust the hand. World drops expire after ten minutes; there are at most 128 at once.

## Authority and conservation

Sessions and card inventories belong to the authoritative simulation. Every action carries a session ID and revision; stale or duplicate actions cannot settle a hand twice. Dealer hole cards and shoe order stay in host-private state. Online hosts use private shuffle entropy rather than the public map seed. Committed wagers are an explicit Flag sink and payouts an explicit casino source; moving between quiver and altar never duplicates Flags.

Protocol 20 requires matching browser and host builds. Degen/Plan mobile controls are unchanged.

## Public CCG battles

Mana Misfits, Pocket Problems, Duel Nonsense, and Bench Legends are CCG cards. Bench Legends use jersey numbers 1–7 as their blackjack/combat value. Whenever a CCG becomes publicly visible, it fights existing visible opposing CCG cards in reveal order. Friendly cards never fight one another. The lower current value is removed from its hand; equal values remove both and stop the chain. Removed cards never return to the shoe. Recompute totals after battles, before bust checks or settlement. Ordinary cards and tarot do not fight. A private peek does not reveal a card publicly or trigger combat; The Sun does.

## Major Arcana effects

All effects require an active unresolved hand. Invalid choices leave the card unconsumed. Selection and paid effects require explicit confirmation. Value overrides are fixed numbers, so an overridden 1 is not a flexible ace.

| Card | One-use effect |
| --- | --- |
| Fool | Replace your latest card with the next draw. |
| Magician | Draw a card and assign a fixed value from 1 to 7. |
| High Priestess | Privately peek at the dealer hole card for three seconds. |
| Empress | Gain a temporary value-3 numeric cheat for this hand. |
| Emperor | Set a selected own card to exactly 4. |
| Hierophant | Learn whether the dealer's current hand is soft. |
| Lovers / Chariot | Draw two, choose one, discard the other. |
| Strength | Discard the next new card that would still bust you after its CCG battle. |
| Hermit | Privately peek at the next three draws for five seconds without reordering. |
| Wheel of Fortune | Reroll your latest card to a fixed value from 1 to 10. |
| Justice | A tied result wins rather than pushes. |
| Hanged Man | Remove a selected own card and immediately stand. |
| Death | Replace your whole hand with two fresh cards at the same wager. |
| Temperance | Set two distinct selected own cards to 5 each. |
| Devil | Explicitly pay an extra stake to double the wager and replace one selected card. |
| Tower | Remove the highest-value card from each hand (host evaluates hidden cards). |
| Star | Recover your latest used numeric cheat temporarily, once per hand; never recover an Arcana. |
| Moon | Replace the hidden dealer card without revealing either card. |
| Sun | Permanently reveal the dealer hole card, including any resulting CCG battle. |
| Judgement | Arm before losing: replay once using the already committed wager rather than settling the loss. |
| World | A win on exactly 21 earns an extra stake: profit 2:1 instead of 1:1. |

Temporary cheats disappear at settlement or session close. Star and Judgement cannot loop. Private information is sent only to the owning faction, expires, and is cleared on reconnect/session change; neither deck order nor private peeks enter public world snapshots.

## End-of-hand poker prizes

Poker is evaluated only once the final blackjack result is settled, never during drawing, never on an exited hand, and never before a Judgement replay. A blackjack bust earns no poker prizes. On a win, the strongest matching-rank group multiplies the base profit: pair ×2, three of a kind ×3, four or more ×4. These multipliers do not stack and do not multiply the returned stake. The World's extra stake is additive. A push has no win profit to multiply.

A five-card straight awards a fresh copy of its highest printed card to the sleeve, even on a blackjack loss or push if the player did not bust; the resolved hand is not changed. Poker uses printed rank, ignoring temporary numeric value overrides. Ordinary Jack and tarot Page match, as do Queens and Kings. Tarot Knight is its own matching-rank group but cannot fill a straight. Standard A-2-3-4-5 and 10-J-Q-K-A straights are supported, without wraparound. CCG printed values 1–7 match those numeric poker ranks (1 is a poker Ace only, never a flexible blackjack 11). Among larger hands, use the highest qualifying five-rank straight. Only pairs, trips, four-of-a-kind and straight prizes are currently defined; no speculative flush rewards.
