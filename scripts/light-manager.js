/*!
 * Light Sources
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import {
  MODULE_ID, FLAGS, SOCKET_EVENT, DURATION_MODES, CONSUME_MODES, LIGHT_CHANGE_PRIORITY, EXPIRY_CHECK_INTERVAL_MS, EXPIRY_EVENT,
  PICKUP_REASONS
} from "./constants.js";
import {
  findMatchingItems, buildLightMessage, getItemRemaining, getQuantityPath, getChargesPath, getChargesSpentPath, getSources,
  getAnnounceLit
} from "./helpers.js";

/**
 * Interval id of the real-time expiry ticker, so it is only ever started once
 * per client.
 * @type {number|null}
 */
let tickerId = null;

/**
 * The expiry sweep last asked for, which every new one waits behind (see
 * `sweepExpiredLights`).
 * @type {Promise<void>}
 */
let sweepQueue = Promise.resolve();

/**
 * Get the ActiveEffect this module uses to drive an Actor's light, if any.
 * The module only ever keeps one such effect per actor at a time.
 * @param {Actor} actor The actor to inspect.
 * @returns {ActiveEffect|null} The module's light effect, or null.
 */
export function getLightEffect(actor) {
  return actor.effects.find(e => e.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT)) ?? null;
}

/**
 * Get the active light bookkeeping payload stored on an Actor's light effect.
 * Used by the Token HUD to reflect the lit/unlit state.
 *
 * `stowed` is derived from the effect's own `disabled` state rather than stored
 * alongside the flag: a player can disable the effect straight from their character
 * sheet, and a second copy of that state in the flag would drift the moment they did.
 * @param {Actor} actor The actor to inspect.
 * @returns {object|null} The flag payload ({sourceId, patternId, patternName, itemName, mode, expiresAtWorld, expiresAtReal}) plus the derived `stowed`, or null.
 */
export function getActiveLight(actor) {
  const effect = getLightEffect(actor);
  const flag = effect?.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT);
  return flag ? { ...flag, stowed: !!effect.disabled } : null;
}

/**
 * Build the token light data for a light pattern. Only basic + animation fields
 * are set; advanced light options on the token are deliberately left untouched.
 * Used by the light editor's live preview, which writes directly to a token's
 * light source without persisting.
 * @param {object} pattern A light pattern ({id, name, light}), or any object
 *   exposing a `light` configuration.
 * @returns {object} Plain light data suitable for a Token light source.
 */
export function buildLightData(pattern) {
  const light = foundry.utils.deepClone(pattern.light);
  light.color = light.color || null;
  light.animation = {
    type: light.animation?.type || null,
    speed: light.animation?.speed ?? 5,
    intensity: light.animation?.intensity ?? 5,
    reverse: !!light.animation?.reverse
  };
  return light;
}

/**
 * Build the ActiveEffect `changes` array that overrides a token's light with a
 * light pattern. One entry per basic/animation field, each an `override`
 * targeting a native v14 `token.light.*` key (core strips the `token.` prefix and
 * applies it to the TokenDocument — a core feature, independent of any game
 * system). Only these keys are touched, so advanced light options (luminosity,
 * attenuation, coloration, shadows, darkness) remain at the token's own base value.
 * @param {object} pattern A light pattern ({id, name, light}) of a source.
 * @returns {object[]} The change entries for `ActiveEffect#system#changes`.
 */
function buildLightChanges(pattern) {
  const light = pattern.light ?? {};
  const anim = light.animation ?? {};
  const alpha = Number(light.alpha);
  const entry = (key, value) => ({ key, value, type: "override", phase: "initial", priority: LIGHT_CHANGE_PRIORITY });
  return [
    entry("token.light.dim", Math.max(0, Number(light.dim) || 0)),
    entry("token.light.bright", Math.max(0, Number(light.bright) || 0)),
    entry("token.light.angle", Number(light.angle) || 360),
    entry("token.light.color", light.color || null),
    entry("token.light.alpha", Number.isFinite(alpha) ? alpha : 0.5),
    // Written even when false: an unset key would leave a token whose own light is a
    // darkness source emitting darkness at this pattern's radii.
    entry("token.light.negative", !!light.negative),
    entry("token.light.animation.type", anim.type || ""),
    entry("token.light.animation.speed", Number(anim.speed) || 5),
    entry("token.light.animation.intensity", Number(anim.intensity) || 5),
    entry("token.light.animation.reverse", !!anim.reverse)
  ];
}

/**
 * Resolve when a freshly lit light will burn out, as absolute stamps.
 *
 * Absolute rather than "minutes remaining" so the deadline survives the flame
 * changing hands — a light dropped on the ground and picked back up keeps counting
 * toward the same instant it always would have (see `dropLight` / `pickupLight`).
 * A source with no configured duration burns until it is put out and stores no
 * stamp at all.
 * @param {object} source The registered light source definition.
 * @returns {{mode: string, expiresAtWorld: number|null, expiresAtReal: number|null}} The timing payload.
 */
function buildTiming(source) {
  const mode = source.durationMode === DURATION_MODES.REAL ? DURATION_MODES.REAL : DURATION_MODES.WORLD;
  const minutes = source.durationMinutes > 0 ? source.durationMinutes : 0;
  return {
    mode,
    expiresAtWorld: (mode === DURATION_MODES.WORLD) && minutes ? game.time.worldTime + (minutes * 60) : null,
    expiresAtReal: (mode === DURATION_MODES.REAL) && minutes ? Date.now() + (minutes * 60000) : null
  };
}

/**
 * Test whether a light's bookkeeping payload says it has burned out. Shared by the
 * expiry sweep and by pickup, so a light lying on the ground and a light burning on
 * a token go out on exactly the same rule.
 * @param {object} flag A bookkeeping payload ({mode, expiresAtWorld, expiresAtReal}).
 * @param {number} now The current `Date.now()` timestamp.
 * @returns {boolean} True when the light has burned out.
 */
