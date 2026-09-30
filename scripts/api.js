/*!
 * Light Sources
 * Copyright (c) 2026 https://github.com/brunocalado
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3.
 */

import { MODULE_ID, SETTINGS, FLAGS, DURATION_MODES, CONSUME_MODES, PICKUP_REASONS } from "./constants.js";
import { getSources, setSources, makePattern, getItemTypes, getActorTypes, getQuantityPath } from "./helpers.js";
import { activateLight, deactivateLight, getActiveLight, dropItemLight, pickupItemLight } from "./light-manager.js";

/**
 * The usage fields a caller supplies, with the API's documented defaults filled
 * in. Also snapshotted onto the source as `moduleDefaults`, so restoring returns
 * what the module wants *now* rather than what it asked for on first registration.
 * @param {object} entry The caller's light source definition.
 * @returns {{consume: string, freeForAll: boolean, coverable: boolean, hudHidden: boolean, durationMode: string, durationMinutes: number}} The usage fields.
 */
function usageFields(entry) {
  return {
    consume: entry.consume ?? CONSUME_MODES.NONE,
    freeForAll: entry.freeForAll ?? false,
    coverable: entry.coverable ?? false,
    hudHidden: entry.hudHidden ?? false,
    durationMode: entry.durationMode ?? DURATION_MODES.WORLD,
    durationMinutes: entry.durationMinutes ?? 0
  };
}

/**
 * Find the stored pattern an incoming module pattern refers to. Matching is on
 * `moduleName` — the name the module last supplied — and never on `name`, which
 * the GM may rename freely in the editor: matching a renamed pattern by name
 * fails and mints a fresh id, orphaning any ActiveEffect pointing at the old one
 * through its `patternId` flag. A pattern the GM added by hand carries no
 * `moduleName`, so it never matches and is never claimed by a module.
 * @param {object[]} patterns The source's stored patterns.
 * @param {string} moduleName The name the module supplied for the pattern.
 * @returns {object|null} The matching stored pattern, or null when it is new.
 */
function findModulePattern(patterns, moduleName) {
  return patterns.find(p => p.moduleName === moduleName) ?? null;
}

/**
 * Convert a caller-supplied raw pattern ({name, light}) into the module's
 * internal {id, name, light, moduleName, moduleLight} shape, stamping the
 * module's own values as the snapshot a restore reverts to, and reusing a matched
 * pattern's id so live effects referencing it stay valid across an update.
 * @param {{name: string, light: object}} raw The caller's pattern definition.
 * @param {object|null} previous The stored pattern it matched, if any.
 * @returns {object} The internal pattern.
 */
function toInternalPattern(raw, previous) {
  const pattern = makePattern(raw.light, raw.name);
  if ( previous ) pattern.id = previous.id;
  return Object.assign(pattern, { moduleName: raw.name, moduleLight: foundry.utils.deepClone(raw.light) });
}

/**
 * Refresh a customized source's snapshots without disturbing what the GM edited:
 * stored patterns keep their live id/name/light and only have their snapshot
 * advanced, while a pattern the module has newly added is appended (the GM can
 * only benefit from seeing it). Nothing is ever dropped here — a pattern the GM
 * added by hand has no snapshot at all and is left strictly alone.
 * @param {object} existing The stored source (mutated in place).
 * @param {object} entry The caller's light source definition.
 */
function refreshSnapshots(existing, entry) {
  existing.moduleDefaults = usageFields(entry);
  for ( const raw of entry.patterns ) {
    const previous = findModulePattern(existing.patterns, raw.name);
    if ( previous ) Object.assign(previous, { moduleName: raw.name, moduleLight: foundry.utils.deepClone(raw.light) });
    else existing.patterns.push(toInternalPattern(raw, null));
  }
}

