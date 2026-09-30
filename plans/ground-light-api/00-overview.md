# A lit light is tied to the item that burns, and another module can carry it to the ground

## Departures

- `moveLightToGround` also checks that the actor's effect is actually gone after `deactivateLight`.
  A `preDeleteActiveEffect` hook returning `false` cancels the deletion without throwing, and the
  shape's try/catch alone would have left the flame both on the token and on the ground. Observed:
  with such a hook, `dropLightWithItem` returns null, the token stays lit, and no light is left.
- The invariant "a managed light still burns out" held only on the ticker's next tick (≤ 15 s),
  not on the `updateWorldTime` sweep. That sweep threw `id … does not exist in the
  EmbeddedCollection`: overlapping sweeps (and core's own `duration.expired` update of the same
  effect, `CONFIG.ActiveEffect.expiryAction = "update"`) delete an effect twice, and the
  throw aborts that tick before the ground lights are swept. This is older than this plan and
  happens with Token HUD lights too, so it is not fixed here. It is the only console error seen,
  and it comes from `sweepExpiredLights`, which this plan does not touch.

A non-consuming light records which Item is burning. That one fact lets the public API move the
flame to the ground together with that exact Item and hand it back with the time it has left, and
lets the module put the light out when the burning Item leaves the actor by any other route. The
first caller is `canvas-loot`, which turns a dropped or thrown Item into a Tile and gives it back
on pickup.

## Start here

- Open `scripts/api.js`, `scripts/light-manager.js` (`activateLight`, `createLightEffect`,
  `dropLight`, `pickupLight`, `placeAmbientLight`, `createAmbientLight`, `handleSocketMessage`),
  `scripts/helpers.js` (`findGroundLight`), `scripts/interactive-lights.js` (every
  `FLAGS.INTERACTIVE` read), `scripts/constants.js` (`FLAGS`) and `scripts/main.js`.
- The core APIs below were confirmed on Foundry **14.368** on 2026-09-29, by reading core source.
  If the running build differs, re-check them first.
- `git status` must be clean before the first edit.

## Why, and what was weighed

**Measured on 2026-09-29, by reading the code at `7fd42b2`:**

- The `EFFECT_LIGHT` flag records `sourceId`, never an Item id. `grep -rn "deleteItem" scripts/`
  finds 0 matches: when the burning Item is deleted, the token keeps glowing until the timer runs
  out. `canvas-loot` does this today when a player drops a lit lantern.
- The first version of this plan decided "is the leaving Item the light?" by matching name/uuid
  and counting remaining copies. That needed a per-item `matchesSource` extracted from
  `findMatchingItems`, whose two-tier rule (uuid matches win over name matches *across the whole
  inventory*) a per-item predicate cannot reproduce without changing the Token HUD's item list.
- `dropLight` deactivates the actor's light **before** placing it. When a player drops with no GM
  connected, `placeAmbientLight` returns `false` and the light is simply gone.
- `createAmbientLight` returns `true` even when a pre-hook cancels the creation.
- Core records Scene-embedded creates and deletes in the layer's undo history
  (`Scene#_preCreateDescendantDocuments`, `layer.storeHistory`) for the user who made them, when
  that user views the scene. `createEmbeddedDocuments(..., { keepId: true })` keeps a
  caller-supplied `_id`. The `deleteDocument` hook is `(document, options, userId)`.
- `canvas-loot`'s `gmDrop` creates the Tile first and then either lowers the stack's quantity
  (part of a stack leaves; the Item stays) or deletes the Item (all of it leaves).

**Decision.**

- `createLightEffect` records `itemId`: the Item that is burning, for a non-consuming,
  non-free-for-all source; `null` otherwise (a consuming source spent its item, a free-for-all
  source has none). `switchPattern` keeps it, since it rewrites the flag from the old payload.
- `dropLightWithItem(item, where)` is called **while the Item is still on its actor**. The light
  moves only when `getActiveLight(actor).itemId === item.id`. No name matching, no copy counting.
- A `deleteItem` hook puts the light out when its `itemId` leaves the actor by any other route.
  It runs only on the client that deleted the Item, which owns the actor.
