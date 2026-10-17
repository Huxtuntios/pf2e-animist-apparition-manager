/**
 * Wandering Feats - retraining a wandering feat at the daily preparations.
 *
 * The rule: "When you make your daily preparations, you can retrain any
 * wandering feat you know for any other wandering feat available at the level
 * you took the exchanged feat (including lower-level wandering feats, as
 * usual). You must meet all the new feat's other prerequisites."
 *
 * So for a wandering feat taken at level L every animist wandering class feat
 * of level L or lower is offered. Some wandering feats need an attuned
 * apparition of a certain kind. That requirement is only written in the feat's
 * description, so it is kept as a list of SUITABLE APPARITIONS per feat:
 *
 * - for the feats of the system the list is worked out in advance from a
 *   table of the Lores each feat asks for (by exact compendium id): an
 *   apparition is suitable when it grants one of them;
 * - a GM can add apparitions to a feat's list or take them off it (module
 *   settings, `wanderingFeatRules`);
 * - a custom wandering feat has the apparitions its GM marked.
 *
 * A feat the character has whose list holds none of the apparitions it is
 * bonded to is marked, and such a feat cannot be picked (a GM may). The new
 * feat takes the old one's place and is permanent - it stays until it is
 * retrained again.
 */

import {
    MODULE_ID,
    requireActorOwner,
    getFeatSource,
    getApparitionKey,
    isAnimistClass,
    getBondedApparitionFeats,
    parseApparitionLores,
    formatLocalized,
    notifyOperationFailed,
} from "./apparition-fix.mjs";

// Packs searched for replacement feats (world feats are always included).
const FEAT_PACK_IDS = ["pf2e.feats-srd", "pf2e-anachronism.feats"];

// The Lores wandering feats ask for: display names, and the keys an apparition's
// Lore name is recognised by (English and the Russian translation's wording).
const LORES = {
    battlegrounds: { en: "Battlegrounds Lore", ru: "Знания полей битв", keys: ["battlegrounds", "полей битв"] },
    volcano: { en: "Volcano Lore", ru: "Знания вулканов", keys: ["volcano", "вулканов"] },
    mountain: { en: "Mountain Lore", ru: "Знания гор", keys: ["mountain", "гор"] },
    heraldry: { en: "Heraldry Lore", ru: "Знания геральдики", keys: ["heraldry", "геральдики"] },
    underworld: { en: "Underworld Lore", ru: "Знания преступного мира", keys: ["underworld", "преступного мира"] },
    hunting: { en: "Hunting Lore", ru: "Охотничьи знания", keys: ["hunting", "охотничьи"] },
    forest: { en: "Forest Lore", ru: "Знания лесов", keys: ["forest", "лесов"] },
    herbalism: { en: "Herbalism Lore", ru: "Знания травничества", keys: ["herbalism", "травничества"] },
    ocean: { en: "Ocean Lore", ru: "Знания океанов", keys: ["ocean", "океанов"] },
    circus: { en: "Circus Lore", ru: "Цирковые знания", keys: ["circus", "цирковые"] },
    fey: { en: "Fey Lore", ru: "Знания фей", keys: ["fey", "фей"] },
};

const featSources = (id) => [`Compendium.pf2e.feats-srd.Item.${id}`, `Compendium.pf2e-anachronism.feats.Item.${id}`];

// Wandering feats with a Lore requirement - any one of the listed Lores will do. The other wandering feats have none.
const LORE_REQUIREMENTS = new Map(
    [
        ["kRERboV7vHN6EiTt", ["battlegrounds", "volcano"]], // Blazing Spirit
        ["F6TIEmYYJGmVhMXl", ["mountain"]], // Roaring Heart
        ["ii7aCMN4WPQo3N3l", ["heraldry", "underworld"]], // Grudge Strike
        ["nBsd828H7AnVRV6r", ["hunting", "underworld"]], // Shadows Within Shadows
        ["2LjTxYTlRL7RwhOS", ["forest", "herbalism"]], // Forest's Heart
        ["VO2uOVrjIr7ZAjkX", ["forest", "ocean"]], // Monstrous Inclinations
        ["dzPwwXHW5NzYGG5h", ["circus", "fey"]], // Jester's Gambol
    ].flatMap(([id, lores]) => featSources(id).map((uuid) => [uuid, lores])),
);

