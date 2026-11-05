# Mobile camp controls

- In RTS mode, tap your Command Center, then tap the ground to move it without a worker. Cart movement respects physical obstacles and stops if blocked. Orders → Hold position stops the selected cart or avatar.
- In Avatar mode, tap your character, then tap the ground to walk. Tap a nearby free node to plant, a loose/enemy flag to pull, a neutral Signifier to recruit, or a nearby rival/lumber pile to swing. Distant targets first become walking destinations; tap again when in range.
- Switch between Avatar and RTS in the menu. The camp, units, flags and buildings are retained. Removed Hoist, Fly and Field upgrades refund their actual paid Ritual once. Canton/Stabilize and Finial/Omega stay unlocked. Pending casts and dialogue are cancelled; committed card-game wagers are not refunded.
- A late online spectator or an eliminated player can choose an available NPC camp. Disconnected players retain their reserved seats. The host resolves concurrent claims and resets input ownership before the new player gains control.

`web/scripts/mobile-camp-native.cjs` exports reusable browser checks for touch movement, mode/refund transitions and local elimination takeover. These are browser-emulated touch checks, not physical-device performance tests. Real socket claim races, stale input rejection and reconnects are covered by `web/server/bossTakeover.test.ts` and `web/server/rtsMode.test.ts`.