/**
 * Programmatically register or update light source definitions from an
 * external system or module. UUID is used as the primary key: existing
 * sources are updated in-place (preserving their internal id); new ones
 * are appended. A single setSources write is performed per call.
 *
 * A source the GM has since edited is frozen (`customized`): its values are left
 * untouched, and only its module-default snapshot is advanced, until the GM
 * explicitly restores it. Callers may therefore re-register the same static
 * entries every session without clobbering the GM's work.
 *
 * @param {object[]} entries       Array of light source definitions.
 * @param {object}  [options={}]
 * @param {string}  [options.managedBy]  id of the calling module or system.
 * @returns {Promise<void>}
 */
export async function registerSources(entries, { managedBy = null } = {}) {
  if ( !Array.isArray(entries) ) {
    console.warn(`${MODULE_ID} | registerSources expected an array of entries.`);
    return;
  }

  const sources = getSources();

  for ( const entry of entries ) {
    if ( !entry?.uuid || !Array.isArray(entry.patterns) ) {
      console.warn(`${MODULE_ID} | Skipping light source entry missing a uuid or patterns array.`, entry);
      continue;
    }
    if ( (entry.consume !== undefined) && !Object.values(CONSUME_MODES).includes(entry.consume) ) {
      console.warn(`${MODULE_ID} | Skipping light source "${entry.uuid}": consume must be one of ${Object.values(CONSUME_MODES).join(", ")}.`, entry);
      continue;
    }

    const item = await foundry.utils.fromUuid(entry.uuid);
    if ( !item ) {
      console.warn(`${MODULE_ID} | Could not resolve light source item "${entry.uuid}"; skipping.`);
      continue;
    }

    const existing = sources.find(s => s.uuid === entry.uuid);
    const usage = usageFields(entry);
    // Item metadata is not editable through this module, so it always refreshes.
    const metadata = { name: item.name, img: item.img, type: item.type, managedBy };

    if ( existing?.customized ) {
      Object.assign(existing, metadata);
      refreshSnapshots(existing, entry);
    }
    else if ( existing ) {
      // Update in place, preserving the internal id (it may be referenced by
      // active effects currently on actors) and refreshing the item metadata.
      Object.assign(existing, metadata, usage, {
        customized: false,
        moduleDefaults: { ...usage },
        patterns: entry.patterns.map(raw => toInternalPattern(raw, findModulePattern(existing.patterns, raw.name)))
      });
    }
    else {
      sources.push({
        id: foundry.utils.randomID(),
        uuid: entry.uuid,
        ...metadata,
        ...usage,
        customized: false,
        moduleDefaults: { ...usage },
        patterns: entry.patterns.map(raw => toInternalPattern(raw, null))
      });
    }
  }

  await setSources(sources);
}

/**
 * Programmatically seed the compatibility settings (item types, actor types,
 * and the item-quantity path) from an external system or module, mirroring
 * what SYSTEM_PRESETS does for systems built into the module — but supplied
 * at runtime by the caller instead of hardcoded in constants.js.
 *
 * Each field seeds independently and only when still unset, so this is safe
 * to call every session (e.g. alongside registerSources in the same `ready`
 * hook): a GM who has already configured any of these three through the
 * Compatibility config window keeps that choice untouched, even if the
 * caller supplies a different value for it.
 *
 * @param {object} [options={}]
 * @param {string[]} [options.itemTypes] Item type ids to enable as light sources.
 * @param {string[]} [options.actorTypes] Actor type ids allowed to carry/light sources.
 * @param {string} [options.quantityPath] Dotted path (from an item's root) to its quantity.
 * @returns {Promise<void>}
 */
export async function registerCompatibility({ itemTypes, actorTypes, quantityPath } = {}) {
  if ( Array.isArray(itemTypes) && !getItemTypes().length ) {
    await game.settings.set(MODULE_ID, SETTINGS.ITEM_TYPES, itemTypes);
  }
  if ( Array.isArray(actorTypes) && !getActorTypes().length ) {
    await game.settings.set(MODULE_ID, SETTINGS.ACTOR_TYPES, actorTypes);
  }
  if ( quantityPath && !getQuantityPath() ) {
    await game.settings.set(MODULE_ID, SETTINGS.QUANTITY_PATH, quantityPath);
  }
}