function isExpired(flag, now) {
  return flag.mode === DURATION_MODES.REAL
    ? (flag.expiresAtReal != null) && (flag.expiresAtReal <= now)
    : (flag.expiresAtWorld != null) && (game.time.worldTime >= flag.expiresAtWorld);
}

/**
 * Create the ActiveEffect that overrides a token's light, replacing any light
 * effect already on the actor. Split out from `activateLight` because lighting a
 * source and reclaiming one off the ground differ only in where the timing comes
 * from: activation starts a fresh clock, pickup restores a clock already part
 * spent. Neither consumption nor the chat announcement belongs here — both differ
 * between the two callers.
 * @param {Actor} actor The actor to light.
 * @param {object} source The registered light source definition.
 * @param {object} pattern The light pattern ({id, name, light}) to light.
 * @param {{mode: string, expiresAtWorld: number|null, expiresAtReal: number|null}} timing
 *   When the light burns out, as absolute stamps (see `buildTiming`).
 * @param {object} [options={}] Creation options.
 * @param {boolean} [options.stowed=false] Create the light already covered, so it
 *   burns down without shining (see `setLightStowed`). Used when picking a light
 *   back up that was lying on the ground switched off.
 * @param {string|null} [options.itemId=null] The carried Item that is burning (see
 *   `payForLight`). Recorded so the light can leave with that exact Item, and go
 *   out when it leaves any other way (see `onDeleteItem`).
 * @returns {Promise<void>}
 */
async function createLightEffect(actor, source, pattern, timing, { stowed = false, itemId = null } = {}) {
  // Only one light effect at a time: remove any previous one (switching sources / re-lighting).
  const stale = actor.effects.filter(e => e.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT)).map(e => e.id);
  if ( stale.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", stale);

  // World-time lights carry a native duration, so the effect shows how long the
  // light has left like any other timed effect. Real-time lights keep an indefinite
  // native duration (advancing the clock must not affect them). Either way the
  // expiry sweep is what puts a light out: `expiry` names this module's own event,
  // which core never fires, so core's effect registry leaves the effect alone
  // instead of writing to it while the sweep deletes it (see `EXPIRY_EVENT`).
  // The length is derived from the absolute stamp rather than from the source's
  // configured minutes, so a light picked back up finishes only what it has left.
  // Counted in seconds, not minutes: `duration.value` is an integer field, and what
  // is left of a part-spent light is rarely a whole number of minutes.
  const remaining = timing.expiresAtWorld != null ? timing.expiresAtWorld - game.time.worldTime : null;
  const duration = remaining != null
    ? { value: Math.max(0, Math.round(remaining)), units: "seconds", expiry: EXPIRY_EVENT }
    : { value: null };

  // This effect is system-agnostic: every piece below is core Foundry v14, not
  // system-specific. `token.light.*` is native token-targeting (core strips
  // the `token.` prefix and applies it to the TokenDocument); `type: "base"` is
  // CONST.BASE_DOCUMENT_TYPE, for which core itself registers the data model
  // (CONFIG.ActiveEffect.dataModels.base = ActiveEffectTypeDataModel) defining
  // `system.changes`. The change shape validates on a vanilla-core world and on
  // any system that doesn't hostilely narrow the base changes schema (some
  // systems reshape it but keep the same shape + the `override` mode).
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: source.name,
    img: source.img,
    type: "base",
    transfer: false,
    disabled: stowed,
    duration,
    system: { changes: buildLightChanges(pattern) },
    flags: { [MODULE_ID]: { [FLAGS.EFFECT_LIGHT]: {
      sourceId: source.id,
      patternId: pattern.id,
      patternName: pattern.name,
      itemName: source.name,
      itemId,
      ...timing
    } } }
  }]);
}

/**
 * Pay for lighting `source` on `actor`, and say which carried Item the flame burns on.
 * The flame leaves its Item only when a copy of that Item was spent. A lantern, and an
 * object whose charge was spent, go on being the light. A free-for-all source has no
 * item at all. When several items match, the first whose flame is not already lying
 * on the ground is the one lit.
 * @param {Actor} actor The actor being lit.
 * @param {object} source The registered light source definition.
 * @returns {Promise<{itemId: string|null}|null>} Where the flame burns, or null when
 *   refused because nothing carried can pay, or because the flame of every matching
 *   item lies on the ground (a warning has been shown).
 */
async function payForLight(actor, source) {
  if ( source.freeForAll ) return { itemId: null };
  const matches = findMatchingItems(actor, source);
  // A "copy" flame never belongs to its Item, so the stack can go on lighting copies
  // while earlier ones lie on the ground.
  const onGround = (source.consume === CONSUME_MODES.COPY) ? new Set() : itemsWithLightOnGround(actor);
  const item = matches.find(i => !onGround.has(i.id));
  if ( matches.length && !item ) {
    ui.notifications.warn(game.i18n.format("LIGHTSOURCES.Hud.OnGround", { item: source.name }));
    return null;
  }
  // A "none" source lights without an item, as 0.2.0 did through the API (a spell's
  // light, say); only a source that spends needs something to spend.
  if ( source.consume === CONSUME_MODES.NONE ) return { itemId: item?.id ?? null };
  if ( !item ) {
    ui.notifications.warn(game.i18n.format("LIGHTSOURCES.Hud.NoItem", { name: actor.name, item: source.name }));
    return null;
  }
  await spendOne(actor, item, source.consume);
  // Captured before the spend: the last charge takes the Item to 0, which hides it from
  // findMatchingItems, and it is still the Item that burns.
  return { itemId: source.consume === CONSUME_MODES.COPY ? null : item.id };
}

/**
 * Spend one of what `mode` counts. Charges stored as "spent so far" count up; everything
 * else counts down. An unknown count spends nothing, as 0.2.0 did.
 * @param {Actor} actor The actor carrying the item.
 * @param {Item} item The item paying for the light.
 * @param {string} mode The source's `consume` mode (see CONSUME_MODES).
 * @returns {Promise<void>}
 */
