# Another module can put a lit light source on the ground and give it back

The public API gains two functions. With them, a module that moves Items between actors and the
map can carry a lit light along, keeping its remaining burn time. The first caller is
`canvas-loot`, which turns a dropped or thrown Item into a Tile and gives it back on pickup. A
lantern that is thrown should keep lighting the spot where it lands.

## Start here

- Open `scripts/api.js`, `scripts/light-manager.js` (`dropLight`, `pickupLight`,
  `createLightEffect`, `placeAmbientLight`, `sweepExpiredLights`), `scripts/helpers.js`
  (`findMatchingItems`, `findGroundLight`), `scripts/interactive-lights.js` (`addControl`) and
  `scripts/main.js` (the `ready` hook that builds `api`).
- The APIs below were confirmed on Foundry **14.368**, on 2026-09-29. If the running build is
  different, check the AmbientLight schema again first (`x`, `y` integer; `elevation`; `levels`).
- `git status` must be clean before the first edit.

## Why, and what was weighed

**Measured on 2026-09-29, by reading the code at `1a26e65`:**

- A lit light is not stored on an Item. It is one ActiveEffect on the Actor, flagged
  `FLAGS.EFFECT_LIGHT`, which overrides `token.light.*`. The flag points at a source definition
  (`sourceId`), never at an Item id.
- `grep -rn "deleteItem\|updateItem\|createItem" scripts/` finds 0 matches. So when another module
  deletes the lit Item, the token keeps glowing until the timer runs out or someone puts it out.
  `canvas-loot` does exactly this today when a player drops a lit lantern.
- The public API (`main.js`, `ready`) is `registerSources`, `registerCompatibility`, `activate`,
  `deactivate` and `getActive`. Moving a flame to the ground and back while keeping its remaining
  time exists only inside `dropLight` / `pickupLight`, and neither is exported.
- `dropLight` takes a Token placeable, places the light at `token.center` on `canvas.scene`, and
  posts a chat message. `canvas-loot` runs its drop on the active GM's client, inside a query
  handler. That GM may be viewing another scene, and `canvas-loot` posts its own chat card.
- For a **consuming** source, lighting spends one unit of the item (`activateLight` decrements the
  quantity). The flame is therefore not among the items the actor still carries. For a
  **non-consuming** source (the default for a source added through the config window,
  `light-sources-config.js`, `consume: false`), the carried item *is* the light.

**Decision.** Export two GM-side functions that reuse what `dropLight` and `pickupLight` already
do, without the Token placeable, the `canvas.scene` assumption or the chat message:

- `dropLightWithItem`: the light leaves the actor together with a given Item's data, but only when
  that Item really is the light (a non-consuming source it matches) and the actor carries no
  other copy of it.
- `pickupGroundLight`: puts such a light back on an actor with the time it has left.

A light placed this way is marked as belonging to the calling module. `light-sources` then never
offers it in its own Token HUD pickup and never gives it the interactive on/off control. The
calling module owns what happens to it, and `light-sources` still burns it out on schedule.

**What lost:**

- *Let the caller write an AmbientLight with this module's `groundLight` flag shape itself.* This
  works today. But it ties another repo to internal flag keys, the pickup still could not keep the
  remaining time (`createLightEffect` is not exported), and the first rename of a flag key would
  break it silently.
- *Export `dropLight` and `pickupLight` as they are.* They need a Token placeable on the viewed
  scene and post their own chat messages. A GM running a player's query has neither the placeable
  nor a reason to announce twice.
- *Listen to `deleteItem` and put the light out when its item leaves.* That fixes the glowing
  token, but the light would vanish instead of landing. It also needs its own rule for which
  deletion counts, which is the same matching rule the API encapsulates.
- *Support consuming sources too.* Their flame is not an item. Moving it with a dropped stack would
  either hand a free torch back on pickup or need a loot tile holding a light and no item. That is
  a second kind of loot, and nobody has asked for it yet.
- *Let a player's client call the API through the socket relay.* The relay is fire-and-forget
  (`placeAmbientLight` returns `true` on emit). It cannot hand the created document back, and the
  caller needs its id.

## The shape

```js
// scripts/api.js — both run on a GM client only; on any other client they warn and return
// null / false without touching anything.

/**
 * Move the light burning on an Actor to the ground along with an Item that is leaving it.
 * Call it after the Item has left the actor.
 * @param {Actor} actor
 * @param {object} itemData   the leaving Item's data (Item#toObject()); only name, type
 *                            and _stats.compendiumSource are read
 * @param {object} where
 * @param {Scene}  where.scene
 * @param {number} where.x, where.y      centre of the spot; rounded, the schema wants integers
 * @param {number} [where.elevation=0]
 * @param {string[]} [where.levels=[]]
 * @param {string} where.managedBy       the calling module's id
 * @returns {Promise<AmbientLightDocument|null>}  null when nothing moved
 */
export async function dropLightWithItem(actor, itemData, { scene, x, y, elevation = 0, levels = [], managedBy }) {}

/**
 * Put a ground light placed by dropLightWithItem back on an Actor, with the time it has left.
 * The light always leaves the ground, even when it cannot be relit, as pickupLight does.
 * @param {Actor} actor
 * @param {AmbientLightDocument} light
 * @returns {Promise<boolean>}  true when the actor is now lit
 */
export async function pickupGroundLight(actor, light) {}
```