/**
 * Light a registered source on an Actor, exactly as clicking it in the Token HUD
 * would: the same consumption, the same duration, the same chat announcement, and
 * the same one-light-per-actor rule. Meant for a cost the module cannot express as
 * a quantity — a spell slot, a fatigue token, a resource only the game system knows
 * how to charge. The system charges it, then calls this; pair it with `hudHidden`
 * so the Token HUD cannot be used to skip the charge.
 *
 * The caller must be able to write to `actor`. Foundry refuses embedded document
 * creation on an Actor the current user does not own, so from a player's client this
 * reaches their own character and nothing else; from the GM's it reaches anyone.
 * Ownership is checked up front and reported as `false` rather than left to throw.
 * There is deliberately no relay that would let one player light another's actor.
 *
 * The GM's **Restrict Player Control** setting is not consulted here. It gates the
 * Token HUD palette, and this path is not the palette: whatever charged the light
 * has already run, and a caller can only ever reach an actor it already owns.
 * @param {Actor} actor The actor to light. Must be owned by the current user.
 * @param {string} uuid The registered source's `uuid`, or its internal `id` (a source
 *   the GM added by name has no uuid, and is only reachable by id).
 * @param {object} [options={}]
 * @param {string} [options.pattern] Name of the pattern to light. Defaults to the
 *   source's first pattern.
 * @returns {Promise<boolean>} True when the source is now lit.
 */
export async function activate(actor, uuid, { pattern } = {}) {
  if ( !actor ) {
    console.warn(`${MODULE_ID} | activate called without an actor.`);
    return false;
  }
  if ( !actor.isOwner ) {
    console.warn(`${MODULE_ID} | Cannot light "${actor.name}": the current user does not own that actor.`);
    return false;
  }

  const source = getSources().find(s => (s.uuid === uuid) || (s.id === uuid));
  if ( !source ) {
    console.warn(`${MODULE_ID} | No light source registered for "${uuid}".`);
    return false;
  }

  // Patterns are selected by name because that is what a caller registered them
  // under; internal ids are minted by this module and never travel outward.
  const target = pattern ? source.patterns.find(p => p.name === pattern) : source.patterns[0];
  if ( !target ) {
    console.warn(`${MODULE_ID} | Light source "${source.name}" has no pattern named "${pattern}".`);
    return false;
  }

  return activateLight(actor, source, target);
}

/**
 * Put out whatever light is burning on an Actor, exactly as the Token HUD's
 * extinguish control does. A no-op when nothing is lit.
 * @param {Actor} actor The actor whose light is extinguished.
 * @returns {Promise<void>}
 */
export async function deactivate(actor) {
  return deactivateLight(actor);
}

/**
 * Read what is currently burning on an Actor, so a caller can tell whether a light
 * is lit, which source and pattern it came from, and when it runs out.
 * @param {Actor} actor The actor to inspect.
 * @returns {object|null} The active light payload ({sourceId, patternId, patternName,
 *   itemName, mode, expiresAtWorld, expiresAtReal, stowed}), or null when unlit.
 */
export function getActive(actor) {
  return getActiveLight(actor);
}