async function spendOne(actor, item, mode) {
  const remaining = getItemRemaining(item, mode);
  if ( !Number.isFinite(remaining) ) return;
  const spentPath = (mode === CONSUME_MODES.CHARGE) ? getChargesSpentPath() : "";
  const update = spentPath
    ? { [spentPath]: (Number(foundry.utils.getProperty(item, spentPath)) || 0) + 1 }
    : { [mode === CONSUME_MODES.CHARGE ? getChargesPath() : getQuantityPath()]: remaining - 1 };
  await Item.implementation.updateDocuments([{ _id: item.id, ...update }], { parent: actor });
}

/**
 * The ids of an actor's Items whose light lies on the ground, on any scene. Such an Item is
 * not lit again: its flame already exists and is waiting to be picked up. A light that burns
 * out or is removed from the ground frees its Item with it.
 *
 * Read on whichever client lights, often a player's: every client holds every scene's
 * AmbientLights, including a scene that player cannot see.
 * @param {Actor} actor The actor about to light.
 * @returns {Set<string>} Item ids.
 */
function itemsWithLightOnGround(actor) {
  const ids = new Set();
  for ( const scene of game.scenes ) {
    for ( const light of scene.lights ) {
      const ground = light.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT);
      if ( ground?.itemId && (ground.actorUuid === actor.uuid) ) ids.add(ground.itemId);
    }
  }
  return ids;
}

/**
 * The carried Item a light picked up from the ground burns on (nothing is spent).
 * The actor that dropped it gets it back on the Item it burned on. Anyone else binds it
 * to what they carry, because an Item id means something only on its own actor.
 * @param {Actor} actor The actor picking the light up.
 * @param {object} source The registered light source definition.
 * @param {object} ground The light's `GROUND_LIGHT` payload.
 * @returns {string|null} The Item's id, or null when no carried item is the light.
 */
function bindOnPickup(actor, source, ground) {
  if ( source.freeForAll || (source.consume === CONSUME_MODES.COPY) ) return null;
  if ( (ground.actorUuid === actor.uuid) && actor.items.has(ground.itemId) ) return ground.itemId;
  // Past the count: a torch whose last charge lit this flame is at 0, and is still the torch.
  return findMatchingItems(actor, source, { anyCount: true })[0]?.id ?? null;
}

/**
 * Activate a light source on an Actor: optionally consume one item, then create
 * an ActiveEffect that overrides the token's light. The effect lives on the
 * Actor, so its light applies to every token of that actor across all scenes and
 * follows the character; extinguishing is simply deleting the effect, which
 * reverts the token to its original light with no stored snapshot.
 *
 * Re-lighting the source already burning is a *pattern switch* and takes a separate
 * path: it reshapes the existing flame in place instead of spending a second item and
 * restarting the clock (see `switchPattern`).
 * @param {Actor} actor The actor (world actor, or synthetic actor of an unlinked token).
 * @param {object} source The registered light source definition. When
 *   `source.freeForAll` is set, the item lookup and quantity consumption are
 *   skipped entirely (regardless of `source.consume`), so every eligible actor
 *   can use the light with no carried item.
 * @param {object} pattern The light pattern ({id, name, light}) to light. A source
 *   may own several patterns (e.g. a flashlight's wide vs. narrow beam);
 *   consumption and duration are shared across all of them, only the emitted
 *   light shape differs.
 * @returns {Promise<boolean>} True when the source is now lit. False when it was
 *   refused — the actor no longer carries the item a spending source needs, or the
 *   item's flame is lying on the ground. The Token HUD ignores this; the public
 *   `activate` API reports it to its caller.
 */
export async function activateLight(actor, source, pattern) {
  // Matched on the source alone, not the pattern: a source's patterns are ways for
  // the same flame to burn, so moving between them is never a new light.
  const effect = getLightEffect(actor);
  if ( effect?.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT)?.sourceId === source.id ) {
    await switchPattern(actor, effect, pattern);
    return true;
  }

  const paid = await payForLight(actor, source);
  if ( !paid ) return false;
  await createLightEffect(actor, source, pattern, buildTiming(source), { itemId: paid.itemId });

  if ( !getAnnounceLit() ) return true;

  // Name the pattern only when the source has more than one: a lone pattern is
  // the implicit default and its name carries no information (it may be empty).
  const announcement = (source.patterns?.length > 1) && pattern.name
    ? game.i18n.format("LIGHTSOURCES.Chat.LitPattern", { actor: actor.name, item: source.name, pattern: pattern.name })
    : game.i18n.format("LIGHTSOURCES.Chat.Lit", { actor: actor.name, item: source.name });
  await ChatMessage.implementation.createDocuments([
    buildLightMessage(actor, game.i18n.localize("LIGHTSOURCES.Chat.LitTitle"), announcement)
  ]);
  return true;
}

/**
 * Move the light already burning on an Actor to another of its source's patterns —
 * a flashlight going from wide beam to narrow, not a second flashlight.
 *
 * The effect is updated in place rather than replaced, which is what makes the
 * source's consumption and duration genuinely shared across its patterns (as the
 * light editor promises the GM): no item is spent, and the untouched `duration`
 * keeps counting from the original light's start, so the native expiry still lands
 * where it always would have. The bookkeeping flag is rewritten wholesale from the
 * previous payload with only the pattern fields moved, so the source, the item name
 * and both expiry stamps survive verbatim — a GM re-timing the source mid-burn does
 * not retime a flame that is already lit. Nothing is announced in chat: the table
 * already heard this light being lit.
 *
 * Reshaping a stowed light also uncovers it (see `setLightStowed`): picking a
 * different pattern is a request to see that pattern, and leaving the effect
 * disabled would make the click do nothing visible.
 * @param {Actor} actor The actor whose light is being reshaped.
 * @param {ActiveEffect} effect The module's light effect currently on the actor.
 * @param {object} pattern The light pattern ({id, name, light}) to switch to.
 * @returns {Promise<void>}
 */