let packFeatsPromise = null;

/**
 * The keys a Lore name is recognised by: lower case, without "Lore" / "Знания"
 * around it. The Russian translation names Lores twice, "Знания фей (Fey) Lore",
 * so the text outside and inside the brackets each give a key ("фей", "fey").
 *
 * @param {string} name
 * @returns {Set<string>}
 */
function loreKeys(name) {
    const clean = (part) =>
        part
            .toLowerCase()
            .replace(/ё/g, "е")
            .replace(/\s+/g, " ")
            .trim()
            .replace(/\s+lore$/, "")
            .replace(/^знани[яе]\s+/, "")
            .replace(/\s+знани[яе]$/, "")
            .trim();
    const text = String(name ?? "");
    const inside = [...text.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]);
    return new Set([text.replace(/\([^)]*\)/g, " "), ...inside].map(clean).filter(Boolean));
}

// The standard icon of a feat.
const DEFAULT_WANDERING_FEAT_IMG = "icons/sundries/books/book-red-exclamation.webp";

const RULES_SETTING = "wanderingFeatRules";
const CUSTOM_FLAG = "customWanderingFeat";
const MARKED_FLAG = "wanderingApparitions";

/** Wandering class feats of the compendium packs, indexed once. */
function loadPackWanderingFeats() {
    packFeatsPromise ??= (async () => {
        const feats = [];
        for (const packId of FEAT_PACK_IDS) {
            const pack = game.packs.get(packId);
            if (!pack) continue;
            try {
                const index = await pack.getIndex({ fields: ["system.traits.value", "system.category", "system.level.value"] });
                for (const entry of index) {
                    if (entry.type !== "feat" || entry.system?.category !== "class") continue;
                    const traits = entry.system?.traits?.value ?? [];
                    if (!traits.includes("animist") || !traits.includes("wandering")) continue;
                    feats.push(toCandidate(entry));
                }
            } catch (error) {
                console.error(`${MODULE_ID} | Failed to index feat pack ${packId}`, error);
            }
        }
        return feats;
    })().catch((error) => {
        console.error(`${MODULE_ID} | Failed to load wandering feats`, error);
        // Don't keep the failure: the next window tries again.
        packFeatsPromise = null;
        return [];
    });
    return packFeatsPromise;
}

const toCandidate = (entry) => ({
    uuid: entry.uuid,
    name: entry.name,
    img: entry.img,
    level: Number(entry.system?.level?.value) || 0,
});

/** @returns {Promise<{ uuid: string, name: string, img: string, level: number }[]>} Every animist wandering class feat: compendium and world. */
async function loadAllWanderingFeats() {
    const worldFeats = game.items
        .filter(
            (item) =>
                item.type === "feat" && item.system?.category === "class" && item.traits?.has("animist") && item.traits?.has("wandering"),
        )
        .map((item) => toCandidate(item));
    return [...(await loadPackWanderingFeats()), ...worldFeats];
}

// Wandering feats come at these levels. A feat of another level (a homebrew one) counts as the nearest
// of them below it, so it is never left out of the retraining list (level 8 counts as 6, level 18 as 16);
// below 6 it counts as its own level.
const STANDARD_LEVELS = [6, 12, 16];
const getAvailableLevel = (level) => STANDARD_LEVELS.filter((standard) => standard <= level).at(-1) ?? level;

// Always on a wandering feat; not offered in the tag picker.
const MANDATORY_TRAITS = ["animist", "wandering"];