/**
 * Move the light burning on an Item's actor to the ground, together with that Item —
 * for a module that carries Items off actors and onto the map (loot, a thrown
 * lantern). The light moves only when `item` is the very Item it burns on: a lit
 * lantern leaving takes its flame, a rope leaving takes nothing, and a light lit
 * from a consuming source never moves, since the item it spent is not the flame.
 *
 * Call it while `item` is still on its actor, then remove the Item. Removing it first
 * puts its light out, as any removal of a burning Item does.
 *
 * GM client only: only a GM can create an AmbientLight, and the caller needs the
 * created document back, which the player socket relay cannot return. The placed
 * light is left out of this module's Token HUD pickup and interactive control while
 * `managedBy` is active, burns out on its original schedule, and is handed back with
 * `pickupGroundLight`. Nothing is posted to chat.
 * @param {Item} item The Item about to leave its actor.
 * @param {object} where Where the light lands.
 * @param {Scene} where.scene The scene, which need not be the one being viewed.
 * @param {number} where.x The x coordinate of the light's centre.
 * @param {number} where.y The y coordinate of the light's centre.
 * @param {number} [where.elevation=0] The light's elevation.
 * @param {string[]} [where.levels=[]] The ids of the scene levels it belongs to.
 * @param {string} where.managedBy The id of the calling module or system.
 * @returns {Promise<AmbientLightDocument|null>} The placed light, or null when nothing moved.
 */
export async function dropLightWithItem(item, { scene, x, y, elevation = 0, levels = [], managedBy } = {}) {
  if ( !game.user.isGM ) {
    console.warn(`${MODULE_ID} | dropLightWithItem runs on a GM client only.`);
    return null;
  }
  if ( (item?.documentName !== "Item") || (item.parent?.documentName !== "Actor") ) {
    console.warn(`${MODULE_ID} | dropLightWithItem expected an Item still on its actor.`, item);
    return null;
  }
  if ( (scene?.documentName !== "Scene") || !Number.isFinite(x) || !Number.isFinite(y)
    || !Number.isFinite(elevation) || !Array.isArray(levels) ) {
    console.warn(`${MODULE_ID} | dropLightWithItem expected a scene and a finite x, y and elevation.`);
    return null;
  }
  if ( !managedBy || (typeof managedBy !== "string") ) {
    console.warn(`${MODULE_ID} | dropLightWithItem expected the calling package's id as managedBy.`);
    return null;
  }
  return dropItemLight(item, scene, { x, y, elevation, levels }, managedBy);
}

/**
 * Put a light placed by `dropLightWithItem` back on the actor carrying `item`,
 * burning on that Item with the time it had left. Call it once `item` is on the
 * picking actor — newly created, or the stack it merged into.
 *
 * The light always leaves the ground once found, even when it cannot be relit. A
 * light already burning on the actor is never replaced: the picked-up one stays unlit
 * and the Item can light it again from the Token HUD, for free, since only
 * non-consuming lights travel this way.
 *
 * GM client only, and silent: no chat and no notification, because the GM's client is
 * rarely the one whose user picked the Item up. The returned `reason` is for the
 * caller to tell its own user: `"missing"` (already gone from the scene),
 * `"sourceRemoved"`, `"burnedOut"`, `"occupied"`, or `"invalid"` for a refused call.
 * @param {Item} item The Item the light returns with, already on the picking actor.
 * @param {AmbientLightDocument} light The ground light `dropLightWithItem` returned.
 * @returns {Promise<{lit: boolean, reason: string|null}>} Whether the actor is now lit, and why not.
 */
export async function pickupGroundLight(item, light) {
  const refused = { lit: false, reason: PICKUP_REASONS.INVALID };
  if ( !game.user.isGM ) {
    console.warn(`${MODULE_ID} | pickupGroundLight runs on a GM client only.`);
    return refused;
  }
  if ( (item?.documentName !== "Item") || (item.parent?.documentName !== "Actor") ) {
    console.warn(`${MODULE_ID} | pickupGroundLight expected an Item on the picking actor.`, item);
    return refused;
  }
  // Only a light placed through the API: a Token HUD drop may be a consuming torch,
  // and the pickup's promise that nothing of value is lost holds for none of those.
  if ( (light?.documentName !== "AmbientLight") || !light.getFlag(MODULE_ID, FLAGS.GROUND_LIGHT)?.managedBy ) {
    console.warn(`${MODULE_ID} | pickupGroundLight expected a light placed by dropLightWithItem.`, light);
    return refused;
  }
  return pickupItemLight(item, light);
}