async function switchPattern(actor, effect, pattern) {
  const flag = effect.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT);
  await actor.updateEmbeddedDocuments("ActiveEffect", [{
    _id: effect.id,
    disabled: false,
    system: { changes: buildLightChanges(pattern) },
    flags: { [MODULE_ID]: { [FLAGS.EFFECT_LIGHT]: { ...flag, patternId: pattern.id, patternName: pattern.name } } }
  }]);
}

/**
 * Cover or uncover the light burning on an Actor: the flame stops shining, but the
 * effect — and with it both expiry stamps — stays exactly where it is.
 *
 * This is the non-destructive counterpart to `deactivateLight`, for sources whose
 * light is not a physical flame to be snuffed but a spell on an object that can be
 * pocketed and taken back out (a Light cantrip cast on a pebble, a lit driftglobe).
 * Extinguishing such a source ends the spell; covering it does not.
 *
 * The mechanism is core's own `disabled`: `Actor#applyActiveEffects` skips an
 * inactive effect entirely, so the token drops straight back to whatever light it
 * emits on its own — including light it emitted before this one was lit, which
 * overriding the radii to 0 would have stamped out. Nothing is written to the
 * duration, so the countdown carries on toward the same instant it always would
 * have, and the expiry sweep puts a covered light out on schedule like any other.
 * Nothing is announced in chat, mirroring extinguishing.
 * @param {Actor} actor The actor whose light is covered or uncovered.
 * @param {boolean} stowed True to cover the light, false to uncover it.
 * @returns {Promise<void>}
 */
export async function setLightStowed(actor, stowed) {
  const effect = getLightEffect(actor);
  if ( !effect || (effect.disabled === !!stowed) ) return;
  await actor.updateEmbeddedDocuments("ActiveEffect", [{ _id: effect.id, disabled: !!stowed }]);
}

/**
 * Drop the light burning on a token as a standalone AmbientLight on the scene:
 * the lit light moves from the token to the ground. Dropping only ever relocates
 * an already-active light, so it never consumes and never refunds an item —
 * spending is entirely activation's business (see `activateLight`). A source that
 * spends already paid for this light when it was lit; a `"none"` source never pays
 * at all. The Item the flame burned on stays with the actor, and is not lit again
 * while its flame lies on the ground (see `payForLight`). Re-lighting afterwards is a
 * deliberate, manual action.
 * The light is placed at the token's center using the given pattern's light data,
 * and announced in chat once it is down.
 *
 * The placed AmbientLight carries a `GROUND_LIGHT` flag recording which source and
 * pattern it came from and when it burns out, which is what lets it be picked back
 * up later (see `pickupLight`) and what lets the expiry sweep put it out.
 * @param {Actor} actor The actor dropping the light.
 * @param {object} source The registered light source definition. Must be the source
 *   of the actor's currently active light — dropping is a no-op otherwise.
 * @param {object} pattern The light pattern ({id, name, light}) whose light data is
 *   placed. Passed in rather than read from the active-light flag, which stores only
 *   the pattern's id and name, not its light configuration.
 * @param {foundry.canvas.placeables.Token} token The token placeable the drop originates from.
 * @returns {Promise<void>}
 */
export async function dropLight(actor, source, pattern, token) {
  // Matched on the source alone, not the pattern: consumption and duration are
  // shared across a source's patterns, so any of its patterns is the same lit light.
  // Defensive — the Token HUD only offers the drop control on the lit row.
  const active = getActiveLight(actor);
  if ( active?.sourceId !== source.id ) return;

  // AmbientLight documents anchor on their center point, so drop the light at the
  // token's center rather than its top-left origin (token.x / token.y).
  const { x, y } = token.center;
  const placed = await moveLightToGround(actor, canvas.scene?.id, {
    ...buildGroundLightData(actor, source, pattern, active),
    x,
    y
  });
  // Nothing reached the ground (no scene, or no GM to place it): stay silent rather
  // than announce a light that does not exist. `placeAmbientLight` reports the cause,
  // and the flame is still burning on the token.
  if ( !placed ) return;

  await ChatMessage.implementation.createDocuments([
    buildLightMessage(
      actor,
      game.i18n.localize("LIGHTSOURCES.Chat.DroppedTitle"),
      game.i18n.format("LIGHTSOURCES.Chat.Dropped", { actor: actor.name, item: source.name })
    )
  ]);
}

/**
 * Build the AmbientLight creation data for a light leaving an actor, everything but
 * its position. Shared by the Token HUD's drop and the public API's, so a light put
 * down either way carries the same flags and burns on the same clock.
 *
 * The `_id` is minted here and kept on creation (see `createAmbientLight`), so the
 * dropping client knows which document to take back even when the GM created it
 * over the socket relay (see `moveLightToGround`).
 * @param {Actor} actor The actor the light leaves.
 * @param {object} source The registered light source definition.
 * @param {object} pattern The light pattern ({id, name, light}) whose light data is placed.
 * @param {object} active The actor's active light payload (see `getActiveLight`).
 * @param {string|null} [managedBy=null] The package placing the light through the API.
 * @returns {object} AmbientLight creation data without `x` / `y`.
 */