When `dropLightWithItem` moves something:

```js
const active = getActiveLight(actor);                 // null → return null
const source = getSources().find(s => s.id === active.sourceId);
if ( !source || source.consume || source.freeForAll ) return null;
if ( !matchesSource(itemData, source) ) return null;  // the leaving item is not this light
if ( findMatchingItems(actor, source).length ) return null; // another copy still in hand
await deactivateLight(actor);
return createGroundLight(scene, { x, y, elevation, levels, pattern, active, managedBy });
```

- `matchesSource(itemData, source)` is extracted from `findMatchingItems`, which then calls it, so
  the rule is written once. It checks the same uuid first (`_stats.compendiumSource`), then name
  plus optional type.
- `createGroundLight` is the flag-building part of `dropLight`, moved out so both use it. It builds
  the `GROUND_LIGHT` payload (it gains `managedBy`), sets `INTERACTIVE` to `!managedBy`,
  `hidden: !!active.stowed`, and calls `scene.createEmbeddedDocuments("AmbientLight", …)`.
- `dropLight` keeps its token, its socket relay and its chat message, and calls the shared part.

`pickupGroundLight` is the middle of `pickupLight` without the relay and without chat:

1. Delete the light (GM, direct).
2. Resolve `source` and `pattern`, then check `isExpired`.
3. Call `createLightEffect(actor, source, pattern, timing, { stowed: !!source.coverable && hidden })`.

`pickupLight` then calls the same core. As today, `createLightEffect` replaces any light already
burning on the actor: one light per actor stays the rule.

The only exclusions a managed light needs:

```js
// helpers.js, findGroundLight
if ( flag.managedBy ) continue;   // another module's loot; it hands the light back itself
```

Exposed in `main.js`:
`const api = { registerSources, registerCompatibility, activate, deactivate, getActive, dropLightWithItem, pickupGroundLight };`

**Existing worlds.** `managedBy` is a new, optional key inside the existing `groundLight` flag.
Ground lights already on a map don't have it and behave exactly as they do today. There is no
migration, and nothing is rewritten.

## Invariants

| Must hold | What falsifies it, and how it is observed |
|---|---|
| A non-consuming lit item that leaves the actor takes the light with it | In a `claude-*` world, as GM: light a lantern on an actor, delete the item, call `dropLightWithItem`. `getActive(actor)` is not null afterwards, or no AmbientLight with `groundLight.managedBy` exists at (x, y) |
| A second copy still carried keeps the light on the actor | Same setup with two lanterns, one deleted: the call returns a document, or `getActive(actor)` becomes null |
| A consuming source never moves | Light a consuming torch, delete a torch item, call it: it returns anything but null |
| An item that is not the lit source moves nothing | Call it with a rope's data while a lantern burns: it returns anything but null |
| Remaining time survives the round trip | World-time source of 10 minutes; advance 4; drop; advance 1; `pickupGroundLight`. The effect's `expiresAtWorld` differs from the original stamp, or its `duration.value` isn't about 300 seconds |
| A managed light is invisible to this module's own pickup and on/off control | Place one; `findGroundLight(token)` next to it returns it, or `interactive-lights` has a control for its id |
| A managed light still burns out | Advance world time past its stamp: the AmbientLight is still there after `sweepExpiredLights` |
| A player's client cannot use either function | Call both from a player client in a two-client run (`foundry-playwright`, `references/multi-client.md`): anything other than null / false with no document changed |
| No new console errors | `__probe.dump()` after the checks above shows an error from this module |

## The commits

1. `Expose dropLightWithItem and pickupGroundLight so another module can carry a lit light to the ground`
   Body: why the existing drop/pickup were split into a shared core, why only non-consuming
   sources move, why managed ground lights are left out of the HUD pickup and the interactive
   control. The commit also updates `docs/` (a section after the `registerSources` reference) and
   `CHANGELOG.md` under an unreleased heading. It does not touch `version` in `module.json`.

## What this deliberately does not do

- **No player-side path.** Both functions refuse outside a GM client; the reason is under *What
  lost*.
- **No consuming sources.** Their flame is not an item.
- **No hooks fired for other modules** (`lightSources.dropped` and the like). The one known caller
  asks, it doesn't listen. A hook with a single listener is an API nobody has had to design yet.
- **No reaction to Items being deleted** by anyone other than a caller of this API. The glowing
  token after a plain item deletion is a separate subject, if it is wanted.
- **No chat output** from either function. The caller already narrates the drop and the pickup.

## Collisions

- No other open plan in this repo (`ls plans/` was empty, 2026-09-29).
- This plan **blocks** `canvas-loot/plans/light-sources-integration/`, which calls both functions
  and has to wait for this commit and a release carrying it.

## Departures

