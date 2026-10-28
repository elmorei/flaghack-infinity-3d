# Captured scenery benefits

Captured scenery supports existing workers and logistics. It never spawns Signifiers or creates free flags. Only living owners of intact, claimed structures receive benefits. Enemy containment, contesting, and overwrite pause benefits; a threatened marker alone does not. Ordinary capture and destruction remove or transfer benefits without converting nearby people.

## Starting tuning

- Tent lodging: dome tents add 2 soft attention-cap places; bell/cabin tents add 3. Maximum +12 scenery lodging per faction. Losing lodging returns workers to normal excess-population attention decay, not deletion.
- Dome recovery: 3 HP/second for up to 4 stationary patients, after 5 seconds without damage. No resurrection or healing while fighting/moving.
- Shade rest: 4 attention/second while resting at a service point, up to 4 simultaneous users. Above-cap workers still suffer normal attention loss and cannot use rest to cancel it.
- Porta relief: a completed 3-second visit restores 20 attention. One user per unit; a 45-second personal cooldown applies across all toilets.
- Art inspiration: staffed, working owned drum circles within 25 metres produce 25% more ritual. Overlapping installations do not stack; no unattended income or extra recruitment.
- Vehicle depots: sedan/van/bus hold 3/6/10 actual flags. Workers can fetch or return flags and deliver collected lumber here; avatar proximity restocks and friendly thrown flags can be deposited. No free inventory, extra hoard allowance, driving, or synthetic buildings.

## Services and lifecycle

Services use walkable exterior points because map structures have solid interiors. NPCs use ordinary navigation, interruptible first-come queues and bounded reservations. Direct orders, injury, combat, KO, conversion, capture, destruction or inaccessible routes release service reservations. Units keep their ordinary jobs. Idle treatment never overrides an explicit order or makes an invulnerable aura. During the boss alliance, recovery/rest may serve surviving allied workers; capacity, ritual and supply stock remain faction-owned.

Flag stock is represented by the existing real flag entities. Depot holder IDs use `-2 - sceneryId`; `-1` remains the unheld sentinel. Recapture transfers the actual inventory, paused capture retains stock but denies access, and destruction/elimination releases stock once onto the ground. Lumber deliveries credit the existing faction lumber resource exactly once, just as Hearth delivery does. Hoarding counts depot stock.

Command centers, stages, effigy, trees and rocks remain outside capturable benefit roles. Modular pieces retain ownership permissions only. Services do not change collision or turn scenery into traversable interiors.

The context card under the cursor/crosshair shows role, ownership, paused state, occupied slots/queue or flag inventory. Public service reservation phases and depot flag holders replicate to live clients and late joiners. Protocol 17 requires matching host and client versions.

All values are starting balance settings, not a claim of cross-device performance or final competitive balance.