function buildGroundLightData(actor, source, pattern, active, managedBy = null) {
  const ground = {
    sourceId: source.id,
    patternId: pattern.id,
    patternName: pattern.name,
    itemName: source.name,
    actorUuid: actor.uuid,
    // The Item the flame burned on, so it is not lit a second time while this lies
    // here (see `payForLight`), and the pickup hands the flame back to it.
    itemId: active.itemId ?? null,
    mode: active.mode,
    expiresAtWorld: active.expiresAtWorld,
    expiresAtReal: active.expiresAtReal
  };
  if ( managedBy ) ground.managedBy = managedBy;
  return {
    _id: foundry.utils.randomID(),
    config: buildLightData(pattern),
    // A covered light put down stays covered: `hidden` is the ground's own version
    // of stowed — the same state the interactive control switches — so the light
    // reads identically in a pocket and on the floor (see `setLightStowed`).
    hidden: !!active.stowed,
    // Everything needed to light this same flame again on a token, plus enough to
    // tell a dropped light apart from scenery the GM placed by hand. The expiry
    // stamps carry over untouched: the flame goes on burning where it lies, so the
    // instant it gutters out does not move (see `sweepExpiredLights`).
    //
    // A light you put down yourself is always yours to work: it gets the interactive
    // control automatically, with no GM opt-in, unlike scenery lights. A managed one
    // carries the flag too, and gets the control only once its owner is gone (see
    // `isManagedElsewhere`).
    flags: { [MODULE_ID]: { [FLAGS.INTERACTIVE]: true, [FLAGS.GROUND_LIGHT]: ground } }
  };
}

/**
 * Move an actor's burning light onto the ground: place it first, and only then put
 * it out on the actor. The other order loses the flame whenever placing fails — no GM
 * connected to relay to, a scene deleted meanwhile, a module cancelling the creation.
 * If putting it out throws, or a pre-delete hook quietly refuses it, the placed light
 * is taken back, so the flame ends up in exactly one place.
 * @param {Actor} actor The actor the light leaves.
 * @param {string} sceneId The id of the scene to place the light on.
 * @param {object} lightData The AmbientLight creation data, with its `_id`.
 * @returns {Promise<boolean>} True once the light is on the ground (or handed to the
 *   active GM to place) and off the actor.
 */
async function moveLightToGround(actor, sceneId, lightData) {
  if ( !(await placeAmbientLight(sceneId, lightData)) ) return false;
  try {
    await deactivateLight(actor);
  } catch(err) {
    await removeAmbientLight(sceneId, lightData._id);
    throw err;
  }
  // A cancelled deletion resolves without throwing, so the outcome is checked, not assumed.
  if ( getLightEffect(actor) ) {
    await removeAmbientLight(sceneId, lightData._id);
    return false;
  }
  return true;
}

/**
 * Move the light burning on an Item's actor to the ground, together with that Item.
 * The engine behind the public `dropLightWithItem`; runs on a GM client, which may be
 * viewing another scene, and announces nothing — the caller narrates its own drop.
 *
 * The light moves only when `item` is the very Item it burns on (`itemId`). No
 * matching by name and no counting of copies: an Item id says exactly what those
 * would guess at. It must be called while `item` is still on its actor, since the
 * actor is where the light and the id are read, and because removing the Item first
 * would already have put the light out (see `onDeleteItem`).
 * @param {Item} item The Item about to leave its actor.
 * @param {Scene} scene The scene the light lands on.
 * @param {{x: number, y: number, elevation: number, levels: string[]}} where Where it lands.
 * @param {string} managedBy The package placing the light, which hands it back itself.
 * @returns {Promise<AmbientLightDocument|null>} The placed light, or null when nothing moved.
 */
export async function dropItemLight(item, scene, { x, y, elevation, levels }, managedBy) {
  const actor = item.parent;
  const active = getActiveLight(actor);
  if ( !active?.itemId || (active.itemId !== item.id) ) return null;

  const source = getSources().find(s => s.id === active.sourceId);
  const pattern = source?.patterns?.find(p => p.id === active.patternId);
  if ( !pattern ) return null;

  const lightData = {
    ...buildGroundLightData(actor, source, pattern, active, managedBy),
    // The schema stores integer coordinates; a hex centre or a gridless point is fractional.
    x: Math.round(x),
    y: Math.round(y),
    elevation,
    levels
  };
  if ( !(await moveLightToGround(actor, scene.id, lightData)) ) return null;
  return scene.lights.get(lightData._id) ?? null;
}

/**
 * Work out whether a light taken off the ground can burn on a token again. Shared by
 * the Token HUD's pickup and the public API's, so both refuse on the same rule.
 * @param {object} ground The light's `GROUND_LIGHT` payload.
 * @returns {{source?: object, pattern?: object, reason: string|null}} The source and
 *   pattern to light, or the `PICKUP_REASONS` value explaining why it cannot be lit.
 */
function readGroundLight(ground) {
  const source = getSources().find(s => s.id === ground.sourceId);
  const pattern = source?.patterns?.find(p => p.id === ground.patternId);
  if ( !pattern ) return { reason: PICKUP_REASONS.SOURCE_REMOVED };
  if ( isExpired(ground, Date.now()) ) return { reason: PICKUP_REASONS.BURNED_OUT };
  return { source, pattern, reason: null };
}

/**
 * Put a ground light back on the actor carrying `item`, burning on that Item with the
 * time it has left. The engine behind the public `pickupGroundLight`; runs on a GM
 * client and announces nothing — the caller tells its own user, from the returned
 * reason, why a light did not come back.
 *
 * The light always leaves the ground once it is found, even when it cannot be relit,
 * exactly as `pickupLight` does: the caller has just taken the Item it belongs to, and
 * a light left behind would belong to nothing.
 *
 * Unlike the Token HUD's pickup, a light already burning on the actor is never
 * replaced; the picked-up flame goes out instead (`occupied`), and lighting that Item
 * again costs what lighting always costs — for an Item that spends a charge, another
 * charge. Replacing instead would silently snuff whatever the actor had lit, a spent
 * torch included.
 * @param {Item} item The Item the light returns with, already on the picking actor.
 * @param {AmbientLightDocument} light A ground light placed by `dropItemLight`.
 * @returns {Promise<{lit: boolean, reason: string|null}>} Whether the actor is now lit,
 *   and otherwise the `PICKUP_REASONS` value saying why not.
 */