/** @returns {{ value: string, label: string }[]} The feat traits a custom wandering feat can be given besides the two it always has. */
function getFeatTraitChoices() {
    return Object.entries(CONFIG.PF2E?.featTraits ?? {})
        .filter(([value]) => !MANDATORY_TRAITS.includes(value))
        .map(([value, labelKey]) => ({ value, label: game.i18n.localize(labelKey) }))
        .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

/** The level a feat was taken at - what decides which wandering feats it can be retrained into. */
const getTakenLevel = (feat) => Number(feat.system?.level?.taken ?? feat.system?.level?.value) || 0;

/** @returns {Item[]} The character's wandering feats, lowest level taken first. */
function getWanderingFeats(actor) {
    return (actor?.itemTypes?.feat ?? [])
        .filter((feat) => feat.traits?.has("wandering"))
        .sort((a, b) => getTakenLevel(a) - getTakenLevel(b) || a.name.localeCompare(b.name));
}

/** @returns {{ key: string, name: string, lores: string[] }[]} The apparitions the character is bonded to, with their Lores. */
function getBondedApparitions(actor) {
    return getBondedApparitionFeats(actor).map((feat) => ({
        key: getApparitionKey(feat),
        name: feat.name,
        lores: parseApparitionLores(feat),
    }));
}

/** @returns {string[]} The Lore names granted by the apparitions the character is bonded to, without repeats. */
function getApparitionLores(actor) {
    const lores = new Map();
    for (const apparition of getBondedApparitions(actor)) {
        for (const name of apparition.lores) lores.set([...loreKeys(name)].sort().join("|"), name);
    }
    return [...lores.values()];
}

/* -------------------------------------------- */
/*  Which apparitions suit a wandering feat     */
/* -------------------------------------------- */

const getWorldFeat = (uuid) => game.items.find((item) => item.uuid === uuid) ?? null;

/** @returns {Record<string, { added?: string[], removed?: string[] }>} The GM's changes to the lists, by feat uuid. */
function getRules() {
    const rules = game.settings.get(MODULE_ID, RULES_SETTING);
    return rules && typeof rules === "object" ? rules : {};
}

/** The Lore ids the table asks for (empty for a feat with none). */
const getRequiredLoreIds = (featUuid) => LORE_REQUIREMENTS.get(featUuid) ?? [];

const getLoreName = (id) => (game.i18n.lang?.startsWith("ru") ? LORES[id].ru : LORES[id].en);

/** Whether one of the table's Lores for the feat is among the given Lore names. */
function loresSatisfyTable(featUuid, loreNames) {
    const have = new Set(loreNames.flatMap((name) => [...loreKeys(name)]));
    return getRequiredLoreIds(featUuid).some((id) => LORES[id].keys.some((key) => have.has(key)));
}

/**
 * What changes a feat's list of suitable apparitions.
 *
 * @param {string} featUuid
 * @returns {{ added: Set<string>, removed: Set<string>, marked: Set<string>, custom: boolean }}
 *   `added` / `removed`: the GM's changes to a system feat; `marked`: the apparitions of a custom feat.
 */
function getFeatRule(featUuid) {
    const rule = getRules()[featUuid];
    const world = getWorldFeat(featUuid);
    const custom = !!world?.getFlag(MODULE_ID, CUSTOM_FLAG);
    return {
        added: new Set(rule?.added ?? []),
        removed: new Set(rule?.removed ?? []),
        marked: new Set(custom ? (world.getFlag(MODULE_ID, MARKED_FLAG) ?? []) : []),
        custom,
    };
}

/** Whether the apparition suits the feat: one the GM added or marked, else one the Lore table accepts, unless the GM took it off. */
function isSuitable(featUuid, apparition) {
    const { added, removed, marked } = getFeatRule(featUuid);
    if (added.has(apparition.key) || marked.has(apparition.key)) return true;
    if (removed.has(apparition.key)) return false;
    return loresSatisfyTable(featUuid, apparition.lores);
}

/** A feat asks for an attuned apparition when the table lists it, or the GM named apparitions for it. */
function hasRequirement(featUuid) {
    const { added, marked } = getFeatRule(featUuid);
    return getRequiredLoreIds(featUuid).length > 0 || added.size > 0 || marked.size > 0;
}

/**
 * Whether a character bonded to these apparitions meets a feat's requirement.
 *
 * @param {string} featUuid
 * @param {{ key: string, name: string, lores: string[] }[]} bonded
 * @returns {{ hasRequirement: boolean, met: boolean, qualifying: string[] }}
 */
function evaluateRequirement(featUuid, bonded) {
    const required = hasRequirement(featUuid);
    const qualifying = required ? bonded.filter((apparition) => isSuitable(featUuid, apparition)).map((apparition) => apparition.name) : [];
    return { hasRequirement: required, met: !required || qualifying.length > 0, qualifying };
}

/** The requirement in words: the Lores of the table and/or the apparitions named for the feat. */
function describeRequirement(featUuid, names) {
    const parts = [];
    const loreIds = getRequiredLoreIds(featUuid);
    if (loreIds.length)
        parts.push(
            formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.RequiresOneOf`, { lores: loreIds.map(getLoreName).join(" / ") }),
        );

    const { added, marked } = getFeatRule(featUuid);
    const named = [...new Set([...added, ...marked])].map((key) => names.get(key) ?? key.split(".").pop());
    if (named.length) {
        const shown = named.slice(0, 5).join(", ") + (named.length > 5 ? ` +${named.length - 5}` : "");
        parts.push(formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.RequiresApparitions`, { apparitions: shown }));
    }
    return parts.length ? parts.join("; ") : game.i18n.localize(`${MODULE_ID}.ManageApparitions.Wandering.NoLoreRequirement`);
}

