# Frick-frack

Frick-frack is a Regular-playstyle diversion using only in-match Flags. It has no purchases, real-money bets, or cash-out.

Find the unique wizard hippie and give him a Flag. He appears in standard matches with a human Regular player and at least two neutral hippies, so he never takes the last recruit needed for recovery. The Flag is not an admission fee: it remains available for betting. His three-part, letter-by-letter introduction ends with a choice to play or decline. The burn continues while talking or playing, and the avatar cannot move or issue ordinary commands from the table. Knockout, elimination, match end, or disconnect closes the session safely.

## Table rules

- Target 21; aces count as 1 or 11, faces as 10.
- Choose a whole-Flag wager up to the Flags currently held. Altar stock is not automatically withdrawn.
- Hit or stand. The wizard stands on all 17s, including soft 17.
- All wins pay 1:1, including two-card blackjack. Equal results push and return the wager.
- Play as many hands as desired, or leave before betting. Exiting an unfinished hand forfeits the committed wager.
- Winnings fill the quiver; surplus goes to an owned altar's stock. If no altar exists, surplus remains as real loose Flags rather than disappearing.
- With no Flags left to bet, the wizard asks the player to return later.

The suggested dice-selected target is not part of this release.

## Cards up your sleeve

A hippie knockdown has a 3.5% chance to leave a card. A nearby Regular avatar picks it up automatically, up to 12 sideboard cards. A sideboard card is a known, one-use substitute for a random Hit. Playing it consumes it immediately. Cards are separate from the Flag wager and can still bust the hand. World drops expire after ten minutes; there are at most 128 at once.

## Authority and conservation

Sessions and card inventories belong to the authoritative simulation. Every action carries a session ID and revision; stale or duplicate actions cannot settle a hand twice. Dealer hole cards and shoe order stay in host-private state. Online hosts use private shuffle entropy rather than the public map seed. Committed wagers are an explicit Flag sink and payouts an explicit casino source; moving between quiver and altar never duplicates Flags.

Protocol 20 requires matching browser and host builds. Degen/Plan mobile controls are unchanged.