export async function pickupItemLight(item, light) {
  const ground = light.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT);
  const hidden = !!light.hidden;
  if ( !(await deleteAmbientLight(light.parent?.id, light.id)) ) return { lit: false, reason: PICKUP_REASONS.MISSING };

  const { source, pattern, reason } = readGroundLight(ground);
  if ( reason ) return { lit: false, reason };

  const actor = item.parent;
  if ( getLightEffect(actor) ) return { lit: false, reason: PICKUP_REASONS.OCCUPIED };

  await createLightEffect(actor, source, pattern, {
    mode: ground.mode,
    expiresAtWorld: ground.expiresAtWorld,
    expiresAtReal: ground.expiresAtReal
  }, { stowed: !!source.coverable && hidden, itemId: item.id });
  return { lit: true, reason: null };
}

/**
 * Put a light out when the Item it burns on leaves its actor — deleted from a sheet,
 * dragged to another actor, handed away by another module. Without this the token
 * would go on glowing with nothing left to glow with. A light that moves *with* its
 * Item has already left the actor by the time the Item goes (see `dropItemLight`), so
 * this finds nothing to do then.
 *
 * `deleteItem` fires on every client; only the one that deleted the Item acts, and it
 * can, because deleting an embedded Item already required owning the actor.
 * @param {Item} item The deleted Item.
 * @param {object} options The deletion options.
 * @param {string} userId The id of the user who deleted it.
 * @returns {void}
 */
export function onDeleteItem(item, options, userId) {
  if ( (userId !== game.user.id) || (item.parent?.documentName !== "Actor") ) return;
  if ( getActiveLight(item.parent)?.itemId !== item.id ) return;
  deactivateLight(item.parent).catch(err => console.error(`${MODULE_ID} | Could not put out the light of a removed item`, err));
}

/**
 * Take a light back off the ground and light it on an Actor again: the flame moves
 * from the ground back to the token, the reverse of `dropLight`.
 *
 * Deliberately *not* the reverse of activation. An item is spent when a light is
 * lit, never when it is dropped, so picking one up returns no item and costs none —
 * it re-lights the very flame that was put down, with whatever burn time it has
 * left. Refunding quantity instead would mint a free torch on every drop/pickup loop.
 *
 * The light always leaves the ground, even when it cannot be re-lit (its source was
 * deleted from the config meanwhile, or it burned out before anyone came back for
 * it). Leaving it behind would strand a light the HUD keeps offering and nothing can
 * ever claim.
 * @param {Actor} actor The actor picking the light up.
 * @param {AmbientLightDocument} light The dropped light being reclaimed. Must carry
 *   a `GROUND_LIGHT` flag — a light the GM placed by hand is a no-op.
 * @returns {Promise<void>}
 */
export async function pickupLight(actor, light) {
  const ground = light?.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT);
  if ( !ground ) return;

  // Read before the document goes: a light lying switched off comes back covered
  // rather than shining, but only for a source that can be covered at all — a
  // snuffed torch has no such state to return to and lights normally, as it always did.
  const hidden = !!light.hidden;

  const removed = await removeAmbientLight(light.parent?.id, light.id);
  // Nothing left the ground (no GM to remove it): don't hand the actor a second
  // copy of a flame still lying on the map. `removeAmbientLight` reports the cause.
  if ( !removed ) return;

  const { source, pattern, reason } = readGroundLight(ground);
  if ( reason ) {
    const key = reason === PICKUP_REASONS.BURNED_OUT ? "LIGHTSOURCES.Hud.PickupBurnedOut" : "LIGHTSOURCES.Hud.PickupSourceGone";
    ui.notifications.warn(game.i18n.format(key, { item: ground.itemName }));
    return;
  }

  await createLightEffect(actor, source, pattern, {
    mode: ground.mode,
    expiresAtWorld: ground.expiresAtWorld,
    expiresAtReal: ground.expiresAtReal
  }, { stowed: !!source.coverable && hidden, itemId: bindOnPickup(actor, source, ground) });

  await ChatMessage.implementation.createDocuments([
    buildLightMessage(
      actor,
      game.i18n.localize("LIGHTSOURCES.Chat.PickedUpTitle"),
      game.i18n.format("LIGHTSOURCES.Chat.PickedUp", { actor: actor.name, item: source.name })
    )
  ]);
}

/**
 * Place an AmbientLight on a scene, delegating to the active GM when the current
 * user lacks permission. Foundry only lets a GM create AmbientLight documents, so
 * a non-GM caller hands the request off over the module socket.
 * @param {string} sceneId The id of the scene to place the light on.
 * @param {object} lightData The AmbientLight creation data ({x, y, config, flags}).
 * @returns {Promise<boolean>} True once the light is placed, or handed to the active
 *   GM to place. The relay is fire-and-forget, so a player only ever learns that the
 *   request was accepted — not that the document was created.
 */
async function placeAmbientLight(sceneId, lightData) {
  if ( !sceneId ) return false;
  if ( game.user.isGM ) return createAmbientLight(sceneId, lightData);
  if ( !game.users.activeGM ) {
    ui.notifications.warn(game.i18n.localize("LIGHTSOURCES.Hud.NoGm"));
    return false;
  }
  game.socket.emit(SOCKET_EVENT, { action: "dropLight", sceneId, lightData });
  return true;
}

/**
 * Remove an AmbientLight from a scene, delegating to the active GM when the current
 * user lacks permission. Mirror of `placeAmbientLight`: AmbientLight is GM-only to
 * delete just as it is to create, so a player hands the request off over the socket.
 * @param {string} sceneId The id of the scene holding the light.
 * @param {string} lightId The id of the AmbientLight to remove.
 * @returns {Promise<boolean>} True once the light is removed, or handed to the active
 *   GM to remove. Fire-and-forget for a player, exactly like `placeAmbientLight`.
 */
async function removeAmbientLight(sceneId, lightId) {
  if ( !sceneId || !lightId ) return false;
  if ( game.user.isGM ) return deleteAmbientLight(sceneId, lightId);
  if ( !game.users.activeGM ) {
    ui.notifications.warn(game.i18n.localize("LIGHTSOURCES.Hud.NoGm"));
    return false;
  }
  game.socket.emit(SOCKET_EVENT, { action: "pickupLight", sceneId, lightId });
  return true;
}