/**
 * Add an apparition to a feat's list of suitable ones, or take it off.
 *
 * @param {string} featUuid
 * @param {{ key: string, lores: string[] }} apparition
 * @param {boolean} suitable
 */
async function setApparitionSuitable(featUuid, apparition, suitable) {
    if (!game.user.isGM) return;
    const world = getWorldFeat(featUuid);
    if (world?.getFlag(MODULE_ID, CUSTOM_FLAG)) {
        const marked = new Set(world.getFlag(MODULE_ID, MARKED_FLAG) ?? []);
        if (suitable) marked.add(apparition.key);
        else marked.delete(apparition.key);
        await world.setFlag(MODULE_ID, MARKED_FLAG, [...marked]);
        return;
    }

    const rules = foundry.utils.deepClone(getRules());
    const { added, removed } = getFeatRule(featUuid);
    const byTable = loresSatisfyTable(featUuid, apparition.lores);
    if (suitable) {
        removed.delete(apparition.key);
        if (!byTable) added.add(apparition.key);
    } else {
        added.delete(apparition.key);
        if (byTable) removed.add(apparition.key);
    }
    if (added.size || removed.size) rules[featUuid] = { added: [...added], removed: [...removed] };
    else delete rules[featUuid];
    await game.settings.set(MODULE_ID, RULES_SETTING, rules);
}

/** Forget the GM's changes to a system feat's list (back to what the Lore table gives). */
async function resetFeatRule(featUuid) {
    if (!game.user.isGM) return;
    const rules = foundry.utils.deepClone(getRules());
    delete rules[featUuid];
    await game.settings.set(MODULE_ID, RULES_SETTING, rules);
}

/* -------------------------------------------- */
/*  Custom wandering feats                      */
/* -------------------------------------------- */

/**
 * Create or update a custom wandering feat: an ordinary world class feat with
 * the animist and wandering traits, which the retraining offers like any
 * other, together with the apparitions it asks for.
 *
 * @param {{ item?: Item|null, name: string, img?: string, level: number, description?: string, apparitions: string[], traits?: string[] }} data
 *   `traits`: the extra feat traits; "animist" and "wandering" are always applied, and traits of an edited feat
 *   that the tag picker cannot show are kept.
 * @returns {Promise<Item>}
 */