- Every move to the ground (the Token HUD's too) **places first, then extinguishes**, and removes
  the placed light again if extinguishing throws. The light's `_id` is generated before creation
  and kept with `keepId`, so even a player whose placement went over the socket relay knows which
  light to remove.
- A ground light records `managedBy`. It is left out of this module's HUD pickup and its
  interactive control only while that module (or the system with that id) is active. When the
  owner is disabled it becomes an ordinary ground light again, so it can never be stranded.
- `pickupGroundLight(item, light)` accepts only a managed light, never lets the caller's actor
  lose a light already burning, and returns `{ lit, reason }` instead of notifying the GM's
  client. The caller tells its own user.

**What lost:**

- *Match the leaving Item by name/uuid and count copies* (the first version of this plan). It
  either changes `findMatchingItems` for the HUD or writes the matching rule twice, and it guesses
  at what an item id states exactly.
- *Call after the Item is gone, passing its data.* `canvas-loot`'s snapshot drops `_id`, and the
  `deleteItem` hook would already have put the light out.
- *Mark the placed light `INTERACTIVE: false`.* A stored `false` survives the owner module being
  disabled, which strands the light; deciding at read time does not.
- *Replace the actor's burning light on pickup*, as the HUD does. A consuming torch already burning
  would vanish silently. A managed light is non-consuming by construction, so leaving it unlit
  costs nothing: relighting it is free.
- *Notify from inside the API.* It runs on the GM's client inside the caller's query, so the
  player who picked the item up would never see it.
- *A player-side path through the socket relay.* The relay is fire-and-forget and cannot hand the
  created document back.
- *Support consuming sources.* Their flame is not an item.

## The shape

```js
// constants.js
export const PICKUP_REASONS = {
  INVALID: "invalid", MISSING: "missing", SOURCE_REMOVED: "sourceRemoved",
  BURNED_OUT: "burnedOut", OCCUPIED: "occupied"
};

// api.js: GM client only; anywhere else they warn and return null / { lit: false, reason: "invalid" }.
/** Call while `item` is still on its actor, before removing it. */
export async function dropLightWithItem(item, { scene, x, y, elevation = 0, levels = [], managedBy }) {}
/** `item` is already on the actor that picks the light up; `light` was placed by dropLightWithItem. */
export async function pickupGroundLight(item, light) {}  // → { lit: boolean, reason: string|null }
```

```js
// light-manager.js: the one path to the ground, shared by the HUD and the API
async function moveLightToGround(actor, sceneId, lightData) {
  if ( !(await placeAmbientLight(sceneId, lightData)) ) return false;   // nothing burned out yet
  try { await deactivateLight(actor); }
  catch(err) { await removeAmbientLight(sceneId, lightData._id); throw err; }
  return true;
}
// createAmbientLight: createEmbeddedDocuments("AmbientLight", [data], { keepId: true }); true only if created
```

```js
// helpers.js
export function isManagedElsewhere(light) {
  const owner = light.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT)?.managedBy;
  return !!owner && ((owner === game.system.id) || !!game.modules.get(owner)?.active);
}
// findGroundLight skips it; interactive-lights reads isInteractive(light) =
//   INTERACTIVE flag && !isManagedElsewhere(light), everywhere it read the flag directly.
```

`pickupGroundLight` checks, in order: `missing` (the light is already gone), `sourceRemoved`,
`burnedOut`, `occupied` (the actor has any light burning). Every check after `missing` still
removes the light from the ground, as `pickupLight` does. On success it calls
`createLightEffect(..., { stowed: !!source.coverable && light.hidden, itemId: item.id })`.

**Existing worlds.** `itemId` and `managedBy` are new optional keys. A light already burning has no
`itemId`: the API refuses to move it, and the `deleteItem` hook ignores it, so it behaves as today
until it is next lit. Ground lights without `managedBy` behave as today. There is no migration.

## Invariants

Observed in a `claude-*` world through `foundry-playwright`.

| Must hold | What falsifies it, and how it is observed |
|---|---|
| The burning Item takes its light to the ground | Light a non-consuming lantern; `dropLightWithItem(lantern, …)` returns null, or `getActive(actor)` is not null afterwards |
| Any other Item moves nothing | Same, with a rope: returns anything but null |
| Deleting the burning Item puts the light out | `lantern.delete()`: `getActive(actor)` is not null |
| Deleting another Item leaves the light | `rope.delete()`: `getActive(actor)` becomes null |
| Remaining time survives the round trip | 10-minute world-time source; advance 4, drop, advance 1, pick up: `expiresAtWorld` changed, or `duration.value` is not 300 |
| Pickup never removes a burning light | Actor lit with a torch picks up a managed lantern: the torch effect is gone, or the result is not `{ lit: false, reason: "occupied" }`, or the light is still on the map |
| A managed light is invisible to the HUD pickup and interactive control only while its owner is active | With the owner active: `findGroundLight` returns it, or a control exists. With `managedBy` naming an inactive module: `findGroundLight` doesn't return it |
| A managed light still burns out | Advance past its stamp: it survives the sweep |
| The HUD drop and pickup still work, as GM and as a player through the relay | Two clients: the player drops from the HUD and picks it back up. The light doesn't land, the token keeps glowing, or no chat card is posted |
| A player's drop with no GM connected keeps the light | Player alone, HUD drop: `getActive(actor)` becomes null |
| Neither API function works outside a GM client | Called from the player client: anything but null / `invalid`, or a document changed |
| No new console errors | `__probe.dump()` after the checks above shows an error from this module |

## The commits

1. `Tie a lit light to its item and let another module carry it to the ground`
   Body: why the light records its item instead of matching by name; the place-then-extinguish
   order and the HUD bug it fixes; why managed lights are hidden from the HUD only while their
   owner is active; why pickup refuses rather than replaces. Also updates
   `docs/register-sources-api.md` and `CHANGELOG.md` under an unreleased heading. It does not
   touch `version`.

## What this deliberately does not do

- **No player-side path** and **no consuming sources**, for the reasons under *What lost*.
- **No hooks fired for other modules.** The one known caller asks; it doesn't listen.
- **No chat output** from either API function, and none from the `deleteItem` hook: a light going
  out because its Item left is the Item's story, told by whoever moved it.
- **No undo-history handling.** The caller owns the pairing between its own documents and the
  light, so it forgets the light's history entries next to its own.
- **The HUD pickup still replaces a burning light.** There the player clicks it deliberately and
  the chat announces it.

## Collisions

- No other open plan in this repo (`ls plans/`, 2026-09-29).
- **Blocks** `canvas-loot/plans/light-sources-integration/`, which calls both functions.