/**
 * Create the AmbientLight document. Runs on a GM client — directly for a GM user,
 * or on the active GM after a socket relay from a player.
 *
 * `keepId` keeps the `_id` the dropping client minted (see `buildGroundLightData`), so
 * that client can name this light again without ever having seen the document.
 * @param {string} sceneId The id of the scene to place the light on.
 * @param {object} lightData The AmbientLight creation data ({_id, x, y, config, flags}).
 * @returns {Promise<boolean>} True when the light was created, false when the scene
 *   no longer exists or a pre-create hook refused it.
 */
async function createAmbientLight(sceneId, lightData) {
  const scene = game.scenes.get(sceneId);
  if ( !scene ) return false;
  const [created] = await scene.createEmbeddedDocuments("AmbientLight", [lightData], { keepId: true });
  forgetLightHistory(scene, lightData._id);
  return !!created;
}

/**
 * Take a dropped light out of the Lighting layer's undo history. Core records every
 * Scene-embedded write the GM's client makes on the scene it is viewing, relayed
 * ones included. Ctrl+Z on the Lighting layer would then delete a light that was
 * dropped, putting the flame out altogether, or bring back one already picked up
 * (or taken back when a drop failed), putting it in two places. A light the GM
 * placed by hand is none of this module's writes and keeps its history.
 * @param {Scene} scene The scene holding the light.
 * @param {string} lightId The id of the light.
 * @returns {void}
 */
function forgetLightHistory(scene, lightId) {
  const layer = canvas.lighting;
  if ( !layer || !canvas.scene || (scene !== canvas.scene) ) return;
  for ( const event of layer.history ) event.data = event.data.filter(d => d._id !== lightId);
  layer.history = layer.history.filter(event => event.data.length);
}

/**
 * Switch an AmbientLight on or off, delegating to the active GM when the current
 * user lacks permission. `AmbientLightDocument#getUserLevel` hands every non-GM
 * `NONE` outright, with no ownership to grant otherwise, so even flipping a single
 * boolean has to go through the GM.
 *
 * "Off" is the document's native `hidden`: the light stops emitting and disappears
 * for players, while the GM keeps seeing it dashed on the lighting layer.
 * @param {AmbientLightDocument} light The light to switch.
 * @returns {Promise<boolean>} True once switched, or handed to the active GM to
 *   switch. Fire-and-forget for a player, like the other AmbientLight relays.
 */
export async function toggleAmbientLight(light) {
  const sceneId = light?.parent?.id;
  if ( !sceneId ) return false;
  const hidden = !light.hidden;
  if ( game.user.isGM ) return setAmbientLightHidden(sceneId, light.id, hidden);
  if ( !game.users.activeGM ) {
    ui.notifications.warn(game.i18n.localize("LIGHTSOURCES.Hud.NoGm"));
    return false;
  }
  game.socket.emit(SOCKET_EVENT, { action: "toggleLight", sceneId, lightId: light.id, hidden });
  return true;
}

/**
 * Switch an AmbientLight on or off. Runs on a GM client — directly for a GM user, or
 * on the active GM after a socket relay from a player.
 *
 * The target state is carried explicitly rather than toggled here so that two players
 * clicking the same light at once converge on one outcome instead of flipping it back
 * and forth.
 * @param {string} sceneId The id of the scene holding the light.
 * @param {string} lightId The id of the AmbientLight to switch.
 * @param {boolean} hidden The state to apply.
 * @returns {Promise<boolean>} True when the light was switched, false when the scene
 *   or the light no longer exists.
 */
async function setAmbientLightHidden(sceneId, lightId, hidden) {
  const scene = game.scenes.get(sceneId);
  if ( !scene?.lights.has(lightId) ) return false;
  await scene.updateEmbeddedDocuments("AmbientLight", [{ _id: lightId, hidden: !!hidden }]);
  return true;
}

/**
 * Delete an AmbientLight document. Runs on a GM client — directly for a GM user,
 * or on the active GM after a socket relay from a player.
 * @param {string} sceneId The id of the scene holding the light.
 * @param {string} lightId The id of the AmbientLight to delete.
 * @returns {Promise<boolean>} True when the light was deleted, false when the scene
 *   or the light no longer exists (two players racing for the same dropped light).
 */
async function deleteAmbientLight(sceneId, lightId) {
  const scene = game.scenes.get(sceneId);
  if ( !scene?.lights.has(lightId) ) return false;
  await scene.deleteEmbeddedDocuments("AmbientLight", [lightId]);
  forgetLightHistory(scene, lightId);
  return true;
}

/**
 * Handle an inbound module socket message. Only the active GM acts on it, so a
 * relayed request runs exactly once even when several GMs are connected.
 * Registered on the module socket from the `ready` hook.
 * @param {object} payload The socket payload ({action, ...}).
 * @returns {void}
 */
export function handleSocketMessage(payload) {
  if ( !payload || (game.users.activeGM !== game.user) ) return;
  const fail = err => console.error(`${MODULE_ID} | Socket relay failed (${payload.action})`, err);
  switch ( payload.action ) {
    case "dropLight":
      createAmbientLight(payload.sceneId, payload.lightData).catch(fail);
      break;
    case "pickupLight":
      deleteAmbientLight(payload.sceneId, payload.lightId).catch(fail);
      break;
    case "toggleLight":
      setAmbientLightHidden(payload.sceneId, payload.lightId, payload.hidden).catch(fail);
      break;
  }
}

/**
 * Deactivate the active light on a single Actor by deleting its light effect,
 * reverting the token to its original light automatically.
 * @param {Actor} actor The actor whose light is extinguished.
 * @returns {Promise<void>}
 */
export async function deactivateLight(actor) {
  return deactivateLights([actor]);
}