async function saveCustomWanderingFeat({ item = null, name, img, level, description = "", apparitions, traits = [] }) {
    const html = description
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => `<p>${foundry.utils.escapeHTML(line)}</p>`)
        .join("");
    const system = { level: { value: Math.min(20, Math.max(1, Number(level) || 1)) }, description: { value: html } };
    const flags = { [MODULE_ID]: { [CUSTOM_FLAG]: true, [MARKED_FLAG]: [...new Set(apparitions)] } };
    const pickable = new Set(getFeatTraitChoices().map((choice) => choice.value));
    const kept = (item?.system?.traits?.value ?? []).filter((trait) => !MANDATORY_TRAITS.includes(trait) && !pickable.has(trait));
    const traitValue = [...new Set([...MANDATORY_TRAITS, ...traits.filter((trait) => !MANDATORY_TRAITS.includes(trait)), ...kept])];
    if (item) {
        await item.update({ name, ...(img ? { img } : {}), system: { ...system, traits: { value: traitValue } }, flags });
        return item;
    }
    return Item.create({
        name,
        img: img || DEFAULT_WANDERING_FEAT_IMG,
        type: "feat",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        system: { ...system, category: "class", traits: { value: traitValue, rarity: "common" }, rules: [] },
        flags,
    });
}

/**
 * What the management window shows for Wandering Feats: the Lores of the
 * character's apparitions and, per wandering feat, its requirement and the
 * feats it can be retrained into. Shown for an Animist (by class id) or any
 * character that has a wandering feat.
 *
 * @param {Actor} actor
 * @param {{ names?: Map<string, string> }} [options] Names of apparitions by key, for naming the ones a feat asks for.
 * @returns {Promise<{ show: boolean, lores: string[], rows: object[], unmet: string[] }>}
 */
async function getWanderingContext(actor, { names = new Map() } = {}) {
    const feats = getWanderingFeats(actor);
    if (!isAnimistClass(actor) && !feats.length) return { show: false, lores: [], rows: [], unmet: [] };

    const bonded = getBondedApparitions(actor);
    const isGM = game.user.isGM;
    const all = feats.length ? await loadAllWanderingFeats() : [];
    const owned = new Set(actor.itemTypes.feat.map(getFeatSource));
    const levelOf = (level) => formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.OptionLevel`, { level });
    const known = new Map([...names, ...bonded.map((apparition) => [apparition.key, apparition.name])]);

    const rows = feats.map((feat) => {
        const taken = getTakenLevel(feat);
        const current = getFeatSource(feat) ?? "";
        const requirement = evaluateRequirement(current, bonded);

        // Any wandering feat available at the level this one was taken, lower levels included.
        const seen = new Set();
        const candidates = all
            .filter((option) => getAvailableLevel(option.level) <= taken && (option.uuid === current || !owned.has(option.uuid)))
            .filter((option) => !seen.has(option.uuid) && seen.add(option.uuid))
            .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
        if (!seen.has(current))
            candidates.unshift({ uuid: current, name: feat.name, img: feat.img, level: Number(feat.system?.level?.value) || taken });

        const options = candidates.map((option) => {
            const optionRequirement = evaluateRequirement(option.uuid, bonded);
            return {
                uuid: option.uuid,
                label: `${option.name} (${levelOf(option.level)})${optionRequirement.met ? "" : " ⚠"}`,
                selected: option.uuid === current,
                met: optionRequirement.met,
                // A requirement no bonded apparition meets blocks the choice (a GM may override).
                disabled: !optionRequirement.met && option.uuid !== current && !isGM,
                requirement: describeRequirement(option.uuid, known),
            };
        });
        const selected = options.find((option) => option.selected);

        return {
            id: feat.id,
            name: feat.name,
            img: feat.img,
            sourceUuid: current,
            levelLabel: formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.Level`, { level: taken }),
            hasRequirement: requirement.hasRequirement,
            requirementUnmet: !requirement.met,
            requirementText: describeRequirement(current, known),
            qualifying: requirement.qualifying,
            options,
            hasChoice: options.length > 1,
            selectedRequirement: selected?.requirement ?? "",
            selectedMet: selected?.met ?? true,
        };
    });
    return { show: true, lores: getApparitionLores(actor), rows, unmet: rows.filter((row) => row.requirementUnmet).map((row) => row.name) };
}