/**
 * Deactivate the active light on several Actors, deleting each one's light
 * effect. Deletion is per-actor because ActiveEffects are embedded documents
 * with distinct parents.
 * @param {Actor[]} actors The actors whose lights are extinguished.
 * @returns {Promise<void>}
 */
export async function deactivateLights(actors) {
  for ( const actor of actors ) {
    const ids = actor.effects.filter(e => e.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT)).map(e => e.id);
    if ( ids.length ) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

/**
 * Collect this module's expired light effects on a single Actor.
 * A world-time light is expired once the game clock passes its stored
 * `expiresAtWorld`; a real-time light once wall-clock time passes `expiresAtReal`.
 * @param {Actor} actor The actor to inspect.
 * @param {number} now The current `Date.now()` timestamp.
 * @returns {Array<{actor: Actor, id: string, itemName: string}>} The expired entries.
 */
function collectExpired(actor, now) {
  const expired = [];
  for ( const effect of actor.effects ) {
    const flag = effect.getFlag(MODULE_ID, FLAGS.EFFECT_LIGHT);
    if ( !flag ) continue;
    if ( isExpired(flag, now) ) expired.push({ actor, id: effect.id, itemName: flag.itemName });
  }
  return expired;
}

/**
 * Find every light that has burned out and put it out — both the ones still
 * burning on a token and the ones lying on the ground where someone dropped them.
 * Runs only on the active GM client, so it works regardless of whether the owning
 * player is connected. Triggered both by the real-time ticker (for real-time lights)
 * and by the `updateWorldTime` hook (for in-game-time lights). Expired lights are
 * deleted and announced in chat; they are never re-lit or re-consumed.
 *
 * Sweeps run one at a time, in the order they were asked for. The ticker and each
 * clock advance ask independently, and two sweeps overlapping collect the same
 * lights, so the second deleted what the first already had and threw — and a throw
 * ended that sweep before it reached the lights on the ground.
 * @returns {Promise<void>}
 */
export function sweepExpiredLights() {
  const sweep = () => sweepOnce();
  return (sweepQueue = sweepQueue.then(sweep, sweep));
}

/**
 * One pass of `sweepExpiredLights`.
 * @returns {Promise<void>}
 */
async function sweepOnce() {
  if ( game.users.activeGM !== game.user ) return;
  const now = Date.now();
  const messages = [];

  // Lights burning on a token.
  const collected = [];
  for ( const actor of game.actors ) collected.push(...collectExpired(actor, now));

  // Unlinked tokens keep their effect on a synthetic actor, not in game.actors.
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorLink || !token.actor ) continue;
      collected.push(...collectExpired(token.actor, now));
    }
  }

  // Group deletions per actor (embedded documents have distinct parents). Each actor
  // is deleted on its own, so one that fails keeps neither the others nor the lights
  // on the ground burning. Only what is still there is deleted: another client may
  // have put a light out since it was collected, by extinguishing it or removing its item.
  const byActor = new Map();
  for ( const entry of collected ) {
    if ( !byActor.has(entry.actor) ) byActor.set(entry.actor, []);
    byActor.get(entry.actor).push(entry);
  }
  const expired = [];
  for ( const [actor, entries] of byActor ) {
    const live = entries.filter(({ id }) => actor.effects.has(id));
    if ( !live.length ) continue;
    try {
      await actor.deleteEmbeddedDocuments("ActiveEffect", live.map(({ id }) => id));
      expired.push(...live);
    } catch(err) {
      console.error(`${MODULE_ID} | Could not put out the burned-out light of ${actor.name}`, err);
    }
  }

  messages.push(...expired.map(({ actor, itemName }) => buildLightMessage(
    actor,
    game.i18n.localize("LIGHTSOURCES.Chat.ExpiredTitle"),
    game.i18n.format("LIGHTSOURCES.Chat.Expired", { actor: actor.name, item: itemName })
  )));

  // Lights lying on the ground burn on the very clock they had on the token (their
  // expiry stamps carried over at drop time), so they gutter out here too rather
  // than lighting the scene forever. Scenery the GM placed by hand has no flag and
  // is never touched.
  for ( const scene of game.scenes ) {
    const burnedOut = [];
    for ( const light of scene.lights ) {
      const flag = light.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT);
      if ( flag && isExpired(flag, now) ) burnedOut.push({ light, flag });
    }
    if ( !burnedOut.length ) continue;
    try {
      await scene.deleteEmbeddedDocuments("AmbientLight", burnedOut.map(({ light }) => light.id));
    } catch(err) {
      console.error(`${MODULE_ID} | Could not remove the burned-out lights on ${scene.name}`, err);
      continue;
    }
    for ( const { light } of burnedOut ) forgetLightHistory(scene, light.id);
    messages.push(...burnedOut.map(({ flag }) => buildLightMessage(
      // The actor is only the speaker here; a dropped light outlives its owner's
      // token being deleted, so a missing actor just yields a generic speaker.
      foundry.utils.fromUuidSync(flag.actorUuid) ?? undefined,
      game.i18n.localize("LIGHTSOURCES.Chat.GroundExpiredTitle"),
      game.i18n.format("LIGHTSOURCES.Chat.GroundExpired", { item: flag.itemName })
    )));
  }

  if ( messages.length ) await ChatMessage.implementation.createDocuments(messages);
}

/**
 * Start the periodic real-time expiry check. Called once from the `ready` hook;
 * the check itself no-ops on every client except the active GM. In-game-time
 * lights are handled separately through the `updateWorldTime` hook.
 * @returns {void}
 */
export function startExpiryTicker() {
  if ( tickerId !== null ) return;
  const tick = () => sweepExpiredLights().catch(err => console.error(`${MODULE_ID} | Expiry check failed`, err));
  tickerId = window.setInterval(tick, EXPIRY_CHECK_INTERVAL_MS);
  tick(); // Catch lights that expired while no GM was connected.
}