const link = (uuid, name) => (uuid ? `@UUID[${uuid}]{${foundry.utils.escapeHTML(name)}}` : foundry.utils.escapeHTML(name));

/**
 * Retrains a wandering feat into another one: the new feat is created in the
 * old one's place - same `system.location`, same `level.taken`, same granting
 * feature - and the old feat is deleted; a chat message records the change.
 *
 * @param {Actor} actor
 * @param {string} featId The character's wandering feat to replace.
 * @param {string} uuid The feat to take its place.
 * @returns {Promise<Item|null>} The new feat, or null when nothing changed.
 */
async function replaceWanderingFeat(actor, featId, uuid) {
    if (!requireActorOwner(actor)) return null;

    try {
        const original = actor.items.get(featId);
        if (!original?.isOfType?.("feat") || !original.traits?.has("wandering") || !uuid) return null;
        if (getFeatSource(original) === uuid) return null;

        const replacement = await fromUuid(uuid);
        const valid =
            replacement?.isOfType?.("feat") &&
            replacement.system?.category === "class" &&
            replacement.traits?.has("animist") &&
            replacement.traits?.has("wandering") &&
            getAvailableLevel(Number(replacement.system?.level?.value)) <= getTakenLevel(original);
        if (!valid) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.ManageApparitions.Wandering.Invalid`));
            return null;
        }

        if (!evaluateRequirement(uuid, getBondedApparitions(actor)).met && !game.user.isGM) {
            ui.notifications.warn(formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.LoreUnmet`, { feat: replacement.name }));
            return null;
        }

        const source = replacement.toObject();
        delete source._id;
        foundry.utils.setProperty(source, "_stats.compendiumSource", replacement.uuid);
        foundry.utils.setProperty(source, "system.location", original.system.location);
        foundry.utils.setProperty(source, "system.level.taken", original.system.level.taken);

        // Whatever granted the old feat (if anything) grants the new one.
        const parent = actor.items.get(original.flags?.pf2e?.grantedBy?.id);
        if (parent) foundry.utils.setProperty(source, "flags.pf2e.grantedBy", { id: parent.id, onDelete: "cascade" });

        const [created] = await actor.createEmbeddedDocuments("Item", [source]);
        await actor.deleteEmbeddedDocuments("Item", [original.id]);

        if (parent) {
            const sluggify = game.pf2e?.system?.sluggify;
            const grants = parent.flags?.pf2e?.itemGrants ?? {};
            for (const [slug, grant] of Object.entries(grants)) {
                if (grant?.id === original.id) await parent.unsetFlag("pf2e", `itemGrants.${slug}`);
            }
            if (typeof sluggify === "function") {
                const base = sluggify(created.name, { camel: "dromedary" });
                let slug = base;
                for (let n = 2; grants[slug] && grants[slug].id !== original.id; n++) slug = `${base}${n}`;
                await parent.setFlag("pf2e", `itemGrants.${slug}`, { id: created.id, onDelete: "detach" });
            }
        }

        const oldLink = link(getFeatSource(original), original.name);
        const newLink = link(replacement.uuid, replacement.name);
        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<p>${formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.Chat`, { old: oldLink, new: newLink })}</p>`,
        });
        ui.notifications.info(
            formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.Replaced`, { old: original.name, new: replacement.name }),
        );
        return created;
    } catch (error) {
        notifyOperationFailed(error);
        return null;
    }
}

export {
    DEFAULT_WANDERING_FEAT_IMG,
    MANDATORY_TRAITS,
    getFeatTraitChoices,
    getWanderingContext,
    replaceWanderingFeat,
    loadAllWanderingFeats,
    saveCustomWanderingFeat,
    getFeatRule,
    isSuitable,
    getRequiredLoreIds,
    getLoreName,
    setApparitionSuitable,
    resetFeatRule,
};
