/**
 * Pf2e Animist Apparition Manager - core module.
 *
 * Runs the Pathfinder 2e Animist on its own: the Apparition Spellcasting and
 * Vessel Spells entries, bonding and unbonding of apparitions, the primary
 * set, the focus pool, the cast-rank picker and the nightly cleanup. The
 * custom-apparition editor, the management window and Wandering Feats live in
 * their own files and import from here.
 *
 * pf2e-dailies is not required. When it is installed, only its own Animist
 * daily (and, for an Animist, its Wandering Feats daily) is switched off for
 * the characters this module handles.
 */

const MODULE_ID = "pf2e-dailies-apparition-fix";
const DAILIES_ID = "pf2e-dailies";

// Flags on the actor, in this module's namespace.
const PRIMARY_APPARITIONS_FLAG = "primaryApparitions";
const PROFILES_FLAG = "apparitionProfiles";
const LAST_DAY_FLAG = "lastDayApparitions";
const AUTO_PRIMARY_FLAG = "autoPrimary";
const ORIGIN_FLAG = "origin";
const LORE_RULE_PATHS_FLAG = "apparitionLoreRulePaths";

// The only data this module writes into the Dailies namespace is its per-actor
// "switch this daily off" flag. Dailies flattens the `disabled` object into
// daily keys: the Animist daily is "dailies.animist", Wandering Feats is
// "dailies.wandering".
const DAILIES_ANIMIST_DISABLE_PATH = "disabled.dailies.animist";
const DAILIES_WANDERING_DISABLE_PATH = "disabled.dailies.wandering";
const DAILIES_ISOLATION_PREVIOUS_FLAG = "dailiesIntegration.previousDisabled";

// Data written by pre-release builds. It is only read or removed, never written.
const DAILIES_MIRRORED_PATHS = ["dailies.animist", "extra.dailies.animist.primaryVessels"];
const LEGACY_ISOLATION_PREVIOUS_FLAG = "dailiesIntegration.previousAnimistDisabled";
const MIRROR_CLEARED_FLAG = "dailiesMirrorCleared";
// A world-level Lore skill registry from pre-release builds. PF2e 8.6+ creates
// Rule Element-backed Lore skills from the item rule itself, and a globally
// registered skill would outlive its apparition, so the setting is only kept
// in order to be emptied.
const LORE_SKILLS_SETTING = "apparitionLoreSkillRegistry";

const dailiesIsolationActors = new Set();

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

Hooks.once("init", () => {
    installAvatarsHookInterceptor();
    game.settings.register(MODULE_ID, LORE_SKILLS_SETTING, {
        name: `${MODULE_ID}.Settings.LoreSkillRegistry.Name`,
        hint: `${MODULE_ID}.Settings.LoreSkillRegistry.Hint`,
        scope: "world",
        config: false,
        type: Object,
        default: {},
    });

    game.settings.register(MODULE_ID, "enabled", {
        name: `${MODULE_ID}.Settings.Enabled.Name`,
        hint: `${MODULE_ID}.Settings.Enabled.Hint`,
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
        onChange: () => void syncDailiesIsolationForWorldActors().catch((error) => logError("Dailies isolation refresh failed", error)),
    });

    game.settings.register(MODULE_ID, "apparitionIdentifier", {
        name: `${MODULE_ID}.Settings.Identifier.Name`,
        hint: `${MODULE_ID}.Settings.Identifier.Hint`,
        scope: "world",
        config: true,
        type: String,
        default: "animist-spontaneous",
    });

    game.settings.register(MODULE_ID, "vesselIdentifier", {
        name: `${MODULE_ID}.Settings.VesselIdentifier.Name`,
        hint: `${MODULE_ID}.Settings.VesselIdentifier.Hint`,
        scope: "world",
        config: true,
        type: String,
        default: "animist-focus",
    });

    game.settings.register(MODULE_ID, AUTO_PRIMARY_FLAG, {
        name: `${MODULE_ID}.Settings.AutoPrimary.Name`,
        hint: `${MODULE_ID}.Settings.AutoPrimary.Hint`,
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
    });
});

Hooks.once("ready", async () => {
    if (game.system.id !== "pf2e") return;

    // PF2e Avatars: load its form catalogue so the Avatar spell can offer the
    // forms of the primary apparitions (see "PF2e Avatars compatibility").
    await installAvatarsBridge();

    // Convert data written by pre-release builds (once per actor). The Dailies
    // namespace is only read here; it is not a runtime dependency.
    try {
        await migrateLegacyDailiesState();
    } catch (error) {
        logError("legacy migration failed", error);
    }

    try {
        await clearLegacyLoreSkillRegistry();
        await migrateApparitionLoresToRuleElements();
    } catch (error) {
        logError("Lore Rule Element migration failed", error);
    }

    try {
        await syncDailiesIsolationForWorldActors();
    } catch (error) {
        logError("Dailies isolation initialization failed", error);
    }

    game.modules.get(MODULE_ID).api = {
        ...game.modules.get(MODULE_ID).api,
        openCastDialog,
        getApparitionEntry,
        getVesselEntry,
        actorCanModify,
        actorHasApparitionAccess,
        addApparition,
        removeApparition,
        diagnose,
        getPrimaryVesselState,
        setPrimaryVessel,
        isAutoPrimaryEnabled,
        setAutoPrimaryEnabled,
        getApparitionProfiles,
        saveApparitionProfile,
        deleteApparitionProfile,
        applyApparitionProfile,
        getLastDayApparitionSnapshot,
        restoreLastDayApparitions,
        repairApparitionActor,
        fixCurrentAnimist: repairApparitionActor,
        getManagedOrigin,
        getFocusPointsOverride,
        setFocusPointsOverride,
        getApparitionState,
        migrateLegacyDailiesState,
        migrateApparitionLoresToRuleElements,
        syncDailiesIsolation,
        getPermanentApparition,
        setPermanentApparition,
    };
});

function isEnabled() {
    return game.settings.get(MODULE_ID, "enabled");
}

function getApparitionIdentifier() {
    return game.settings.get(MODULE_ID, "apparitionIdentifier");
}

function getVesselIdentifier() {
    return game.settings.get(MODULE_ID, "vesselIdentifier");
}

const ERROR_PREFIX = `${MODULE_ID} |`;

function logError(context, error) {
    console.error(`${ERROR_PREFIX} ${context}`, error);
}

function actorCanModify(actor) {
    return !!actor && (game.user?.isGM || actor.isOwner);
}

function requireActorOwner(actor) {
    if (actorCanModify(actor)) return true;
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NotOwner`));
    return false;
}

/**
 * Foundry's file browser class. Looked up when needed, because where it
 * lives depends on the Foundry version.
 *
 * @returns {typeof foundry.applications.apps.FilePicker|null}
 */
function getFilePickerClass() {
    const candidates = [
        foundry.applications.apps?.FilePicker?.implementation,
        foundry.applications.apps?.FilePicker,
        CONFIG.ux?.FilePicker,
    ];
    return candidates.find((candidate) => typeof candidate === "function") ?? null;
}

/**
 * Localize a string with `{placeholders}`. Foundry v14 folds interpolation into
 * localization (the PF2e system itself calls the global `_loc(key, data)`),
 * whereas on v13 `localize()` ignores its data argument and only
 * `game.i18n.format()` interpolates - so the newer call is used when it exists
 * and `format()` otherwise, and the manifest's v13 minimum keeps working.
 *
 * @param {string} key
 * @param {Record<string, string|number>} data
 * @returns {string}
 */
function formatLocalized(key, data) {
    return typeof _loc === "function" ? _loc(key, data) : game.i18n.format(key, data);
}

function notifyOperationFailed(error) {
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.Notify.OperationFailed`));
    logError("operation failed", error);
}

// Shared with the two windows: icon paths that 404 fall back to this image.
const FALLBACK_ICON = "systems/pf2e/icons/default-icons/mystery-man.svg";

/**
 * Click listener for every element matching `selector` under `root`.
 *
 * @param {HTMLElement} root
 * @param {string} selector
 * @param {(element: HTMLElement, event: MouseEvent) => void} callback
 */
function addListenerAll(root, selector, callback) {
    for (const element of root.querySelectorAll(selector)) {
        element.addEventListener("click", (event) => callback(element, event));
    }
}

/**
 * Swaps any broken (404) icon inside `root` for the fallback image. `error`
 * doesn't bubble, hence the capturing listener on the container; the
 * `data-` mark keeps a broken fallback from looping.
 *
 * @param {HTMLElement} root
 */
function attachIconFallback(root) {
    root.addEventListener(
        "error",
        (event) => {
            const img = event.target;
            if (!(img instanceof HTMLImageElement) || img.dataset.fallbackApplied) return;
            img.dataset.fallbackApplied = "true";
            img.src = FALLBACK_ICON;
        },
        true,
    );
}

/* -------------------------------------------- */
/*  Diagnostics                                 */
/* -------------------------------------------- */

/**
 * Reports the standalone module's Animist prerequisites, entries, bonded
 * apparitions, primary state, focus settings, and available system/custom
 * apparitions. It also reports compendium entries that lack `system.traits`
 * because those are not safe to inspect as normal PF2e Items.
 * Run from the console: `await game.modules.get("pf2e-dailies-apparition-fix").api.diagnose(actor)`.
 *
 * @param {Actor} actor
 */
async function diagnose(actor) {
    const packIds = ["pf2e.classfeatures", "pf2e-anachronism.class-features"];
    const packReports = [];
    let apparitionCount = 0;
    let entriesWithoutTraits = [];

    for (const packId of packIds) {
        const pack = game.packs.get(packId);
        if (!pack) continue;
        try {
            const index = await pack.getIndex({ fields: ["system.traits", "system.traits.otherTags"] });
            const apparitions = index.filter(
                (entry) => entry.type === "feat" && entry.system?.traits?.otherTags?.includes("animist-apparition"),
            );
            const missing = index
                .filter((entry) => entry.type === "feat" && !entry.system?.traits)
                .map((entry) => ({ name: entry.name, uuid: entry.uuid }));
            apparitionCount += apparitions.length;
            entriesWithoutTraits.push(...missing);
            packReports.push({ pack: packId, apparitions: apparitions.length, entriesWithoutTraits: missing.length });
        } catch (error) {
            logError(`diagnose: failed to index ${packId}`, error);
            packReports.push({ pack: packId, error: String(error) });
        }
    }

    // A custom apparition is "unresolvable" when a spell or the Vessel it links to no longer exists.
    const customApparitions = [];
    const unresolvableHomebrew = [];
    for (const item of game.items.filter((entry) => entry.type === "feat" && entry.getFlag(MODULE_ID, "customApparition"))) {
        const linked = [...parseApparitionSpellUuids(item), parseApparitionVesselUuid(item)].filter(Boolean);
        const missing = [];
        for (const uuid of linked) {
            if (!(await fromUuid(uuid).catch(() => null))) missing.push(uuid);
        }
        customApparitions.push({ uuid: item.uuid, name: item.name, resolves: missing.length === 0 });
        if (missing.length) unresolvableHomebrew.push({ id: item.uuid, name: item.name, missing });
    }

    const managedActorItems = actor
        ? [...actor.itemTypes.feat, ...actor.itemTypes.spell, ...actor.itemTypes.lore]
              .filter(
                  (item) =>
                      getManagedOrigin(item) ||
                      getSpellApparitionSources(item).length > 0 ||
                      hasApparitionIdentifier(item.flags) ||
                      hasVesselIdentifier(item.flags),
              )
              .map((item) => ({
                  id: item.id,
                  type: item.type,
                  name: item.name,
                  origin: getManagedOrigin(item),
                  claims: getSpellApparitionSources(item),
                  temporary: isTemporary(item),
              }))
        : [];

    const report = {
        moduleActive: !!game.modules.get(MODULE_ID)?.active,
        actor: actor ? { id: actor.id, name: actor.name, canBondApparitions: actorHasApparitionAccess(actor) } : null,
        apparitionSpellcastingEntry: actor ? (getApparitionEntry(actor)?.id ?? null) : null,
        vesselSpellsEntry: actor ? (getVesselEntry(actor)?.id ?? null) : null,
        bondedApparitions: actor
            ? getBondedApparitionFeats(actor).map((item) => ({ id: item.id, key: getApparitionKey(item), name: item.name }))
            : [],
        primaryApparitions: actor ? getPrimaryVesselState(actor) : null,
        focusMaximum: actor?.system?.resources?.focus?.max ?? null,
        focusOverride: actor ? getFocusPointsOverride(actor) : null,
        permanentApparition: (() => {
            const permanent = getPermanentApparition(actor);
            return {
                hasFeat: permanent.available,
                key: permanent.key,
                bonded: !!permanent.key && getBondedApparitionFeats(actor).some((feat) => getApparitionKey(feat) === permanent.key),
            };
        })(),
        featureSpells: FEATURE_SPELLS.map((definition) => ({
            feature: definition.key,
            present: !!findFeature(actor, definition),
            spells: definition.spells.map((uuid) => ({
                uuid,
                onActor: !!(getApparitionEntry(actor) && findEntrySpellBySource(getApparitionEntry(actor), uuid, hasApparitionIdentifier)),
            })),
        })),
        dailiesIntegration:
            actor && isDailiesActive()
                ? {
                      active: true,
                      animistDisabled: actor.getFlag(DAILIES_ID, DAILIES_ANIMIST_DISABLE_PATH) === true,
                      wanderingDisabled: actor.getFlag(DAILIES_ID, DAILIES_WANDERING_DISABLE_PATH) === true,
                      // Flags from pre-release builds that make Dailies' sheet strike out Vessels.
                      staleMirroredFlags: DAILIES_MIRRORED_PATHS.filter((path) => actor.getFlag(DAILIES_ID, path) !== undefined),
                  }
                : { active: false },
        apparitionCount,
        packReports,
        entriesWithoutTraits,
        customApparitions,
        unresolvableHomebrew,
        managedActorItems,
        profileCount: actor ? getApparitionProfiles(actor).length : 0,
        hasLastDaySnapshot: actor ? !!getLastDayApparitionSnapshot(actor)?.apparitions.length : false,
        autoPrimary: isAutoPrimaryEnabled(),
    };

    console.log(`${ERROR_PREFIX} diagnose`, report);
    return report;
}

/* -------------------------------------------- */
/*  Apparition spells are never Signature       */
/* -------------------------------------------- */

/**
 * A spell counts as belonging to this module's Apparition Spellcasting entry
 * when its own module namespace carries the configured entry identifier.
 */
function hasApparitionIdentifier(flagsSource) {
    const identifier = foundry.utils.getProperty(flagsSource ?? {}, `${MODULE_ID}.identifier`);
    return identifier === getApparitionIdentifier();
}

/**
 * Same idea as `hasApparitionIdentifier`, but for the separate Vessel
 * Spells (focus) entry.
 */
function hasVesselIdentifier(flagsSource) {
    const identifier = foundry.utils.getProperty(flagsSource ?? {}, `${MODULE_ID}.identifier`);
    return identifier === getVesselIdentifier();
}

const SIGNATURE_PATH = "system.location.signature";

Hooks.on("preCreateItem", (item, data) => {
    if (!isEnabled() || game.system.id !== "pf2e") return;
    if (data.type !== "spell") return;
    if (!hasApparitionIdentifier(data.flags)) return;

    if (foundry.utils.getProperty(data, SIGNATURE_PATH)) {
        item.updateSource({ [SIGNATURE_PATH]: false });
    }
});

// Keep these spells non-Signature even if an external edit or migration tries to set it.
Hooks.on("preUpdateItem", (item, changes) => {
    if (!isEnabled() || game.system.id !== "pf2e") return;
    if (item.type !== "spell") return;
    if (!hasApparitionIdentifier(item.flags)) return;

    if (SIGNATURE_PATH in changes) {
        if (changes[SIGNATURE_PATH] === true) changes[SIGNATURE_PATH] = false;
    } else if (foundry.utils.getProperty(changes, SIGNATURE_PATH) === true) {
        foundry.utils.setProperty(changes, SIGNATURE_PATH, false);
    }
});

/* -------------------------------------------- */
/*  Spellcasting entries                        */
/* -------------------------------------------- */

/**
 * @param {Actor} actor
 * @returns {object|null} The SpellcastingEntryPF2e for Apparition Spellcasting, or null.
 */
function getApparitionEntry(actor) {
    if (!actor?.spellcasting) return null;
    return actor.spellcasting.find((entry) => hasApparitionIdentifier(entry.flags)) ?? null;
}

/**
 * @param {Actor} actor
 * @returns {object|null} The SpellcastingEntryPF2e for Vessel Spells (focus), or null.
 */
function getVesselEntry(actor) {
    if (!actor?.spellcasting) return null;
    return actor.spellcasting.find((entry) => hasVesselIdentifier(entry.flags)) ?? null;
}

/* -------------------------------------------- */
/*  Character sheet integration                 */
/* -------------------------------------------- */

const CUSTOM_ACTION = "apparition-fix-cast-spell";

/**
 * The character sheet is still an Application V1 sheet, so its render hook
 * hands over an array-like wrapper rather than an element. The helper simply
 * unwraps the first HTMLElement without relying on an external library.
 *
 * @param {HTMLElement|ArrayLike<HTMLElement>} html
 * @returns {HTMLElement|null}
 */
function getSheetRoot(html) {
    if (html instanceof HTMLElement) return html;
    return html?.[0] instanceof HTMLElement ? html[0] : null;
}

// Apparition Attunement (Animist class feature) and Animist Dedication: a
// character needs one of them to bond apparitions.
const APPARITION_ATTUNEMENT = {
    slug: "apparition-attunement",
    sources: ["Compendium.pf2e.classfeatures.Item.AHMjKkIx21AoMc9W", "Compendium.pf2e-anachronism.class-features.Item.AHMjKkIx21AoMc9W"],
};
const ANIMIST_DEDICATION = {
    slug: "animist-dedication",
    sources: ["Compendium.pf2e.feats-srd.Item.5hFFM5TmhKYSQwtG", "Compendium.pf2e-anachronism.feats.Item.5hFFM5TmhKYSQwtG"],
};

/** @returns {string|undefined} The compendium UUID a feat was copied from. */
function getFeatSource(feat) {
    return feat._stats?.compendiumSource ?? feat._stats?.duplicateSource ?? feat.sourceId;
}

/**
 * The actor's feat for a feature. A definition with a `slug` also matches by
 * slug (Attunement / Dedication / Medium); one without is matched by its
 * compendium source id only, never by name.
 *
 * @param {Actor} actor
 * @param {{ slug?: string, sources: string[] }} feature
 * @returns {Item|undefined}
 */
function findFeature(actor, { slug, sources }) {
    return (actor?.itemTypes?.feat ?? []).find(
        (feat) => (slug !== undefined && feat.slug === slug) || sources.includes(getFeatSource(feat)),
    );
}

/**
 * Whether the actor can bond apparitions at all (Animist, or the dedication),
 * regardless of whether its Apparition Spellcasting entry exists yet:
 * `addApparition` creates that entry on demand, so requiring it here would
 * hide the bond button exactly when it is needed.
 *
 * @param {Actor} actor
 * @returns {boolean}
 */
function actorHasApparitionAccess(actor) {
    return !!(findFeature(actor, APPARITION_ATTUNEMENT) ?? findFeature(actor, ANIMIST_DEDICATION));
}

/**
 * The spell a sheet control (Cast button, signature star) belongs to, but
 * only when that spell is on the given entry. The system's own `cast-spell`
 * and `toggle-signature-spell` handlers read `itemId` / `entryId` from the
 * closest `[data-item-id]` element, and so does this; when the row has no
 * `entryId`, the enclosing `[data-container-id]` identifies the entry.
 *
 * @param {Actor} actor
 * @param {object} entry The Apparition Spellcasting entry.
 * @param {HTMLElement} control
 * @returns {Item|null}
 */
function getEntrySpellForControl(actor, entry, control) {
    const spellEl = control.closest("[data-item-id]");
    const spellId = spellEl?.dataset.itemId;
    if (!spellId) return null;

    const entryId = spellEl.dataset.entryId ?? control.closest("[data-container-id]")?.dataset.containerId;
    if (entryId !== entry.id) return null;

    const spell = entry.spells?.get(spellId) ?? actor.items.get(spellId);
    return spell?.isOfType?.("spell") ? spell : null;
}

Hooks.on("renderCharacterSheetPF2e", (app, html) => {
    if (!isEnabled() || game.system.id !== "pf2e") return;

    const actor = app.actor ?? app.document;
    const root = getSheetRoot(html);
    if (!root) return;

    const entry = getApparitionEntry(actor);
    if (entry) {
        for (const castButton of root.querySelectorAll('[data-action="cast-spell"], button.cast-spell')) {
            if (!(castButton instanceof HTMLElement) || castButton.dataset.apparitionFixBound === "true") continue;

            const spell = getEntrySpellForControl(actor, entry, castButton);
            if (!spell || spell.isCantrip) continue;

            castButton.dataset.apparitionFixBound = "true";
            castButton.dataset.action = CUSTOM_ACTION;
            castButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                openCastDialog(entry, spell).catch(notifyOperationFailed);
            });
        }

        // The "toggle signature spell" star would bring the per-rank rows back.
        for (const star of root.querySelectorAll('[data-action="toggle-signature-spell"]')) {
            if (!(star instanceof HTMLElement)) continue;
            const spell = getEntrySpellForControl(actor, entry, star);
            if (spell && !spell.isCantrip) star.remove();
        }
    }

    const vesselEntry = getVesselEntry(actor);
    if (vesselEntry) decorateVesselEntry(actor, vesselEntry, root);
});

/**
 * The Vessel Spells list on the character sheet: the Vessel spell of every
 * attuned apparition stays listed, but only the primary apparitions' are
 * usable - the rest are struck through with a disabled Cast button and a
 * button to swap their apparition in. A "change primary apparition" button in
 * the list's header does the same without picking a row. The selectors
 * (`.spell`, `.name`, `.item-controls`, `button.cast-spell`) come from the PF2e
 * character sheet template, which is not part of `pf2e.mjs`.
 */
function decorateVesselEntry(actor, vesselEntry, root) {
    const state = getPrimaryVesselState(actor);
    const everythingPrimary = state.vesselKeys.length <= state.limit;
    const inactive = new Map(
        everythingPrimary
            ? []
            : state.vesselKeys.filter((entry) => !state.primary.includes(entry.key)).map((entry) => [entry.spellId, entry.key]),
    );
    if (!inactive.size) return;

    const block = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
    };
    const label = game.i18n.localize(`${MODULE_ID}.Sheet.VesselInactive`);

    for (const castButton of root.querySelectorAll('[data-action="cast-spell"], button.cast-spell')) {
        if (!(castButton instanceof HTMLElement) || castButton.dataset.apparitionFixInactive === "true") continue;

        const spell = getEntrySpellForControl(actor, vesselEntry, castButton);
        const apparitionKey = spell && inactive.get(spell.id);
        if (!apparitionKey) continue;

        const spellEl = castButton.closest("[data-item-id]");
        castButton.dataset.apparitionFixInactive = "true";
        castButton.classList.add("inactive", "apparition-fix-inactive");
        castButton.setAttribute("aria-disabled", "true");
        castButton.title = label;
        if (castButton instanceof HTMLButtonElement) castButton.disabled = true;
        castButton.addEventListener("click", block, true);

        spellEl?.classList.add("apparition-fix-inactive-vessel");
        for (const nameEl of spellEl?.querySelectorAll(".name, .item-name") ?? []) nameEl.classList.add("apparition-fix-inactive-name");

        const controls = spellEl?.querySelector(".item-controls");
        if (controls && actor.isOwner && !controls.querySelector('[data-apparition-fix="swap-primary"]')) {
            controls.prepend(createSwapButton(actor, apparitionKey, "swap-primary"));
        }
    }

    const header = (
        root.querySelector(`[data-container-id="${vesselEntry.id}"]`) ?? root.querySelector(`[data-item-id="${vesselEntry.id}"]`)
    )?.querySelector(".action-header .item-controls");
    if (header && actor.isOwner && !header.querySelector('[data-apparition-fix="change-primary"]')) {
        header.prepend(createSwapButton(actor, null, "change-primary"));
    }
}

function createSwapButton(actor, newKey, kind) {
    const button = document.createElement("a");
    button.className = "apparition-fix-swap-primary";
    button.dataset.apparitionFix = kind;
    button.title = game.i18n.localize(`${MODULE_ID}.Sheet.ChangePrimary`);
    button.innerHTML = '<i class="fa-solid fa-rotate"></i>';
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        changePrimaryApparition(actor, { newKey }).catch(notifyOperationFailed);
    });
    return button;
}

/* -------------------------------------------- */
/*  Cast rank picker                            */
/* -------------------------------------------- */

/**
 * Determine which ranks the given spell can currently be cast at from the
 * given spontaneous spellcasting entry, based on remaining slots.
 *
 * @param {object} entry SpellcastingEntryPF2e
 * @param {object} spell SpellPF2e
 * @returns {{ rank: number, value: number, max: number }[]}
 */
function getAvailableRanks(entry, spell) {
    const slots = entry.system?.slots;
    if (!slots) return [];

    // `baseRank` is the non-deprecated accessor on a prepared SpellPF2e. The
    // persisted field it falls back to is still named `system.level.value` in
    // the PF2e schema (the Remaster renamed only the derived getters), so the
    // fallback is intentional.
    const baseRank = Math.max(1, spell.baseRank ?? spell.system?.level?.value ?? 1);
    const ranks = [];

    for (let rank = baseRank; rank <= 10; rank++) {
        const slot = slots[`slot${rank}`];
        if (!slot) continue;
        ranks.push({ rank, value: slot.value, max: slot.max });
    }

    return ranks;
}

// Locale-aware "1st/2nd/3rd/4th"-style formatting, reusing PF2e's own
// already-loaded translations (`PF2E.OrdinalSuffixes.*` / `PF2E.OrdinalNumber`)
// instead of hardcoding English suffixes, so this matches whatever language
// the world's PF2e system itself is localized to.
let pluralRules;
function ordinalString(value) {
    pluralRules ??= new Intl.PluralRules(game.i18n.lang, { type: "ordinal" });
    const category = pluralRules.select(value);

    if (game.i18n.has(`PF2E.OrdinalSuffixes.${category}`) && game.i18n.has("PF2E.OrdinalNumber")) {
        const suffix = game.i18n.localize(`PF2E.OrdinalSuffixes.${category}`);
        return formatLocalized("PF2E.OrdinalNumber", { value, suffix });
    }

    // Defensive fallback only, in case a future PF2e release ever renames those keys.
    const fallbackSuffixes = { one: "st", two: "nd", few: "rd" };
    return `${value}${fallbackSuffixes[category] ?? "th"}`;
}

/**
 * Open the rank-selection dialog for a spell and, once the player confirms
 * a choice, cast it at that rank through the entry's own `cast()` method -
 * which deducts the correct slot and posts the normal spell chat card.
 *
 * @param {object} entry SpellcastingEntryPF2e
 * @param {object} spell SpellPF2e
 */
async function openCastDialog(entry, spell) {
    const actor = entry?.actor ?? spell?.actor;
    if (!requireActorOwner(actor)) return;

    // This is also reachable directly through the module's public API, not
    // just through the sheet's (cantrip-filtered) click handler - a cantrip
    // has no rank to choose, so just cast it immediately instead of showing
    // a dialog that would otherwise always end up empty.
    if (spell.isCantrip) {
        await entry.cast(spell);
        return;
    }

    const ranks = getAvailableRanks(entry, spell);

    if (!ranks.length) {
        ui.notifications.warn(formatLocalized(`${MODULE_ID}.Notify.NoRanksExist`, { spell: spell.name }));
        return;
    }

    if (!ranks.some((r) => r.value > 0)) {
        ui.notifications.warn(formatLocalized(`${MODULE_ID}.Notify.NoSlotsAvailable`, { spell: spell.name }));
        return;
    }

    // Only one rank the spell can be cast at (e.g. a 10th-rank spell, or just one rank with slots
    // left): there is nothing to choose, so it is cast at once without the rank menu.
    const usable = ranks.filter((r) => r.value > 0);
    if (usable.length === 1) {
        await entry.cast(spell, { rank: usable[0].rank });
        return;
    }

    const defaultRank = ranks.find((r) => r.value > 0)?.rank ?? ranks[0].rank;

    const options = ranks
        .map(({ rank, value, max }) => {
            const disabled = value <= 0 ? "disabled" : "";
            const selected = rank === defaultRank ? "selected" : "";
            const label = formatLocalized(`${MODULE_ID}.Dialog.RankOption`, {
                rank: ordinalString(rank),
                value,
                max,
            });
            return `<option value="${rank}" ${disabled} ${selected}>${label}</option>`;
        })
        .join("");

    // The prompt paragraph is built as a raw HTML string below, so - unlike
    // the dialog's window title, which the application framework renders as
    // plain text - the spell's name has to be escaped here first: an
    // (e.g. homebrew) spell name containing HTML-significant characters
    // would otherwise be interpreted as markup instead of displayed as text.
    const escapedSpellName = foundry.utils.escapeHTML(spell.name);

    const content = `
        <form class="apparition-fix-cast-dialog">
            <p>${formatLocalized(`${MODULE_ID}.Dialog.Prompt`, { spell: escapedSpellName })}</p>
            <div class="form-group">
                <label for="apparition-fix-rank">${game.i18n.localize(`${MODULE_ID}.Dialog.RankLabel`)}</label>
                <select id="apparition-fix-rank" name="rank">${options}</select>
            </div>
        </form>
    `;

    const chosenRank = await foundry.applications.api.DialogV2.wait({
        window: {
            title: formatLocalized(`${MODULE_ID}.Dialog.Title`, { spell: spell.name }),
            icon: "fa-solid fa-wand-magic-sparkles",
        },
        content,
        buttons: [
            {
                action: "cast",
                label: game.i18n.localize(`${MODULE_ID}.Dialog.CastButton`),
                icon: "fa-solid fa-hand-sparkles",
                default: true,
                callback: (_event, _button, dialog) => {
                    const select = dialog.element.querySelector("#apparition-fix-rank");
                    return Number(select?.value) || null;
                },
            },
            {
                action: "cancel",
                label: game.i18n.localize(`${MODULE_ID}.Dialog.Cancel`),
                icon: "fa-solid fa-xmark",
            },
        ],
        rejectClose: false,
    });

    if (!chosenRank || chosenRank === "cancel") return;

    // Re-check the entry's *live* slot value here rather than trusting the
    // `ranks` snapshot captured when the dialog was opened: the dialog can
    // stay open for a while, during which the slot could have been consumed
    // by something else (another cast, an effect, a GM edit).
    const liveValue = entry.system?.slots?.[`slot${chosenRank}`]?.value ?? 0;
    if (liveValue <= 0) {
        ui.notifications.warn(
            formatLocalized(`${MODULE_ID}.Notify.RankNoLongerAvailable`, {
                spell: spell.name,
                rank: ordinalString(chosenRank),
            }),
        );
        return;
    }

    await entry.cast(spell, { rank: chosenRank });
}

/* -------------------------------------------- */
/*  Bonding and unbonding apparitions           */
/* -------------------------------------------- */

/**
 * Provenance tracking
 * -------------------
 * Every spell this module creates for an apparition - in the Apparition
 * Spellcasting entry or in the Vessel Spells entry - carries that entry's
 * `identifier` flag whichever apparition granted it, and a spell can be on
 * more than one apparition's list. To know whether a spell is still needed
 * after one apparition is unbonded, each managed spell also keeps
 *
 *   flags["pf2e-dailies-apparition-fix"].apparitions -> string[]
 *
 * the "apparition keys" (see `getApparitionKey`) of every bonded apparition
 * that grants it. A spell is deleted only when that array becomes empty;
 * otherwise it stays and only the removed apparition's key is dropped.
 *
 * A spell without that array (one created by another tool) is recognized by
 * matching `spell.sourceId` against the apparition's own spell list.
 * `removeApparition` backfills its provenance from every other bonded
 * apparition before deciding whether to delete or keep it, and
 * `addApparition` recognizes existing spells the same way, so a duplicate is
 * never created.
 *
 * The primary set is stored by apparition key, not by item id (see "Primary
 * apparitions").
 */
const APPARITION_SOURCES_PATH = `${MODULE_ID}.apparitions`;

// Matches the `@UUID[...]` / legacy `@Compendium[...]` links in an apparition's
// (unenriched) description: the spell list, then the single Vessel spell after it.
const SPELL_LINK_REGEX = /@(uuid|compendium)\[([a-z0-9._-]+)\]/gi;

// Same conversion used by PF2e's inline UUID syntax handler: a legacy
// `@Compendium[pack.id]` link lacks the "Compendium." prefix of a real UUID.
function inlineMatchToUuid(match) {
    return match[1] === "Compendium" ? `Compendium.${match[2]}` : match[2];
}

/**
 * @param {Item|string} apparition A bonded apparition feat item, or its UUID.
 * @returns {Promise<Item|null>}
 */
async function resolveApparitionItem(apparition) {
    if (typeof apparition === "string") {
        return fromUuid(apparition);
    }
    return apparition ?? null;
}

/**
 * A stable identity for a bonded apparition: the compendium or world item it
 * was copied from (`sourceId`), falling back to `_stats.duplicateSource` and
 * finally the item's own UUID. It survives the actor's copy being deleted and
 * recreated, which is what the primary set, profiles and provenance rely on.
 *
 * @param {Item} item
 * @returns {string|null}
 */
function getApparitionKey(item) {
    if (!item) return null;
    return item.sourceId ?? item._stats?.duplicateSource ?? item.uuid ?? null;
}

/**
 * Makes sure the actor owns a feat for the apparition `key`, creating an
 * embedded copy of `apparitionItem` when it does not. Bonding is more than
 * granting spells: `getBondedApparitionFeats` only sees an apparition once
 * this feat exists.
 *
 * @param {Actor} actor
 * @param {Item} apparitionItem The resolved apparition feat (compendium, world, custom, or already-embedded).
 * @param {string} key
 * @returns {Promise<Item>} The actor's own embedded apparition feat.
 */
async function ensureApparitionFeatOnActor(actor, apparitionItem, key) {
    if (apparitionItem.isEmbedded && apparitionItem.parent === actor) {
        await linkApparitionFeatToParent(actor, apparitionItem);
        await syncApparitionLoreRuleElements(actor, apparitionItem);
        return apparitionItem;
    }

    const existing = getBondedApparitionFeats(actor).find((feat) => getApparitionKey(feat) === key);
    if (existing) {
        await linkApparitionFeatToParent(actor, existing);
        await syncApparitionLoreRuleElements(actor, existing);
        return existing;
    }

    const source = apparitionItem.toObject();
    delete source._id;
    const otherTags = source.system?.traits?.otherTags ?? [];
    if (!otherTags.includes("animist-apparition")) {
        foundry.utils.setProperty(source, "system.traits.otherTags", [...otherTags, "animist-apparition"]);
    }
    foundry.utils.setProperty(source, "_stats.compendiumSource", key);
    setManagedOrigin(source, { key, grant: "feat", sourceUuid: key });
    markTemporary(source);

    const parent = getApparitionParentFeat(actor);
    if (parent) foundry.utils.setProperty(source, "flags.pf2e.grantedBy", { id: parent.id, onDelete: "cascade" });

    const [created] = await actor.createEmbeddedDocuments("Item", [source]);
    await linkApparitionFeatToParent(actor, created);
    await syncApparitionLoreRuleElements(actor, created);
    return created;
}

/** The class feature the apparitions hang under: Apparition Attunement, else Animist Dedication. */
function getApparitionParentFeat(actor) {
    return findFeature(actor, APPARITION_ATTUNEMENT) ?? findFeature(actor, ANIMIST_DEDICATION);
}

/**
 * Registers an apparition feat as granted by the Attunement / Dedication: the
 * feat points at its parent (`grantedBy`, removed with
 * it) and the parent lists it (`itemGrants`, kept if the apparition goes). The
 * character sheet then shows the apparition nested under that class feature.
 * Idempotent; does nothing when PF2e's slug helper is unavailable.
 */
async function linkApparitionFeatToParent(actor, feat) {
    const parent = getApparitionParentFeat(actor);
    const sluggify = game.pf2e?.system?.sluggify;
    if (!parent || !feat || parent === feat || typeof sluggify !== "function") return;

    const grants = parent.flags?.pf2e?.itemGrants ?? {};
    if (feat.flags?.pf2e?.grantedBy?.id !== parent.id) {
        await feat.update({ "flags.pf2e.grantedBy": { id: parent.id, onDelete: "cascade" } });
    }
    if (Object.values(grants).some((grant) => grant?.id === feat.id)) return;

    const base = sluggify(feat.name, { camel: "dromedary" });
    let slug = base;
    for (let n = 2; grants[slug]; n++) slug = `${base}${n}`;
    await parent.setFlag("pf2e", `itemGrants.${slug}`, { id: feat.id, onDelete: "detach" });
}

/** Drops grant entries of the Attunement / Dedication whose apparition feat no longer exists. */
async function pruneDeadItemGrants(actor) {
    for (const parent of [findFeature(actor, APPARITION_ATTUNEMENT), findFeature(actor, ANIMIST_DEDICATION)]) {
        const grants = parent?.flags?.pf2e?.itemGrants;
        if (!grants) continue;
        for (const [slug, grant] of Object.entries(grants)) {
            if (grant?.id && !actor.items.has(grant.id)) await parent.unsetFlag("pf2e", `itemGrants.${slug}`);
        }
    }
}

/**
 * Flags an item this module creates as temporary. The nightly rest removes
 * every temporary item (feat, spells, entries, Lore), so the previous day's
 * apparitions are gone before the next day's are bonded. An item without the
 * flag would outlive the rest and keep its apparition bonded.
 *
 * @param {object} source Item source data.
 * @returns {object} The same object, flagged.
 */
function markTemporary(source) {
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.temporary`, true);
    return source;
}

/**
 * @param {Item} item
 * @returns {boolean} Whether this module will remove this item on the next rest.
 */
function isTemporary(item) {
    return !!item?.flags?.[MODULE_ID]?.temporary;
}

/**
 * Stamp an actor-owned Item with explicit provenance metadata. The separate
 * `apparitions` claim list remains the authoritative shared-claim set.
 * `origin` identifies the managed copy and the grant kind for repair/migration.
 *
 * @param {object} source Item source/update data
 * @param {{ key: string, grant: "feat"|"spell"|"vessel"|"lore", sourceUuid?: string }} origin
 */
function setManagedOrigin(source, { key, grant, sourceUuid = null }) {
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.${ORIGIN_FLAG}`, {
        type: "apparition",
        key,
        grant,
        ...(sourceUuid ? { sourceUuid } : {}),
    });
    return source;
}

function getManagedOrigin(item) {
    const origin = item?.flags?.[MODULE_ID]?.[ORIGIN_FLAG];
    return origin && typeof origin === "object" && origin.type === "apparition" ? origin : null;
}

/**
 * @param {object} spell SpellPF2e
 * @returns {string[]}
 */
function getSpellApparitionSources(spell) {
    return foundry.utils.getProperty(spell.flags ?? {}, APPARITION_SOURCES_PATH) ?? [];
}

/**
 * Lore skills exist either as skill entries generated from Rule Elements
 * (PF2e 8.6+) or as explicit Lore Items (older systems). Strips the " Lore"
 * suffix and the case so cleanup and migration can match either form.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeLoreName(name) {
    return (name ?? "")
        .trim()
        .replace(/ lore$/i, "")
        .toLowerCase();
}

/** PF2e 8.6+ supports custom Lore skills created by Rule Elements. */
function supportsLoreRuleElements() {
    const version = game.system?.version;
    if (typeof version !== "string" || !version.trim()) return false;
    if (version === "8.6.0" || version.startsWith("8.6.0-")) return true;
    return typeof foundry.utils.isNewerVersion === "function" ? foundry.utils.isNewerVersion(version, "8.6.0") : false;
}

function transliterateLoreSlug(value) {
    const map = {
        а: "a",
        б: "b",
        в: "v",
        г: "g",
        д: "d",
        е: "e",
        ё: "yo",
        ж: "zh",
        з: "z",
        и: "i",
        й: "y",
        к: "k",
        л: "l",
        м: "m",
        н: "n",
        о: "o",
        п: "p",
        р: "r",
        с: "s",
        т: "t",
        у: "u",
        ф: "f",
        х: "kh",
        ц: "ts",
        ч: "ch",
        ш: "sh",
        щ: "shch",
        ъ: "",
        ы: "y",
        ь: "",
        э: "e",
        ю: "yu",
        я: "ya",
    };
    return String(value ?? "")
        .toLowerCase()
        .split("")
        .map((character) => map[character] ?? character)
        .join("");
}

function slugifyLorePart(value) {
    return transliterateLoreSlug(value)
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

/**
 * Give a bilingual apparition Lore a stable ASCII slug. PF2e 8.6 rejects
 * localized/mixed-script skill slugs. Crucially, inspect the whole name
 * before stripping the trailing "Lore": it can be inside an English
 * parenthetical, e.g. "Знания геральдики (Heraldry Lore)".
 */
function getLoreSkillIdentity(name) {
    const original = String(name ?? "").trim();
    if (!original) return null;

    let slugSource = null;
    let localizedLabel = null;

    const paren = original.match(/\(([^()]*)\)\s*$/);
    if (paren && /[a-z]/i.test(paren[1]) && !/[а-яё]/i.test(paren[1])) {
        slugSource = paren[1].replace(/\s+lore$/i, "").trim();
        localizedLabel = original
            .slice(0, paren.index)
            .trim()
            .replace(/[\s\-/|–—]+$/, "");
    }

    // Homebrew/translation data may use `Russian-Name-English Name` instead
    // of parentheses. Treat the final ASCII-only segment as its stable alias.
    if (!slugSource) {
        const baseWithoutLore = original.replace(/\s+lore$/i, "").trim();
        const tail = baseWithoutLore.match(/(?:[-/|–—])\s*([A-Za-z][A-Za-z0-9'’ -]*)\s*$/);
        if (tail && /[а-яё]/i.test(baseWithoutLore.slice(0, tail.index))) {
            slugSource = tail[1].trim().replace(/\s+lore$/i, "");
            localizedLabel = baseWithoutLore
                .slice(0, tail.index)
                .trim()
                .replace(/[\s\-/|–—]+$/, "");
        }
    }

    const baseWithoutLore = original.replace(/\s+lore$/i, "").trim();
    if (!slugSource) {
        // English-only name, or a homebrew Lore with no English alias.
        slugSource = baseWithoutLore;
        localizedLabel = /[a-z]/i.test(baseWithoutLore) && !/[а-яё]/i.test(baseWithoutLore) ? original : baseWithoutLore;
    }

    let slugPart = slugifyLorePart(slugSource);
    if (!slugPart) slugPart = slugifyLorePart(baseWithoutLore);
    if (!slugPart) return null;
    const slug = slugPart.endsWith("-lore") ? slugPart : `${slugPart}-lore`;

    // The localized prefix is the visible label if it contains Cyrillic;
    // otherwise retain the full English name including "Lore".
    const label =
        localizedLabel && /[а-яё]/i.test(localizedLabel)
            ? localizedLabel
            : /\s+lore$/i.test(original)
              ? original
              : `${localizedLabel || baseWithoutLore} Lore`;
    return { slug, label };
}

/**
 * Empties the obsolete world-level Lore skill registry written by pre-release
 * builds. Its entries must not be loaded into CONFIG.PF2E.skills: globally
 * registered skills outlive their apparition and cannot be removed.
 */
async function clearLegacyLoreSkillRegistry() {
    if (!game.user?.isGM) return;
    try {
        const stored = game.settings.get(MODULE_ID, LORE_SKILLS_SETTING) ?? {};
        if (stored && typeof stored === "object" && Object.keys(stored).length) {
            await game.settings.set(MODULE_ID, LORE_SKILLS_SETTING, {});
        }
    } catch (error) {
        // The setting does not exist in worlds that never used the registry.
        if (
            String(error?.message ?? "")
                .toLowerCase()
                .includes("not registered")
        )
            return;
        logError("Could not clear the legacy Lore skill registry", error);
    }
}

/** The localized skill path older builds wrote, rebuilt so those rules can be removed during Lore migration. */
function getLegacyLoreSkillPath(name) {
    const label = String(name ?? "")
        .trim()
        .replace(/\s+lore$/i, "")
        .trim();
    if (!label) return null;
    const sluggify = game.pf2e?.system?.sluggify;
    let slug = typeof sluggify === "function" ? sluggify(label) : "";
    if (typeof slug !== "string" || !slug.trim()) slug = slugifyLorePart(label);
    slug = slug.trim().toLowerCase();
    const pathSlug = slug.endsWith("-lore") ? slug : `${slug}-lore`;
    return pathSlug && pathSlug !== "-lore" ? `system.skills.${pathSlug}` : null;
}

/** Proficiency rank of an apparition Lore: trained, expert from level 8, master from level 16. */
function getApparitionLoreRank(actor) {
    const level = actor?.level ?? 1;
    return level >= 16 ? 3 : level >= 8 ? 2 : 1;
}

/**
 * PF2e 8.6+ creates non-editable custom Lore entries directly from an
 * ActiveEffectLike targeting `system.skills.<slug>`. A single object write is
 * intentional: the system prepares the custom skill before these rules apply.
 */
function getLoreRuleDetails(name, actor) {
    const identity = getLoreSkillIdentity(name);
    if (!identity) return null;
    const path = `system.skills.${identity.slug}`;
    const rank = getApparitionLoreRank(actor);
    return {
        path,
        skillPath: path,
        slug: identity.slug,
        rule: {
            key: "ActiveEffectLike",
            mode: "override",
            path,
            value: {
                label: identity.label,
                attribute: "int",
                rank,
                lore: true,
                itemId: null,
            },
        },
    };
}

/**
 * Attach the Lore grants to the apparition feat as Rule Elements. Skills are
 * shared by slug: if two apparitions grant the same Lore, either active feat
 * keeps its proficiency and Lore classification in place.
 */
async function syncApparitionLoreRuleElements(actor, feat) {
    if (!supportsLoreRuleElements() || !actor || !feat || feat.type !== "feat" || feat.parent !== actor) return false;

    const previousOwnedPaths = feat.getFlag(MODULE_ID, LORE_RULE_PATHS_FLAG);
    const ownedBefore = Array.isArray(previousOwnedPaths) ? previousOwnedPaths : [];
    const ownedSetBefore = new Set(ownedBefore);
    const rules = foundry.utils.deepClone(feat.system?.rules ?? []);
    const loreNames = parseApparitionLores(feat);
    const legacyRoots = new Set(loreNames.map(getLegacyLoreSkillPath).filter(Boolean));
    const currentRoots = new Set(
        loreNames
            .map((name) => getLoreSkillIdentity(name)?.slug)
            .filter(Boolean)
            .map((slug) => `system.skills.${slug}`),
    );

    const retainedRules = rules.filter((rule) => {
        if (rule?.key !== "ActiveEffectLike" || typeof rule.path !== "string") return true;
        if (ownedSetBefore.has(rule.path)) return false;
        if (legacyRoots.has(rule.path)) return false;
        for (const root of legacyRoots) {
            if (rule.path.startsWith(`${root}.`)) return false;
        }
        // A prior build may have lost its ownership flag. Remove its root rule
        // if it writes the complete custom-skill object, or child rules for the
        // same Lore we are about to regenerate with the correct ASCII slug.
        for (const root of currentRoots) {
            if (
                rule.path === root &&
                rule.value &&
                typeof rule.value === "object" &&
                ("label" in rule.value || "rank" in rule.value || "attribute" in rule.value)
            )
                return false;
            if (rule.path.startsWith(`${root}.`)) return false;
        }
        const slug = rule.path.slice("system.skills.".length).split(".")[0];
        if (rule.path.startsWith("system.skills.") && /\P{ASCII}/u.test(slug)) return false;
        // Known malformed legacy output used a localized slug and a full skill
        // object. Clean it even if the feat's old module flags are missing.
        if (
            rule.path.startsWith("system.skills.") &&
            rule.value &&
            typeof rule.value === "object" &&
            "label" in rule.value &&
            "attribute" in rule.value &&
            "rank" in rule.value
        )
            return false;
        return true;
    });

    const desired = new Map();
    for (const name of loreNames) {
        const details = getLoreRuleDetails(name, actor);
        if (details && !desired.has(details.path)) desired.set(details.path, details.rule);
    }

    const ownedAfter = [];
    for (const [path, rule] of desired) {
        // Do not take ownership of a handwritten Rule Element that is not ours.
        if (retainedRules.some((candidate) => candidate?.key === "ActiveEffectLike" && candidate.path === path)) continue;
        retainedRules.push(rule);
        ownedAfter.push(path);
    }

    const oldRulesJson = JSON.stringify(rules);
    const newRulesJson = JSON.stringify(retainedRules);
    const oldOwnedJson = JSON.stringify(ownedBefore);
    const newOwnedJson = JSON.stringify(ownedAfter);
    if (oldRulesJson === newRulesJson && oldOwnedJson === newOwnedJson) return false;

    await feat.update({
        "system.rules": retainedRules,
        [`flags.${MODULE_ID}.${LORE_RULE_PATHS_FLAG}`]: ownedAfter,
    });
    return true;
}

/**
 * Deletes Vessel spells that no bonded apparition owns.
 *
 * The system adds 1 to the focus-pool maximum for every non-cantrip focus
 * spell on the actor, whichever spellcasting entry it belongs to, so a stale
 * Vessel spell keeps inflating the pool even when the sheet shows it struck
 * out. `removeApparition` only looks at the current Vessel Spells entry, so a
 * spell left pointing at an entry that has since been replaced would never be
 * found through the normal unbond flow.
 *
 * Vessel spells are recognized by the module's `identifier` flag, so focus
 * spells from other class features or archetypes are never touched.
 *
 * @param {Actor} actor
 * @returns {Promise<string[]>} The ids of the deleted spells.
 */
async function pruneOrphanedVesselSpells(actor) {
    if (!actorCanModify(actor)) return [];

    const validUuids = new Set(
        getBondedApparitionFeats(actor)
            .map((feat) => parseApparitionVesselUuid(feat))
            .filter(Boolean),
    );

    const stale = actor.itemTypes.spell.filter((spell) => {
        if (!hasVesselIdentifier(spell.flags)) return false;
        const uuid = spell.sourceId ?? spell.uuid;
        return !validUuids.has(uuid);
    });

    if (stale.length)
        await actor.deleteEmbeddedDocuments(
            "Item",
            stale.map((spell) => spell.id),
        );
    return stale.map((spell) => spell.id);
}

/**
 * Removes what a rest should already have removed but did not:
 *  - bonded apparition feats without the `temporary` flag (bonded before the
 *    module flagged its items) or that no longer grant anything, together
 *    with everything they grant, via `removeApparition`;
 *  - spells and Lore skills this module tracks whose apparition is no longer
 *    bonded at all;
 *  - Vessel spells no bonded apparition owns (`pruneOrphanedVesselSpells`).
 *
 * @param {Actor} actor
 * @returns {Promise<number>} How many items were removed.
 */
async function pruneLeftoverApparitions(actor) {
    if (!requireActorOwner(actor)) return 0;

    let count = 0;

    const leftoverFeats = getBondedApparitionFeats(actor).filter(
        // Active temporary feats are the current day's apparitions and must
        // never be treated as leftovers. A temporary feat that has become
        // completely empty is safe to remove, as is any apparition feat that
        // lacks the temporary marker.
        (feat) => !isTemporary(feat) || !apparitionStillGrantsAnything(actor, feat),
    );
    for (const feat of leftoverFeats) {
        const result = await removeApparition(actor, feat, { silent: true });
        count += result.removed.length + (result.removedFeatId ? 1 : 0);
    }

    const bondedKeys = new Set([
        ...getBondedApparitionFeats(actor).map((feat) => getApparitionKey(feat)),
        ...getPresentFeatureClaimKeys(actor),
    ]);
    const orphans = [...actor.itemTypes.spell, ...actor.itemTypes.lore].filter((item) => {
        const sources = getSpellApparitionSources(item);
        return sources.length > 0 && sources.every((source) => !bondedKeys.has(source));
    });
    if (orphans.length) {
        await actor.deleteEmbeddedDocuments(
            "Item",
            orphans.map((item) => item.id),
        );
        count += orphans.length;
    }

    count += (await pruneOrphanedVesselSpells(actor)).length;
    await pruneDeadItemGrants(actor);
    await syncPrimaryVessels(actor);
    return count;
}

/* -------------------------------------------- */
/*  Primary apparitions                         */
/* -------------------------------------------- */

// The primary state is module-owned. A primary apparition is represented by
// the stable apparition key, not by the transient actor Item id of its Vessel
// spell. This makes the choice survive an item re-create until the next rest.
const FOCUS_RULE_TAG = "focus-pool";

const itemSources = (pack, anachronismPack, id) => [
    `Compendium.pf2e.${pack}.Item.${id}`,
    `Compendium.pf2e-anachronism.${anachronismPack}.Item.${id}`,
];

// Circle of Spirits changes how the focus pool is computed, not how many
// apparitions are primary (see syncPrimaryFocusRule). Matched by id only.
const CIRCLE_OF_SPIRITS = { sources: itemSources("feats-srd", "feats", "M8jbV0il124Ve5oV") };
const SUPREME_INCARNATION = { sources: itemSources("classfeatures", "class-features", "1MHXjNczVZfVvDP6") };

// Relinquish Control ties the character to one apparition for good: "Choose one of your apparitions when
// you gain this feat; you must always select it as one of the apparitions you attune to each day."
const RELINQUISH_CONTROL = { sources: itemSources("feats-srd", "feats", "Gw8tjM91F6i3fOnR") };
const PERMANENT_APPARITION_FLAG = "permanentApparition";

// The Animist class item, matched by compendium id.
const ANIMIST_CLASS = { sources: itemSources("classes", "classes", "9KiqZVG9r5g8mC4V") };
const isAnimistClass = (actor) => !!actor?.class && ANIMIST_CLASS.sources.includes(getFeatSource(actor.class));

const spellUuid = (id) => `Compendium.pf2e.spells-srd.Item.${id}`;
const HEAL = spellUuid("rfZpqmj0AIIdkVIs");
const HARM = spellUuid("wdA52JJnsuQWeyqz");
const AVATAR = spellUuid("ckUOoqOM7Kg7VqxB");
const ANIMAL_FORM = spellUuid("wp09USMB3GIW1qbp");
const AERIAL_FORM = spellUuid("NzXpEzcZAjuDTZjK");
const MONSTROSITY_FORM = spellUuid("8AMvNVOUEtxBCDvJ");

// Class feats / features that add spells to the Apparition Spellcasting
// entry. A feature counts only when the actor has an item whose compendium
// source is one of these ids.
const FEATURE_SPELLS = [
    { key: "balance", sources: itemSources("feats-srd", "feats", "8Y9DCalsSnXHDCeV"), spells: [HEAL, HARM] }, // Embodiment of the Balance
    { key: "supreme", sources: SUPREME_INCARNATION.sources, spells: [AVATAR] }, // Supreme Incarnation
    { key: "walk", sources: itemSources("feats-srd", "feats", "zKUtZxlQw5jWnX9z"), spells: [ANIMAL_FORM] }, // Walk the Wilds
    { key: "wind", sources: itemSources("feats-srd", "feats", "LoK6iI2f8ziSxFaU"), spells: [AERIAL_FORM] }, // Wind Seeker
    { key: "monstrous", sources: itemSources("feats-srd", "feats", "VO2uOVrjIr7ZAjkX"), spells: [MONSTROSITY_FORM] }, // Monstrous Inclinations
];

// A spell granted by a feature is claimed with this key instead of an apparition key.
const FEATURE_CLAIM_PREFIX = "feature:";
const featureClaimKey = (definition) => `${FEATURE_CLAIM_PREFIX}${definition.sources[0]}`;
const isFeatureClaim = (key) => typeof key === "string" && key.startsWith(FEATURE_CLAIM_PREFIX);
const getPresentFeatureClaimKeys = (actor) => FEATURE_SPELLS.filter((definition) => findFeature(actor, definition)).map(featureClaimKey);
const featureSyncActors = new Set();

const MEDIUM = {
    slug: "medium",
    sources: ["Compendium.pf2e.classfeatures.Item.k6c2gesVQ8QuEWGm", "Compendium.pf2e-anachronism.class-features.Item.k6c2gesVQ8QuEWGm"],
};

function getVesselSpells(actor) {
    return (actor?.itemTypes?.spell ?? []).filter((spell) => hasVesselIdentifier(spell.flags));
}

function getVesselSpellForApparition(actor, apparitionFeat) {
    const uuid = parseApparitionVesselUuid(apparitionFeat);
    if (!uuid) return null;
    return getVesselSpells(actor).find((spell) => (spell.sourceId ?? spell.uuid) === uuid) ?? null;
}

function getPrimaryVesselLimit(actor, vesselCount) {
    if (vesselCount <= 0) return 0;
    return Math.min(findFeature(actor, MEDIUM) && actor.level >= 9 ? 2 : 1, vesselCount);
}

function getPrimaryVesselState(actor) {
    const vesselIds = getVesselSpells(actor).map((spell) => spell.id);
    const vesselKeys = getBondedApparitionFeats(actor)
        .map((feat) => ({ key: getApparitionKey(feat), spell: getVesselSpellForApparition(actor, feat) }))
        .filter((entry) => entry.key && entry.spell)
        .map((entry) => ({ key: entry.key, spellId: entry.spell.id }));
    const limit = getPrimaryVesselLimit(actor, vesselKeys.length);
    const stored = actor?.getFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG);
    const primaryKeys = Array.isArray(stored) ? stored : [];
    const primary = [...new Set(primaryKeys)].filter((key) => vesselKeys.some((entry) => entry.key === key)).slice(0, limit);
    return {
        vesselIds,
        vesselKeys,
        limit,
        primary,
        primaryApparitions: primary,
    };
}

/* -------------------------------------------- */
/*  PF2e Avatars compatibility                  */
/* -------------------------------------------- */

// pf2e-avatars reads an Animist's primary Vessels from the pf2e-dailies API,
// which is frozen and cannot be extended. Instead, this module wraps the Avatar
// module's own `createChatMessage` handler as it registers and answers its
// Animist branch from this module's primary-vessel state. Every other case is
// passed on to the original handler. Nothing is installed unless pf2e-avatars
// is active.
const AVATARS_MODULE_ID = "pf2e-avatars";
const CUSTOM_APPARITION_AVATAR_FLAG = "vesselAvatarFormUuid";
const LEGACY_CUSTOM_APPARITION_AVATAR_FLAG = "customApparitionAvatarUuid";
const AVATAR_HOOK_WRAPPER_MARKER = "__pf2eDailiesApparitionFixAvatarHookWrapper";
const AVATAR_SPELL_SOURCE_UUID = spellUuid("ckUOoqOM7Kg7VqxB");
let avatarsModuleExports = null;
let avatarsHookInterceptorInstalled = false;

function getCustomAvatarFormUuid(apparition) {
    return (
        apparition?.getFlag?.(MODULE_ID, CUSTOM_APPARITION_AVATAR_FLAG) ||
        apparition?.getFlag?.(MODULE_ID, LEGACY_CUSTOM_APPARITION_AVATAR_FLAG) ||
        ""
    );
}

async function loadAvatarsModuleExports() {
    if (avatarsModuleExports) return avatarsModuleExports;
    const avatarsModule = game.modules.get(AVATARS_MODULE_ID);
    if (!avatarsModule?.active) return null;
    const moduleRoot = String(avatarsModule.path || `modules/${AVATARS_MODULE_ID}`).replace(/\/$/, "");
    const importPath = moduleRoot.startsWith("/") ? moduleRoot : `/${moduleRoot}`;
    avatarsModuleExports = await import(`${importPath}/js/avatars.js`);
    return avatarsModuleExports;
}

function getAvatarFormForApparition(apparition, vesselUuid, forms) {
    if (!Array.isArray(forms)) return null;
    const assignedUuid = getCustomAvatarFormUuid(apparition);
    if (assignedUuid) return forms.find((form) => form?.value === assignedUuid) ?? null;
    return forms.find((form) => form?.vesselSpell === vesselUuid) ?? null;
}

/**
 * Build the options used by the PF2e Avatars ChoiceSet without touching the
 * read-only PF2e Dailies API or mutating Avatars' exported form table.
 * Custom primary Vessels use their configured existing form; official Vessels
 * use their normal vesselSpell mapping. Unsupported primary entries are
 * ignored, and the normal full form list is offered only when no primary
 * Vessel maps to an available form (the same fallback used by pf2e-avatars).
 */
function getAvatarChoicesForActor(actor, forms) {
    const availableForms = (Array.isArray(forms) ? forms : []).filter(
        (form) => typeof form?.value === "string" && typeof form?.label === "string",
    );
    if (!actor || !availableForms.length) return [];

    const state = getPrimaryVesselState(actor);
    if (!state.primary.length) return availableForms.map(({ label, value }) => ({ label, value }));

    const bonded = getBondedApparitionFeats(actor);
    const choices = [];
    const selectedForms = new Set();
    for (const key of state.primary) {
        const apparition = bonded.find((feat) => getApparitionKey(feat) === key);
        if (!apparition) continue;
        const vesselUuid = parseApparitionVesselUuid(apparition);
        if (!vesselUuid) continue;
        const form = getAvatarFormForApparition(apparition, vesselUuid, availableForms);
        if (!form || selectedForms.has(form.value)) continue;
        selectedForms.add(form.value);
        choices.push({ label: form.label, value: form.value });
    }

    return choices.length ? choices : availableForms.map(({ label, value }) => ({ label, value }));
}

function makeAvatarEffectFallback(choices) {
    // Mirrors pf2e-avatars/js/avatars.js for installations where its export
    // cannot be imported, avoiding a secondary error from the original handler.
    return {
        name: "Effect: Apparition Avatar",
        type: "effect",
        img: "icons/magic/symbols/circled-gem-pink.webp",
        system: {
            description: { value: "<p></p>", gm: "" },
            publication: { title: "PF2e Avatars", authors: "", license: "ORC", remaster: true },
            rules: [
                { key: "ChoiceSet", flag: "animistAvatar", choices },
                { key: "GrantItem", uuid: "{item|flags.system.rulesSelections.animistAvatar}", onDeleteActions: { grantee: "restrict" } },
            ],
            slug: "effect-apparition-avatar",
            level: { value: 1 },
            duration: { value: -1, unit: "unlimited", expiry: null, sustained: false },
            tokenIcon: { show: true },
        },
    };
}

function isAvatarsCreateChatMessageHandler(callback) {
    if (typeof callback !== "function") return false;
    const source = Function.prototype.toString.call(callback);
    // Match the characteristic references in pf2e-avatars 1.1.x. Avoid
    // intercepting other createChatMessage listeners.
    return source.includes("getAnimistAvatarEffect") && source.includes("getAnimistVesselsData") && source.includes("APPARITION_AVATARS");
}

function wrapAvatarsCreateChatMessageHandler(original) {
    if (original?.[AVATAR_HOOK_WRAPPER_MARKER]) return original;

    const wrapped = async function (chatMessage, info, userId) {
        // Follow pf2e-avatars' own guard conditions before choosing a branch.
        if (userId !== game.user.id) return original.call(this, chatMessage, info, userId);
        const itemUuid = chatMessage?.item?._stats?.compendiumSource;
        if (itemUuid !== AVATAR_SPELL_SOURCE_UUID) return original.call(this, chatMessage, info, userId);

        const spellcaster = ChatMessage.getSpeakerActor(chatMessage?.speaker);
        if (!spellcaster || !isAnimistClass(spellcaster)) {
            return original.call(this, chatMessage, info, userId);
        }

        try {
            const avatarModule = await loadAvatarsModuleExports();
            const forms = avatarModule?.APPARITION_AVATARS;
            const choices = getAvatarChoicesForActor(spellcaster, forms);
            const effect =
                typeof avatarModule?.getAnimistAvatarEffect === "function"
                    ? avatarModule.getAnimistAvatarEffect(choices)
                    : makeAvatarEffectFallback(choices);
            await spellcaster.createEmbeddedDocuments("Item", [effect]);
        } catch (error) {
            logError("PF2e Avatars Animist handler failed", error);
            // Do not call the original Animist branch: it would read the
            // pf2e-dailies API, which does not know this module's state.
            try {
                const forms = avatarsModuleExports?.APPARITION_AVATARS ?? [];
                const effect = makeAvatarEffectFallback(getAvatarChoicesForActor(spellcaster, forms));
                await spellcaster.createEmbeddedDocuments("Item", [effect]);
            } catch (fallbackError) {
                logError("PF2e Avatars fallback effect creation failed", fallbackError);
            }
        }
    };
    Object.defineProperty(wrapped, AVATAR_HOOK_WRAPPER_MARKER, { value: true });
    Object.defineProperty(wrapped, "original", { value: original });
    return wrapped;
}

/**
 * This must be installed during `init`, before pf2e-avatars' `ready` callback
 * registers its createChatMessage handler. No assignment to game.dailies or
 * its frozen API is attempted.
 */
function installAvatarsHookInterceptor() {
    if (avatarsHookInterceptorInstalled) return true;
    if (!game.modules.get(AVATARS_MODULE_ID)?.active) return false;
    const originalOn = Hooks?.on;
    if (typeof originalOn !== "function") return false;

    try {
        const descriptor = Object.getOwnPropertyDescriptor(Hooks, "on");
        if (descriptor && descriptor.writable === false && !descriptor.set) return false;

        const restoreOriginalOn = () => {
            // The interception is needed only until pf2e-avatars registers its
            // handler. Restore the global hook method immediately afterward.
            if (Hooks.on !== interceptor) return;
            if (descriptor) Object.defineProperty(Hooks, "on", { ...descriptor, value: originalOn });
            else delete Hooks.on;
        };

        const interceptor = function (hookName, callback, ...args) {
            const target =
                hookName === "createChatMessage" &&
                game.modules.get(AVATARS_MODULE_ID)?.active &&
                isAvatarsCreateChatMessageHandler(callback);
            if (target) callback = wrapAvatarsCreateChatMessageHandler(callback);
            const result = originalOn.call(this, hookName, callback, ...args);
            if (target) restoreOriginalOn();
            return result;
        };

        Object.defineProperty(Hooks, "on", {
            ...(descriptor ?? { configurable: true, enumerable: false, writable: true }),
            value: interceptor,
        });
        avatarsHookInterceptorInstalled = Hooks.on === interceptor;
    } catch (error) {
        logError("Could not install PF2e Avatars hook compatibility", error);
        avatarsHookInterceptorInstalled = false;
    }
    return avatarsHookInterceptorInstalled;
}

/**
 * Loads the Avatar form catalogue at `ready` and warns when the hook wrapper
 * could not be installed. The wrapper itself is installed during `init`.
 */
async function installAvatarsBridge() {
    if (!game.modules.get(AVATARS_MODULE_ID)?.active) return;
    try {
        await loadAvatarsModuleExports();
        if (!avatarsHookInterceptorInstalled) {
            console.warn(
                `${ERROR_PREFIX} PF2e Avatars is active, but the chat-hook compatibility wrapper could not be installed. Check whether another module locks Hooks.on.`,
            );
        }
    } catch (error) {
        logError("PF2e Avatars compatibility setup failed", error);
    }
}

async function syncPrimaryVessels(actor, { primary = null } = {}) {
    if (!actorCanModify(actor)) return;

    try {
        const state = getPrimaryVesselState(actor);
        const wanted =
            primary === null
                ? state.primary
                : [...new Set(primary)].filter((key) => state.vesselKeys.some((entry) => entry.key === key)).slice(0, state.limit);

        const stored = actor.getFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG);
        const same = Array.isArray(stored) && stored.length === wanted.length && stored.every((value, index) => value === wanted[index]);

        // Keep an explicit empty array so "no primary apparitions" remains a
        // deliberate player choice instead of being mistaken for "unset".
        if (!same) await actor.setFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG, wanted);

        await syncPrimaryFocusRule(actor);

        // Whoever changed the primary set (a star click, auto-primary, a profile,
        // "restore yesterday", repair) - listeners hear about it here.
        const before = Array.isArray(stored) ? stored : [];
        if (before.length !== wanted.length || before.some((key, index) => key !== wanted[index])) {
            Hooks.callAll(`${MODULE_ID}:primary-changed`, actor, wanted);
        }
    } catch (error) {
        notifyOperationFailed(error);
    }
}

function isAutoPrimaryEnabled() {
    return !!game.settings.get(MODULE_ID, AUTO_PRIMARY_FLAG);
}

async function ensureAutoPrimary(actor, preferredKey = null) {
    if (!actorCanModify(actor) || !isAutoPrimaryEnabled()) return;
    const state = getPrimaryVesselState(actor);
    const next = [...state.primary];
    if (
        preferredKey &&
        state.vesselKeys.some((entry) => entry.key === preferredKey) &&
        !next.includes(preferredKey) &&
        next.length < state.limit
    ) {
        next.push(preferredKey);
    }
    for (const entry of state.vesselKeys) {
        if (next.length >= state.limit) break;
        if (!next.includes(entry.key)) next.push(entry.key);
    }
    if (next.length !== state.primary.length || next.some((key, index) => key !== state.primary[index])) {
        await syncPrimaryVessels(actor, { primary: next });
    }
}

async function setAutoPrimaryEnabled(enabled) {
    if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NotGM`));
        return false;
    }
    await game.settings.set(MODULE_ID, AUTO_PRIMARY_FLAG, !!enabled);
    if (enabled) {
        for (const actor of game.actors ?? []) {
            if (actor.type === "character" && actorCanModify(actor) && actorHasApparitionAccess(actor)) {
                await ensureAutoPrimary(actor);
                await syncCurrentPrimaryState(actor);
            }
        }
    }
    return true;
}

/**
 * Marks an apparition's Vessel primary or not. The primary set has a fixed
 * size: when it is full, making another Vessel
 * primary swaps it in for one of the current ones (the only one, or
 * `replaceKey`; with several primaries and no valid `replaceKey` nothing
 * changes and the limit warning is shown). Un-starring is always allowed.
 *
 * @param {Actor} actor
 * @param {string} apparitionKey
 * @param {boolean} [isPrimary]
 * @param {{ replaceKey?: string|null }} [options]
 * @returns {Promise<boolean>} Whether the request was applied.
 */
async function setPrimaryVessel(actor, apparitionKey, isPrimary = true, { replaceKey = null } = {}) {
    if (!requireActorOwner(actor)) return false;

    const state = getPrimaryVesselState(actor);
    if (!state.vesselKeys.some((entry) => entry.key === apparitionKey)) return false;

    let next;
    if (!isPrimary) {
        next = state.primary.filter((key) => key !== apparitionKey);
    } else if (state.primary.includes(apparitionKey)) {
        return true;
    } else if (state.primary.length < state.limit) {
        next = [...state.primary, apparitionKey];
    } else {
        const target = state.primary.includes(replaceKey) ? replaceKey : state.primary.length === 1 ? state.primary[0] : null;
        if (!target) {
            ui.notifications.warn(formatLocalized(`${MODULE_ID}.Notify.PrimaryLimitReached`, { limit: state.limit }));
            return false;
        }
        next = state.primary.map((key) => (key === target ? apparitionKey : key));
    }

    await syncPrimaryVessels(actor, { primary: next });
    return true;
}

/**
 * Asks which apparition becomes primary and, when several are primary and the
 * set is full, which of them it replaces - the dialog behind the
 * sheet's "change primary apparition" buttons. Nothing is asked that is already decided: with a known
 * `newKey` and a single primary apparition it returns at once.
 *
 * @param {Actor} actor
 * @param {{ newKey?: string|null }} [options] The apparition to make primary, when the caller already knows.
 * @returns {Promise<{ newKey: string, replaceKey: string|null }|null>} null when nothing can or should change.
 */
async function promptPrimaryChange(actor, { newKey = null } = {}) {
    const state = getPrimaryVesselState(actor);
    const names = new Map(getBondedApparitionFeats(actor).map((feat) => [getApparitionKey(feat), feat.name]));
    const nameOf = (key) => names.get(key) ?? key;
    const candidates = state.vesselKeys.map((entry) => entry.key).filter((key) => !state.primary.includes(key));

    if (!candidates.length || (newKey && !candidates.includes(newKey))) {
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.Notify.NothingToChange`));
        return null;
    }

    const needsReplace = state.primary.length >= state.limit && state.primary.length > 1;
    if (newKey && !needsReplace) return { newKey, replaceKey: null };

    const escape = foundry.utils.escapeHTML;
    const select = (name, label, keys, selected) =>
        `<div class="form-group"><label>${game.i18n.localize(label)}</label><select name="${name}">${keys
            .map((key) => `<option value="${escape(key)}"${key === selected ? " selected" : ""}>${escape(nameOf(key))}</option>`)
            .join("")}</select></div>`;
    const content =
        (newKey ? "" : select("newKey", `${MODULE_ID}.ChangePrimary.New`, candidates, candidates[0])) +
        (needsReplace ? select("replaceKey", `${MODULE_ID}.ChangePrimary.Replace`, state.primary, state.primary[0]) : "");

    const choice = await foundry.applications.api.DialogV2.wait({
        window: { title: game.i18n.localize(`${MODULE_ID}.ChangePrimary.Title`), icon: "fa-solid fa-ghost" },
        content,
        buttons: [
            {
                action: "confirm",
                label: game.i18n.localize(`${MODULE_ID}.ChangePrimary.Confirm`),
                icon: "fa-solid fa-check",
                default: true,
                callback: (_event, _button, dialog) => ({
                    newKey: newKey ?? dialog.element.querySelector('[name="newKey"]')?.value,
                    replaceKey: dialog.element.querySelector('[name="replaceKey"]')?.value ?? null,
                }),
            },
            { action: "cancel", label: game.i18n.localize(`${MODULE_ID}.Dialog.Cancel`), icon: "fa-solid fa-xmark" },
        ],
        rejectClose: false,
    });
    return choice && typeof choice === "object" && candidates.includes(choice.newKey) ? choice : null;
}

/** The sheet's "change primary apparition" action: choose, then swap (the old Vessel is struck out, the new one becomes active). */
async function changePrimaryApparition(actor, { newKey = null } = {}) {
    if (!requireActorOwner(actor)) return false;
    const choice = await promptPrimaryChange(actor, { newKey });
    if (!choice) return false;
    return setPrimaryVessel(actor, choice.newKey, true, { replaceKey: choice.replaceKey });
}

/**
 * Keeps the focus-pool maximum in line with the primary set, through one Rule
 * Element on Apparition Attunement (Animist Dedication if that is all the
 * character has).
 *
 * - Normally every Vessel spell is a focus spell (+1 each from the system), and
 *   the Vessels that are not primary are taken off again: a "subtract" rule.
 * - With Circle of Spirits "the number of Focus Points in your focus pool is
 *   equal to the number of focus spells you have or the number of apparitions
 *   you are attuned to, whichever is higher (maximum 3)": nothing is subtracted
 *   and an "upgrade" rule raises the pool to the number of attuned apparitions
 *   (an upgrade only ever raises, so the higher of the two wins).
 */
async function syncPrimaryFocusRule(actor) {
    const attunement = findFeature(actor, APPARITION_ATTUNEMENT);
    const dedication = findFeature(actor, ANIMIST_DEDICATION);
    const parent = attunement ?? dedication;
    if (!parent) return;

    const state = getPrimaryVesselState(actor);
    const desired = [];
    if (findFeature(actor, CIRCLE_OF_SPIRITS)) {
        const attuned = Math.min(3, getBondedApparitionFeats(actor).length);
        if (attuned > 0) desired.push({ mode: "upgrade", value: attuned });
    } else {
        const subtracted = Math.max(0, state.vesselKeys.length - state.primary.length);
        if (subtracted > 0) desired.push({ mode: "subtract", value: subtracted, priority: 9 });
    }

    const isFocusRule = (rule) =>
        rule?.[MODULE_ID] === FOCUS_RULE_TAG && rule.key === "ActiveEffectLike" && rule.path === "system.resources.focus.max";

    const updates = [];
    for (const feat of [attunement, dedication]) {
        if (!feat) continue;
        const current = foundry.utils.deepClone(feat._source.system.rules ?? []);
        const existing = current.filter(isFocusRule);
        const wanted = feat === parent ? desired : [];
        const upToDate =
            existing.length === wanted.length &&
            wanted.every((rule) => existing.some((entry) => entry.mode === rule.mode && entry.value === rule.value));
        if (upToDate) continue;

        const rules = current.filter((rule) => !isFocusRule(rule));
        for (const rule of wanted) {
            rules.push({ key: "ActiveEffectLike", path: "system.resources.focus.max", ...rule, [MODULE_ID]: FOCUS_RULE_TAG });
        }
        updates.push({ _id: feat.id, "system.rules": rules });
    }

    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

/** Recompute the module-owned focus rule from the actor's current apparition state. */
async function syncFocusOverrideRule(actor) {
    const override = getFocusPointsOverride(actor);
    const attunement = findFeature(actor, APPARITION_ATTUNEMENT);
    const dedication = findFeature(actor, ANIMIST_DEDICATION);
    const parent = attunement ?? dedication;
    if (!parent) return;

    const isOverrideRule = (rule) =>
        rule?.[MODULE_ID] === FOCUS_OVERRIDE_RULE_TAG &&
        rule.key === "ActiveEffectLike" &&
        rule.path === "system.resources.focus.max" &&
        rule.mode === "override";

    const updates = [];
    for (const feat of [attunement, dedication]) {
        if (!feat) continue;
        const current = foundry.utils.deepClone(feat._source.system.rules ?? []);
        const existing = current.filter(isOverrideRule);
        const shouldHave = feat === parent && Number.isFinite(override);
        const upToDate = shouldHave ? existing.length === 1 && Number(existing[0].value) === Number(override) : existing.length === 0;
        if (upToDate) continue;

        const rules = current.filter((rule) => !isOverrideRule(rule));
        if (shouldHave) {
            rules.push({
                key: "ActiveEffectLike",
                mode: "override",
                path: "system.resources.focus.max",
                priority: 99,
                value: Number(override),
                [MODULE_ID]: FOCUS_OVERRIDE_RULE_TAG,
            });
        }
        updates.push({ _id: feat.id, "system.rules": rules });
    }

    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

async function syncCurrentPrimaryState(actor) {
    await syncPrimaryFocusRule(actor);
    await syncFocusOverrideRule(actor);
}

/**
 * PF2e emits this after the system has applied its normal overnight rest
 * updates. This module owns its daily apparition lifecycle, so it removes
 * only its own temporary content and clears the daily bond/primary state.
 * It does not hook pf2e-dailies internals.
 */
Hooks.on("pf2e.restForTheNight", (actor) => {
    if (!isEnabled() || game.system.id !== "pf2e" || !actorCanModify(actor)) return;

    void (async () => {
        try {
            await saveLastDayApparitionSnapshot(actor);
            const temporary = (actor.items ?? []).filter((item) => isTemporary(item));
            if (temporary.length)
                await actor.deleteEmbeddedDocuments(
                    "Item",
                    temporary.map((item) => item.id),
                );
            await pruneDeadItemGrants(actor);

            await actor.unsetFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG);
            await actor.unsetFlag(MODULE_ID, "bondedApparitions");
            await syncCurrentPrimaryState(actor);
            // The spells class features give (Heal & Harm, Avatar, the forms) are part of the next day's list too.
            await syncFeatureSpells(actor);
            // Relinquish Control: the permanent apparition is attuned again for the new day.
            await ensurePermanentApparition(actor);
            Hooks.callAll(`${MODULE_ID}:rest-cleanup`, actor, temporary.length);
        } catch (error) {
            notifyOperationFailed(error);
        }
    })();
});

/**
 * The apparition a character with Relinquish Control is tied to. The feat is found by its exact
 * compendium id; without it the stored choice is ignored.
 *
 * @param {Actor} actor
 * @returns {{ available: boolean, key: string|null, name: string }} `available`: the character has the feat.
 */
function getPermanentApparition(actor) {
    const available = !!findFeature(actor, RELINQUISH_CONTROL);
    const stored = actor?.getFlag(MODULE_ID, PERMANENT_APPARITION_FLAG);
    const key = available && typeof stored?.key === "string" && stored.key ? stored.key : null;
    return { available, key, name: key ? String(stored.name ?? "") : "" };
}

/**
 * Binds the permanent apparition if it is not bound (after the night's rest, a profile, "restore yesterday",
 * a repair). Idempotent; warns when the chosen apparition no longer exists.
 *
 * @param {Actor} actor
 * @param {{ autoPrimary?: boolean }} [options] Passed on to the bonding (profiles keep their own primary set).
 * @returns {Promise<string|null>} The key of the permanent apparition, or null if there is none / it could not be bound.
 */
async function ensurePermanentApparition(actor, { autoPrimary } = {}) {
    if (!isEnabled() || !actorCanModify(actor)) return null;
    const { key, name } = getPermanentApparition(actor);
    if (!key) return null;
    if (getBondedApparitionFeats(actor).some((feat) => getApparitionKey(feat) === key)) return key;

    const source = await fromUuid(key).catch(() => null);
    if (!source?.isOfType?.("feat")) {
        ui.notifications.warn(formatLocalized(`${MODULE_ID}.Notify.PermanentMissing`, { name: name || key }));
        return null;
    }
    await addApparition(actor, source, { silent: true, ...(autoPrimary === undefined ? {} : { autoPrimary }) });
    return key;
}

/**
 * Choose (or change) the permanent apparition and bind it at once.
 *
 * @param {Actor} actor
 * @param {string} key The uuid of the apparition.
 * @returns {Promise<boolean>}
 */
async function setPermanentApparition(actor, key) {
    if (!requireActorOwner(actor) || !getPermanentApparition(actor).available) return false;

    const source = await fromUuid(key).catch(() => null);
    if (!source?.isOfType?.("feat")) {
        ui.notifications.warn(formatLocalized(`${MODULE_ID}.Notify.PermanentMissing`, { name: key }));
        return false;
    }
    await actor.setFlag(MODULE_ID, PERMANENT_APPARITION_FLAG, { key: getApparitionKey(source) ?? key, name: source.name });
    await ensurePermanentApparition(actor);
    ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.PermanentSet`, { name: source.name }));
    return true;
}

function getApparitionProfiles(actor) {
    const raw = actor?.getFlag(MODULE_ID, PROFILES_FLAG);
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((profile) => profile && typeof profile === "object" && typeof profile.id === "string" && typeof profile.name === "string")
        .map((profile) => ({
            id: profile.id,
            name: profile.name.trim(),
            apparitions: Array.isArray(profile.apparitions)
                ? [...new Set(profile.apparitions.filter((key) => typeof key === "string" && key))]
                : [],
            primary: Array.isArray(profile.primary) ? [...new Set(profile.primary.filter((key) => typeof key === "string" && key))] : [],
            updatedAt: Number(profile.updatedAt) || 0,
        }))
        .filter((profile) => profile.name);
}

async function saveApparitionProfile(actor, name, { id = null } = {}) {
    if (!requireActorOwner(actor)) return null;
    const cleanName = String(name ?? "").trim();
    if (!cleanName) return null;
    const state = getApparitionState(actor);
    const vesselState = getPrimaryVesselState(actor);
    const profiles = getApparitionProfiles(actor);
    const existing =
        (id && profiles.find((profile) => profile.id === id)) ||
        profiles.find((profile) => profile.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
    const profile = {
        id: existing?.id ?? foundry.utils.randomID(),
        name: cleanName,
        apparitions: [...state.bondedKeys],
        primary: [...vesselState.primary],
        updatedAt: Date.now(),
    };
    const next = existing ? profiles.map((entry) => (entry.id === profile.id ? profile : entry)) : [...profiles, profile];
    await actor.setFlag(MODULE_ID, PROFILES_FLAG, next);
    return profile;
}

async function deleteApparitionProfile(actor, profileId) {
    if (!requireActorOwner(actor)) return false;
    const profiles = getApparitionProfiles(actor);
    const next = profiles.filter((profile) => profile.id !== profileId);
    if (next.length === profiles.length) return false;
    if (next.length) await actor.setFlag(MODULE_ID, PROFILES_FLAG, next);
    else await actor.unsetFlag(MODULE_ID, PROFILES_FLAG);
    return true;
}

async function applyApparitionProfile(actor, profileId) {
    if (!requireActorOwner(actor)) return { added: 0, removed: 0, missing: 0 };
    const profile = getApparitionProfiles(actor).find((entry) => entry.id === profileId);
    if (!profile) return { added: 0, removed: 0, missing: 0 };
    const target = new Set(profile.apparitions);
    const permanentKey = getPermanentApparition(actor).key; // never unbound by a profile
    let added = 0,
        removed = 0,
        missing = 0;
    for (const feat of getBondedApparitionFeats(actor)) {
        const key = getApparitionKey(feat);
        if (key && key !== permanentKey && !target.has(key)) {
            const result = await removeApparition(actor, feat, { silent: true });
            if (result.removedFeatId || result.removed.length || result.updated.length) removed++;
        }
    }
    const current = new Set(
        getBondedApparitionFeats(actor)
            .map((feat) => getApparitionKey(feat))
            .filter(Boolean),
    );
    for (const key of target) {
        if (current.has(key)) continue;
        const source = await fromUuid(key);
        if (!source?.isOfType?.("feat")) {
            missing++;
            continue;
        }
        const result = await addApparition(actor, source, { silent: true, autoPrimary: false });
        if (result.apparitionFeatId) added++;
    }
    await ensurePermanentApparition(actor, { autoPrimary: false });
    const state = getPrimaryVesselState(actor);
    const validPrimary = profile.primary.filter((key) => state.vesselKeys.some((entry) => entry.key === key));
    await syncPrimaryVessels(actor, { primary: validPrimary });
    await syncBondedApparitionsFlag(actor);
    await syncCurrentPrimaryState(actor);
    return { added, removed, missing };
}

function getLastDayApparitionSnapshot(actor) {
    const raw = actor?.getFlag(MODULE_ID, LAST_DAY_FLAG);
    if (!raw || typeof raw !== "object") return null;
    return {
        apparitions: Array.isArray(raw.apparitions) ? [...new Set(raw.apparitions.filter((key) => typeof key === "string" && key))] : [],
        primary: Array.isArray(raw.primary) ? [...new Set(raw.primary.filter((key) => typeof key === "string" && key))] : [],
        savedAt: Number(raw.savedAt) || 0,
    };
}

async function saveLastDayApparitionSnapshot(actor) {
    if (!actorCanModify(actor)) return null;
    const snapshot = {
        apparitions: getApparitionState(actor).bondedKeys,
        primary: getPrimaryVesselState(actor).primary,
        savedAt: Date.now(),
    };
    if (snapshot.apparitions.length) await actor.setFlag(MODULE_ID, LAST_DAY_FLAG, snapshot);
    return snapshot;
}

async function restoreLastDayApparitions(actor) {
    if (!requireActorOwner(actor)) return { restored: 0, missing: 0 };
    const snapshot = getLastDayApparitionSnapshot(actor);
    if (!snapshot?.apparitions.length) return { restored: 0, missing: 0 };
    let restored = 0,
        missing = 0;
    for (const key of snapshot.apparitions) {
        if (getBondedApparitionFeats(actor).some((feat) => getApparitionKey(feat) === key)) continue;
        const item = await fromUuid(key);
        if (!item?.isOfType?.("feat")) {
            missing++;
            continue;
        }
        const result = await addApparition(actor, item, { silent: true, autoPrimary: false });
        if (result.apparitionFeatId) restored++;
    }
    await ensurePermanentApparition(actor, { autoPrimary: false });
    const state = getPrimaryVesselState(actor);
    const validPrimary = snapshot.primary.filter((key) => state.vesselKeys.some((entry) => entry.key === key));
    await syncPrimaryVessels(actor, { primary: validPrimary });
    await syncBondedApparitionsFlag(actor);
    await syncCurrentPrimaryState(actor);
    return { restored, missing };
}

async function repairApparitionActor(actor) {
    if (!requireActorOwner(actor)) return { repaired: 0, removed: 0, missing: 0, warnings: [] };
    let repaired = 0,
        removed = 0,
        missing = 0;
    const warnings = [];
    try {
        const keys = new Set(
            getBondedApparitionFeats(actor)
                .map((feat) => getApparitionKey(feat))
                .filter(Boolean),
        );
        const flagged = actor.getFlag(MODULE_ID, "bondedApparitions");
        if (Array.isArray(flagged)) for (const key of flagged) if (typeof key === "string") keys.add(key);
        // A previous repair/unbond operation can leave a managed spell or Lore
        // with a provenance claim while its apparition feat itself is missing.
        // Use those claims as recovery hints instead of requiring the feat to
        // survive; this makes the one-click repair useful for genuinely
        // orphaned actor state as well.
        for (const item of [...actor.itemTypes.spell, ...actor.itemTypes.lore]) {
            for (const key of getSpellApparitionSources(item)) if (typeof key === "string" && key && !isFeatureClaim(key)) keys.add(key);
            const originKey = getManagedOrigin(item)?.key;
            if (typeof originKey === "string" && originKey && !isFeatureClaim(originKey)) keys.add(originKey);
        }
        for (const key of keys) {
            const source = await fromUuid(key);
            if (!source?.isOfType?.("feat")) {
                missing++;
                warnings.push(key);
                continue;
            }
            const result = await addApparition(actor, source, { silent: true, autoPrimary: false });
            repaired += result.created.length + result.updated.length;
        }
        const bonded = getBondedApparitionFeats(actor);
        if (bonded.length) {
            await actor.updateEmbeddedDocuments(
                "Item",
                bonded.map((feat) => ({
                    _id: feat.id,
                    [`flags.${MODULE_ID}.temporary`]: true,
                    [`flags.${MODULE_ID}.${ORIGIN_FLAG}`]: {
                        type: "apparition",
                        key: getApparitionKey(feat),
                        grant: "feat",
                        sourceUuid: getApparitionKey(feat),
                    },
                })),
            );
        }
        removed += await pruneLeftoverApparitions(actor);
        await syncFeatureSpells(actor);
        await ensurePermanentApparition(actor);
        await syncBondedApparitionsFlag(actor);
        await ensureAutoPrimary(actor);
        await syncCurrentPrimaryState(actor);
        Hooks.callAll(`${MODULE_ID}:apparition-repaired`, actor, { repaired, removed, missing, warnings });
        return { repaired, removed, missing, warnings };
    } catch (error) {
        notifyOperationFailed(error);
        return { repaired, removed, missing, warnings, error: String(error) };
    }
}

/** Actor flag storing the manual focus-pool maximum. */
const FOCUS_OVERRIDE_FLAG_KEY = "focusOverride";
const FOCUS_OVERRIDE_RULE_TAG = "focus-override";

function getFocusPointsOverride(actor) {
    const value = actor?.getFlag(MODULE_ID, FOCUS_OVERRIDE_FLAG_KEY);
    if (typeof value === "number" && Number.isFinite(value)) return value;

    // One-time compatibility read for the old marker item. The next write
    // migrates it into the actor flag and deletes that legacy item.
    const legacy = actor?.itemTypes?.feat?.find((feat) => feat.flags?.[MODULE_ID]?.[FOCUS_OVERRIDE_FLAG_KEY]);
    const rule = legacy?.system?.rules?.find((entry) => entry.key === "ActiveEffectLike" && entry.path === "system.resources.focus.max");
    return typeof rule?.value === "number" ? rule.value : null;
}

async function setFocusPointsOverride(actor, value) {
    if (!requireActorOwner(actor)) return;

    try {
        const legacy = actor.itemTypes.feat.find((feat) => feat.flags?.[MODULE_ID]?.[FOCUS_OVERRIDE_FLAG_KEY]);
        if (value === null || value === undefined) {
            await actor.unsetFlag(MODULE_ID, FOCUS_OVERRIDE_FLAG_KEY);
            if (legacy) await legacy.delete();
            await syncFocusOverrideRule(actor);
            return;
        }

        await actor.setFlag(MODULE_ID, FOCUS_OVERRIDE_FLAG_KEY, Math.max(0, Math.trunc(value)));
        if (legacy) await legacy.delete();
        await syncFocusOverrideRule(actor);
    } catch (error) {
        notifyOperationFailed(error);
    }
}

/**
 * Extract the spell UUIDs listed in an apparition's "Apparition
 * Spellcasting spells" list - the first `<ul>` in its description.
 *
 * @param {Item} apparitionItem
 * @returns {string[]}
 */
function parseApparitionSpellUuids(apparitionItem) {
    const list = getApparitionDescriptionListElement(apparitionItem);
    if (!list) return [];

    const uuids = [];
    SPELL_LINK_REGEX.lastIndex = 0;
    let match;
    while ((match = SPELL_LINK_REGEX.exec(list.textContent ?? ""))) {
        uuids.push(inlineMatchToUuid(match));
    }

    return uuids;
}

/**
 * Extract the single Vessel (focus) spell UUID from an apparition's
 * description: the element right after the spell-list `<ul>`.
 *
 * @param {Item} apparitionItem
 * @returns {string|null}
 */
function parseApparitionVesselUuid(apparitionItem) {
    const list = getApparitionDescriptionListElement(apparitionItem);
    const vesselEl = list?.nextElementSibling;
    if (!vesselEl) return null;

    SPELL_LINK_REGEX.lastIndex = 0;
    const match = SPELL_LINK_REGEX.exec(vesselEl.textContent ?? "");
    return match ? inlineMatchToUuid(match) : null;
}

function getApparitionDescriptionListElement(apparitionItem) {
    const container = document.createElement("div");
    // `.description` (trimmed `system.description.value`) is the normal
    // path for a live ItemPF2e document; fall back to the raw system field
    // directly in case a raw source object or compendium index entry ever
    // ends up here instead of an instantiated document.
    const html = apparitionItem?.description ?? apparitionItem?.system?.description?.value ?? "";
    container.innerHTML = html;
    return container.querySelector("ul");
}

/**
 * Extract the Lore skill names an apparition grants: the "Apparition Skills"
 * line, the `<p>` right after the description's `<hr/>`. The paragraph is
 * cloned and its leading `<strong>` label stripped, so incidental whitespace
 * or markup does not break the parsing.
 *
 * @param {Item} apparitionItem
 * @returns {string[]} Lore names, each ending in " Lore".
 */
function parseApparitionLores(apparitionItem) {
    const container = document.createElement("div");
    const html = apparitionItem?.description ?? apparitionItem?.system?.description?.value ?? "";
    container.innerHTML = html;

    const loresEl = container.querySelector("hr + p");
    if (!loresEl) return [];

    const clone = loresEl.cloneNode(true);
    clone.querySelector("strong")?.remove();
    const text = clone.textContent?.trim() ?? "";

    return text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => (/ Lore$/i.test(name) ? name : `${name} Lore`));
}

/**
 * The apparitions bonded to the actor: embedded feats carrying the
 * "animist-apparition" trait tag, optionally without the one whose key is
 * `exclude`. Bonding adds the tag to the actor's copy, so custom apparitions
 * are found too.
 *
 * @param {Actor} actor
 * @param {{ exclude?: string|null }} [options]
 * @returns {Item[]}
 */
function getBondedApparitionFeats(actor, { exclude = null } = {}) {
    return (actor.itemTypes?.feat ?? []).filter((feat) => {
        if (!feat.system?.traits?.otherTags?.includes("animist-apparition")) return false;
        if (exclude && getApparitionKey(feat) === exclude) return false;
        return true;
    });
}

/**
 * @param {object} entry SpellcastingEntryPF2e
 * @param {string} uuid
 * @param {(flagsSource: object) => boolean} identifierCheck `hasApparitionIdentifier` or `hasVesselIdentifier`.
 * @returns {object|null} The matching SpellPF2e already on the entry, if any.
 */
function findEntrySpellBySource(entry, uuid, identifierCheck) {
    for (const spell of entry.spells.values()) {
        const managed = identifierCheck(spell.flags) || getSpellApparitionSources(spell).length > 0;
        if (managed && spell.sourceId === uuid) return spell;
    }
    return null;
}

/** Stores the keys of the bonded apparitions on the actor (`bondedApparitions` flag).
 * @returns {Promise<string[]>} The keys.
 */
async function syncBondedApparitionsFlag(actor) {
    const keys = getBondedApparitionFeats(actor)
        .map((feat) => getApparitionKey(feat))
        .filter(Boolean);
    if (keys.length) await actor.setFlag(MODULE_ID, "bondedApparitions", [...new Set(keys)]);
    else await actor.unsetFlag(MODULE_ID, "bondedApparitions");
    return keys;
}

/**
 * Detach a bonded apparition from an actor: every spell - in either the
 * Apparition Spellcasting entry or the Vessel Spells entry - and every Lore
 * skill that only this apparition still grants is deleted outright; one
 * shared with another currently-tracked apparition is left in place and
 * just has this apparition dropped from its provenance list. The actor's
 * own copy of the apparition's feat item, if any, is deleted too -
 * `removeApparition` detaches the apparition itself, not just what it
 * grants. Calling this for an apparition whose spells, Lore skills, and
 * feat are already gone is a no-op - nothing is deleted or duplicated.
 *
 * @param {Actor} actor
 * @param {Item|string} apparition The bonded apparition feat item, or its UUID.
 * @param {{ silent?: boolean }} [options] `silent` suppresses the result notification (bulk cleanup).
 * @returns {Promise<{ removed: string[], updated: string[], removedFeatId?: string }>}
 */
async function removeApparition(actor, apparition, { silent = false } = {}) {
    const result = { removed: [], updated: [] };
    if (!isEnabled() || game.system.id !== "pf2e") {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.ModuleDisabled`));
        return result;
    }
    if (!requireActorOwner(actor)) return result;

    try {
        const apparitionItem = await resolveApparitionItem(apparition);
        const key = getApparitionKey(apparitionItem);
        if (!key) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.ApparitionNotFound`));
            return result;
        }

        // Either entry may be missing (e.g. after a rest deleted it) - the
        // feat, Lore skills and any leftovers are still removed below.
        const spellsEntry = getApparitionEntry(actor);
        const vesselEntry = getVesselEntry(actor);

        // This apparition's own current spell list, used to recognize legacy/
        // untracked spells (see the "Provenance tracking" note above) as
        // actually being one of its own, before touching them.
        const apparitionSpellUuids = new Set(parseApparitionSpellUuids(apparitionItem));
        const apparitionVesselUuid = parseApparitionVesselUuid(apparitionItem);
        const apparitionLoreNames = new Set(parseApparitionLores(apparitionItem).map(normalizeLoreName));

        // Every other apparition still bonded to the actor, with their own
        // spell lists (and Lore names) pre-parsed once, so a legacy spell or a
        // Lore skill shared with one of them can be recognized instead of
        // being wrongly deleted - apparitions frequently grant overlapping
        // Lore skills (e.g. two different apparitions both granting
        // "Fortune-Telling Lore").
        const otherApparitions = getBondedApparitionFeats(actor, { exclude: key }).map((item) => ({
            key: getApparitionKey(item),
            spellUuids: new Set(parseApparitionSpellUuids(item)),
            vesselUuid: parseApparitionVesselUuid(item),
            loreNames: new Set(parseApparitionLores(item).map(normalizeLoreName)),
        }));

        const toDelete = [];
        const toUpdate = [];

        const finishRemoval = (spell, remaining) => {
            if (remaining.length) {
                const origin = getManagedOrigin(spell);
                toUpdate.push({
                    _id: spell.id,
                    [`flags.${APPARITION_SOURCES_PATH}`]: remaining,
                    [`flags.${MODULE_ID}.${ORIGIN_FLAG}`]: {
                        type: "apparition",
                        key: remaining[0],
                        grant: origin?.grant ?? "spell",
                        ...(spell.sourceId ? { sourceUuid: spell.sourceId } : {}),
                    },
                });
                result.updated.push(spell.id);
            } else {
                toDelete.push(spell.id);
                result.removed.push(spell.id);
            }
        };

        const collectRemovals = (entry, identifierCheck, targetUuids, isVessel) => {
            if (!entry) return;

            for (const spell of entry.spells.values()) {
                const moduleSources = getSpellApparitionSources(spell);
                if (!identifierCheck(spell.flags) && !moduleSources.length) continue;

                const sources = moduleSources;

                if (sources.length) {
                    if (!sources.includes(key)) continue;
                    const remaining = collectCurrentGrantKeys(actor, {
                        sourceId: spell.sourceId,
                        vessel: isVessel,
                    }).filter((source) => source !== key);
                    // A spell a class feature grants (Heal, Avatar, ...) stays for as long as the feature does.
                    finishRemoval(spell, [...new Set([...remaining, ...sources.filter(isFeatureClaim)])]);
                    continue;
                }

                // Untracked ("legacy") spell: only handle it if it's actually
                // one of this apparition's own spells...
                if (!spell.sourceId || !targetUuids.has(spell.sourceId)) continue;

                // ...and backfill its real provenance from every other
                // currently-bonded apparition, so a spell shared with one of
                // them survives (and is correctly tracked from now on) instead
                // of being deleted out from under it.
                const remaining = otherApparitions
                    .filter((other) => (isVessel ? other.vesselUuid === spell.sourceId : other.spellUuids.has(spell.sourceId)))
                    .map((other) => other.key);
                finishRemoval(spell, remaining);
            }
        };

        collectRemovals(spellsEntry, hasApparitionIdentifier, apparitionSpellUuids, false);
        collectRemovals(vesselEntry, hasVesselIdentifier, apparitionVesselUuid ? new Set([apparitionVesselUuid]) : new Set(), true);

        // Lore skills this apparition grants, mirroring the same tracked/legacy
        // handling as spells above - a Lore skill another still-bonded
        // apparition also grants is kept (just detached from this one), and an
        // untracked Lore item is only touched if its name actually matches one
        // of this apparition's own.
        for (const loreItem of actor.itemTypes.lore) {
            const normalizedName = normalizeLoreName(loreItem.name);
            const sources = getSpellApparitionSources(loreItem);

            if (sources.length) {
                if (!sources.includes(key)) continue;
                const remaining = collectCurrentGrantKeys(actor, { loreName: loreItem.name }).filter((source) => source !== key);
                finishRemoval(loreItem, [...new Set(remaining)]);
                continue;
            }

            if (!apparitionLoreNames.has(normalizedName)) continue;

            const remaining = otherApparitions.filter((other) => other.loreNames.has(normalizedName)).map((other) => other.key);
            finishRemoval(loreItem, remaining);
        }

        // `removeApparition` detaches the apparition itself, not just its
        // spells - without this, the actor's own copy of the feat (however it
        // got there: normal daily prep, or `addApparition` bonding one from
        // scratch) would stick around forever, and `getBondedApparitionFeats`
        // would keep reporting this apparition as still bonded.
        const apparitionFeat = actor.itemTypes.feat.find((feat) => getApparitionKey(feat) === key);
        if (apparitionFeat) {
            toDelete.push(apparitionFeat.id);
            result.removedFeatId = apparitionFeat.id;
        }

        if (toUpdate.length) await actor.updateEmbeddedDocuments("Item", toUpdate);
        if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
        await pruneDeadItemGrants(actor);
        await pruneOrphanedVesselSpells(actor);
        await syncBondedApparitionsFlag(actor);
        if (isAutoPrimaryEnabled()) await ensureAutoPrimary(actor);
        await syncPrimaryVessels(actor);
        Hooks.callAll(`${MODULE_ID}:apparition-unbonded`, actor, { key, apparition: apparitionItem });

        if (!silent) {
            const messageKey =
                toDelete.length || toUpdate.length
                    ? `${MODULE_ID}.Notify.ApparitionRemoved`
                    : `${MODULE_ID}.Notify.ApparitionAlreadyAbsent`;
            ui.notifications.info(formatLocalized(messageKey, { apparition: apparitionItem?.name ?? key }));
        }

        return result;
    } catch (error) {
        notifyOperationFailed(error);
        return result;
    }
}

/** Supreme Incarnation (level 19+) adds one 10th-rank spell slot to the Apparition Spellcasting entry. */
function hasSupremeSlot(actor) {
    return (actor.level ?? 1) >= 19 && !!findFeature(actor, SUPREME_INCARNATION);
}

/**
 * Keeps the spells given by class feats/features (Heal & Harm, Avatar, Animal /
 * Aerial / Monstrosity Form) in the Apparition Spellcasting entry in step with
 * what the actor has: added, with the same single-Cast-button treatment, for
 * every feature found by its exact compendium id; removed again when the
 * feature is gone. Idempotent.
 *
 * @param {Actor} actor
 * @returns {Promise<{ added: number, removed: number }>}
 */
async function syncFeatureSpells(actor) {
    const result = { added: 0, removed: 0 };
    if (!isEnabled() || game.system.id !== "pf2e" || !actor || !actorCanModify(actor) || featureSyncActors.has(actor.id)) return result;

    featureSyncActors.add(actor.id);
    try {
        const presentDefinitions = FEATURE_SPELLS.filter((definition) => findFeature(actor, definition));
        const presentKeys = new Set(presentDefinitions.map(featureClaimKey));

        // A feature the actor no longer has takes its claims off the spells.
        const toDelete = [];
        const toUpdate = [];
        const existingEntry = getApparitionEntry(actor);
        for (const spell of existingEntry?.spells.values() ?? []) {
            const sources = getSpellApparitionSources(spell);
            const stale = sources.filter((key) => isFeatureClaim(key) && !presentKeys.has(key));
            if (!stale.length) continue;
            const remaining = sources.filter((key) => !stale.includes(key));
            if (remaining.length) toUpdate.push({ _id: spell.id, [`flags.${APPARITION_SOURCES_PATH}`]: remaining });
            else toDelete.push(spell.id);
        }
        if (toUpdate.length) await actor.updateEmbeddedDocuments("Item", toUpdate);
        if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete);
        result.removed = toDelete.length;

        if (presentDefinitions.length && actorHasApparitionAccess(actor)) {
            const entry = existingEntry ?? (await ensureApparitionSpellcastingEntry(actor));
            if (hasSupremeSlot(actor) && !((entry.system.slots?.slot10?.max ?? 0) > 0)) {
                await entry.update({ "system.slots.slot10": { value: 1, max: 1 } });
            }

            const claimUpdates = [];
            const toBuild = [];
            for (const definition of presentDefinitions) {
                const claim = featureClaimKey(definition);
                for (const uuid of definition.spells) {
                    const existing = findEntrySpellBySource(entry, uuid, hasApparitionIdentifier);
                    if (!existing) {
                        toBuild.push({
                            uuid,
                            entry,
                            identifierFlagValue: getApparitionIdentifier(),
                            apparitionKey: claim,
                            clearSignature: true,
                            maxRank: getEntryMaxRank(entry),
                        });
                        continue;
                    }
                    const sources = getSpellApparitionSources(existing);
                    if (!sources.includes(claim))
                        claimUpdates.push({ _id: existing.id, [`flags.${APPARITION_SOURCES_PATH}`]: [...sources, claim] });
                }
            }
            if (claimUpdates.length) await actor.updateEmbeddedDocuments("Item", claimUpdates);

            const built = (await Promise.all(toBuild.map(({ uuid, ...options }) => buildManagedSpellSource(uuid, options)))).filter(
                Boolean,
            );
            if (built.length) await actor.createEmbeddedDocuments("Item", built);
            result.added = built.length;
        }
    } catch (error) {
        notifyOperationFailed(error);
    } finally {
        featureSyncActors.delete(actor.id);
    }
    return result;
}

// Gaining or losing one of those feats/features updates the list right away.
const featureSourceIds = new Set([...FEATURE_SPELLS.flatMap((definition) => definition.sources), ...APPARITION_ATTUNEMENT.sources]);
for (const hook of ["createItem", "deleteItem"]) {
    Hooks.on(hook, (item, _options, userId) => {
        const actor = item.parent;
        if (userId !== game.user.id || item.type !== "feat" || !actor?.isOfType?.("character")) return;
        if (!featureSourceIds.has(getFeatSource(item))) return;
        void syncFeatureSpells(actor);
    });
}

/**
 * The highest spell rank the given spontaneous entry currently has any
 * slots for - i.e. what the actor can actually prepare/cast right now,
 * reading it straight off the entry's own (already correctly computed)
 * slot data rather than re-deriving a character-level formula ourselves.
 *
 * @param {object} entry SpellcastingEntryPF2e
 * @returns {number}
 */
function getEntryMaxRank(entry) {
    const slots = entry?.system?.slots;
    if (!slots) return 0;

    let max = 0;
    for (let rank = 1; rank <= 10; rank++) {
        if ((slots[`slot${rank}`]?.max ?? 0) > 0) max = rank;
    }
    return max;
}

/**
 * Whether the given bonded apparition is still actually granting anything -
 * any spell (Apparition Spellcasting or Vessel), or any Lore skill -
 * currently on the actor. A feat can outlive everything it granted (for
 * example after an external reset removed the spells and Lore skills),
 * leaving an apparition "bonded" in name only; this detects that state.
 *
 * @param {Actor} actor
 * @param {Item} apparitionItem
 * @returns {boolean}
 */
function apparitionStillGrantsAnything(actor, apparitionItem) {
    const key = getApparitionKey(apparitionItem);
    if (!key) return false;

    const spellsEntry = getApparitionEntry(actor);
    const vesselEntry = getVesselEntry(actor);
    const spellUuids = new Set(parseApparitionSpellUuids(apparitionItem));
    const vesselUuid = parseApparitionVesselUuid(apparitionItem);
    const loreNames = new Set(parseApparitionLores(apparitionItem).map(normalizeLoreName));

    const hasInEntry = (entry, targetUuids) => {
        if (!entry) return false;
        for (const spell of entry.spells.values()) {
            const sources = getSpellApparitionSources(spell);
            if (sources.includes(key)) return true;
            if (!sources.length && spell.sourceId && targetUuids.has(spell.sourceId)) return true;
        }
        return false;
    };

    if (hasInEntry(spellsEntry, spellUuids)) return true;
    if (hasInEntry(vesselEntry, vesselUuid ? new Set([vesselUuid]) : new Set())) return true;

    if (supportsLoreRuleElements()) {
        for (const name of parseApparitionLores(apparitionItem)) {
            const details = getLoreRuleDetails(name, actor);
            const skillPath = details?.skillPath?.replace(/^system\./, "");
            if (skillPath && foundry.utils.getProperty(actor.system, skillPath) != null) return true;
        }
    }

    for (const loreItem of actor.itemTypes.lore) {
        const sources = getSpellApparitionSources(loreItem);
        if (sources.includes(key)) return true;
        if (!sources.length && loreNames.has(normalizeLoreName(loreItem.name))) return true;
    }

    return false;
}

/**
 * Build the source data for a brand-new spell copied from `uuid` onto
 * `entry`, tagged with this module's provenance flag for `apparitionKey`.
 *
 * @param {string} uuid
 * @param {object} options
 * @param {object} options.entry SpellcastingEntryPF2e to attach the spell to.
 * @param {string} options.identifierFlagValue The module's `identifier` flag value for this entry.
 * @param {string} options.apparitionKey
 * @param {boolean} options.clearSignature Whether to explicitly force `system.location.signature` off (only meaningful for the spontaneous entry).
 * @param {number} [options.maxRank] If given, a non-cantrip spell above this rank is skipped (returns null) - a rank the actor cannot cast yet is never granted. Not meaningful for the Vessel (focus) entry, which isn't rank-limited the same way.
 * @returns {Promise<object|null>}
 */
async function buildManagedSpellSource(uuid, { entry, identifierFlagValue, apparitionKey, clearSignature, maxRank }) {
    const spellDoc = await fromUuid(uuid);
    if (!spellDoc?.isOfType?.("spell")) return null;

    if (typeof maxRank === "number" && !spellDoc.isCantrip) {
        const rank = spellDoc.baseRank ?? spellDoc.system?.level?.value ?? 1;
        if (rank > maxRank) return null;
    }

    const source = spellDoc.toObject();
    source._id = foundry.utils.randomID();
    foundry.utils.setProperty(source, "system.location.value", entry.id);
    if (clearSignature) {
        foundry.utils.setProperty(source, "system.location.signature", false);
    }
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.identifier`, identifierFlagValue);
    foundry.utils.setProperty(source, `flags.${APPARITION_SOURCES_PATH}`, [apparitionKey]);
    // Stamp the compendium origin explicitly so `spell.sourceId` (used to
    // detect an already-present spell) is reliable regardless of how the
    // actor's copy ends up being created.
    foundry.utils.setProperty(source, "_stats.compendiumSource", uuid);
    setManagedOrigin(source, {
        key: apparitionKey,
        grant: identifierFlagValue === getVesselIdentifier() ? "vessel" : "spell",
        sourceUuid: uuid,
    });

    return markTemporary(source);
}

/**
 * Spontaneous spell slots per Animist level (index 0 = level 1), ranks 1-9
 * left to right. Used to size the Apparition Spellcasting entry that
 * `ensureApparitionSpellcastingEntry` creates.
 */
const ANIMIST_SPONTANEOUS_SLOTS_BY_LEVEL = [
    [1, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 0, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 0, 0, 0, 0],
    [2, 2, 2, 1, 1, 0, 0, 0, 0],
    [2, 2, 2, 2, 1, 1, 0, 0, 0],
    [2, 2, 2, 2, 1, 1, 0, 0, 0],
    [2, 2, 2, 2, 2, 1, 1, 0, 0],
    [2, 2, 2, 2, 2, 1, 1, 0, 0],
    [2, 2, 2, 2, 2, 2, 1, 1, 0],
    [2, 2, 2, 2, 2, 2, 1, 1, 0],
    [2, 2, 2, 2, 2, 2, 2, 1, 1],
    [2, 2, 2, 2, 2, 2, 2, 1, 1],
    [2, 2, 2, 2, 2, 2, 2, 2, 1],
    [2, 2, 2, 2, 2, 2, 2, 2, 1],
];

/**
 * @param {Actor} actor
 * @returns {number} The highest spell rank an Animist of this level can cast.
 */
function getAnimistMaxSpellRank(actor) {
    return Math.max(1, Math.ceil((actor.level ?? 1) / 2));
}

/**
 * Creates the Apparition Spellcasting entry when the actor has none, sized for
 * the actor's level from the slot table above.
 *
 * Without it `addApparition` could only fill an existing entry: on a character
 * whose entry was removed (for example after every apparition was unbonded) it
 * would grant the Vessel spell and the Lore skills but silently drop every
 * Apparition Spellcasting spell.
 *
 * The entry is a plain recreation: it does not know a custom slot count that a
 * GM edited by hand on a previous entry.
 *
 * @param {Actor} actor
 * @returns {Promise<object>} The (possibly newly-created) spontaneous entry.
 */
async function ensureApparitionSpellcastingEntry(actor) {
    const existing = getApparitionEntry(actor);
    if (existing) return existing;

    const level = Math.clamp(actor.level ?? 1, 1, 20);
    const table = ANIMIST_SPONTANEOUS_SLOTS_BY_LEVEL[level - 1];
    const maxRank = Math.min(getAnimistMaxSpellRank(actor), 9);

    const slots = {};
    for (let rank = 1; rank <= maxRank; rank++) {
        const value = table[rank - 1] ?? 0;
        slots[`slot${rank}`] = { value, max: value };
    }
    if (hasSupremeSlot(actor)) slots.slot10 = { value: 1, max: 1 };

    const source = {
        type: "spellcastingEntry",
        // Deliberately an English literal rather than a localized string: a
        // translation module for the system is the single source of truth for
        // translated names.
        name: "Apparition Spellcasting",
        system: {
            ability: { value: actor.classDC?.attribute || "wis" },
            prepared: { value: "spontaneous" },
            showSlotlessLevels: { value: false },
            proficiency: { value: 1, slug: "" },
            tradition: { value: "divine" },
            slots,
        },
        flags: { [MODULE_ID]: { identifier: getApparitionIdentifier(), temporary: true } },
    };

    const [created] = await actor.createEmbeddedDocuments("Item", [source]);
    return created;
}

/**
 * Same idea as `ensureApparitionSpellcastingEntry`, for the separate
 * Vessel Spells (focus) entry - a focus entry has no `system.slots` of its
 * own (focus points come from the actor's normal `system.resources.focus`
 * pool instead), so there's no slot table to size here.
 *
 * @param {Actor} actor
 * @returns {Promise<object>} The (possibly newly-created) focus entry.
 */
async function ensureVesselSpellcastingEntry(actor) {
    const existing = getVesselEntry(actor);
    if (existing) return existing;

    const source = {
        type: "spellcastingEntry",
        // Same reasoning as `ensureApparitionSpellcastingEntry` above - kept
        // in English on purpose.
        name: "Vessel Spells",
        system: {
            ability: { value: actor.classDC?.attribute || "wis" },
            prepared: { value: "focus" },
            showSlotlessLevels: { value: false },
            proficiency: { value: 1, slug: "" },
            tradition: { value: "divine" },
        },
        flags: { [MODULE_ID]: { identifier: getVesselIdentifier(), temporary: true } },
    };

    const [created] = await actor.createEmbeddedDocuments("Item", [source]);
    return created;
}

/**
 * Bonds an apparition to an actor. Creates whatever the apparition grants that
 * the actor does not have yet - the spells of its Apparition Spellcasting list
 * the actor can currently cast (never above the entry's highest rank), its
 * Vessel spell and its Lore skills - and makes sure the actor owns a copy of
 * the apparition feat itself.
 *
 * Anything already present (tracked as coming from this apparition, shared
 * with another bonded one, or created by other means) stays a single item and
 * only gains this apparition in its provenance list. Calling this for an
 * apparition that is already fully bonded creates nothing twice.
 *
 * @param {Actor} actor
 * @param {Item|string} apparition The apparition feat item (embedded, world, or compendium), or its UUID.
 * @returns {Promise<{ created: string[], updated: string[], apparitionFeatId?: string }>}
 */
async function addApparition(actor, apparition, { silent = false, autoPrimary = true } = {}) {
    const result = { created: [], updated: [] };
    if (!isEnabled() || game.system.id !== "pf2e") {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.ModuleDisabled`));
        return result;
    }
    if (!requireActorOwner(actor)) return result;

    try {
        const apparitionItem = await resolveApparitionItem(apparition);
        const key = getApparitionKey(apparitionItem);
        if (!key || !apparitionItem?.isOfType?.("feat")) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.ApparitionNotFound`));
            return result;
        }

        // Read what the apparition grants first, so a missing entry can be
        // created on demand instead of silently dropping its spells (see
        // `ensureApparitionSpellcastingEntry`).
        const apparitionSpellUuidsForEntry = parseApparitionSpellUuids(apparitionItem);
        const apparitionVesselUuidForEntry = parseApparitionVesselUuid(apparitionItem);

        let spellsEntry = getApparitionEntry(actor);
        if (!spellsEntry && apparitionSpellUuidsForEntry.length) {
            spellsEntry = await ensureApparitionSpellcastingEntry(actor);
        }

        let vesselEntry = getVesselEntry(actor);
        if (!vesselEntry && apparitionVesselUuidForEntry) {
            vesselEntry = await ensureVesselSpellcastingEntry(actor);
        }

        const spellUuids = spellsEntry ? apparitionSpellUuidsForEntry : [];
        const vesselUuid = vesselEntry ? apparitionVesselUuidForEntry : null;

        const wasBonded = getBondedApparitionFeats(actor).some((feat) => getApparitionKey(feat) === key);
        const apparitionFeat = await ensureApparitionFeatOnActor(actor, apparitionItem, key);
        result.apparitionFeatId = apparitionFeat.id;
        await syncBondedApparitionsFlag(actor);

        const toCreate = [];
        const toUpdate = [];
        // Spells to create are collected here and resolved together with
        // Promise.all, rather than awaiting one `fromUuid` at a time.
        const toBuild = [];

        const claimExisting = (existing, { vessel = false, sourceId = null, loreName = null } = {}) => {
            const discovered = collectCurrentGrantKeys(actor, { sourceId, loreName, vessel });
            const previous = getSpellApparitionSources(existing);
            const claims = [...new Set([...previous, ...discovered, key])];
            if (
                claims.length !== previous.length ||
                claims.some((value, index) => value !== previous[index]) ||
                !getManagedOrigin(existing)
            ) {
                const originKey = claims[0] ?? key;
                toUpdate.push({
                    _id: existing.id,
                    [`flags.${APPARITION_SOURCES_PATH}`]: claims,
                    [`flags.${MODULE_ID}.${ORIGIN_FLAG}`]: {
                        type: "apparition",
                        key: originKey,
                        grant: vessel ? "vessel" : loreName ? "lore" : "spell",
                        ...(sourceId ? { sourceUuid: sourceId } : {}),
                    },
                });
                result.updated.push(existing.id);
            }
        };

        for (const uuid of spellUuids) {
            const existing = findEntrySpellBySource(spellsEntry, uuid, hasApparitionIdentifier);
            if (existing) {
                claimExisting(existing, { sourceId: uuid }); // shared spell: retain every current apparition claim
                continue;
            }

            toBuild.push({
                uuid,
                entry: spellsEntry,
                identifierFlagValue: getApparitionIdentifier(),
                apparitionKey: key,
                clearSignature: true,
                // Never grant a rank the actor cannot cast yet.
                maxRank: getEntryMaxRank(spellsEntry),
            });
        }

        if (vesselEntry && vesselUuid) {
            const existing = findEntrySpellBySource(vesselEntry, vesselUuid, hasVesselIdentifier);
            if (existing) {
                claimExisting(existing, { vessel: true, sourceId: vesselUuid });
            } else {
                toBuild.push({
                    uuid: vesselUuid,
                    entry: vesselEntry,
                    identifierFlagValue: getVesselIdentifier(),
                    apparitionKey: key,
                    clearSignature: false,
                    // The Vessel spell isn't rank-limited by slots the way the
                    // spontaneous list is - no maxRank here.
                });
            }
        }

        // Lore skills the apparition grants (its "Apparition Skills" line).
        // They are matched by name, since a Lore has no compendium source;
        // apparitions often share one, so an existing Lore is claimed instead
        // of duplicated, as with spells.
        const loreNames = parseApparitionLores(apparitionItem);
        // On PF2e 8.6.0+, ensureApparitionFeatOnActor has already placed
        // Rule Elements on the feat. Older systems still require the legacy
        // Lore Item representation.
        if (loreNames.length && !supportsLoreRuleElements()) {
            const loreRank = getApparitionLoreRank(actor);
            // Keep the same normalized name for newly created Lore skills so
            // duplicate detection remains stable across re-bonding.
            for (const name of loreNames) {
                const normalizedName = normalizeLoreName(name);
                const existing = actor.itemTypes.lore.find((lore) => normalizeLoreName(lore.name) === normalizedName);

                if (existing) {
                    claimExisting(existing, { loreName: existing.name }); // shared Lore: retain every current apparition claim
                    continue;
                }

                const displayName = name;
                toCreate.push({
                    name: displayName,
                    type: "lore",
                    img: "systems/pf2e/icons/default-icons/lore.svg",
                    system: { proficient: { value: loreRank } },
                    flags: { [MODULE_ID]: { apparitions: [key] } },
                });
                setManagedOrigin(toCreate.at(-1), { key, grant: "lore", sourceUuid: normalizedName });
                markTemporary(toCreate.at(-1));
            }
        }

        const built = await Promise.all(toBuild.map(({ uuid, ...options }) => buildManagedSpellSource(uuid, options)));
        toCreate.push(...built.filter(Boolean));

        if (toUpdate.length) await actor.updateEmbeddedDocuments("Item", toUpdate);
        if (toCreate.length) {
            const created = await actor.createEmbeddedDocuments("Item", toCreate);
            result.created = created.map((item) => item.id);
        }

        if (autoPrimary) await ensureAutoPrimary(actor, key);
        await syncPrimaryVessels(actor);
        await syncBondedApparitionsFlag(actor);
        await syncFeatureSpells(actor);
        // Announced once everything this apparition grants exists, and only for a new bond.
        if (!wasBonded) Hooks.callAll(`${MODULE_ID}:apparition-bonded`, actor, { key, apparition: apparitionFeat });

        const messageKey =
            toCreate.length || toUpdate.length ? `${MODULE_ID}.Notify.ApparitionAdded` : `${MODULE_ID}.Notify.ApparitionAlreadyPresent`;
        if (!silent) ui.notifications.info(formatLocalized(messageKey, { apparition: apparitionItem.name }));

        return result;
    } catch (error) {
        notifyOperationFailed(error);
        return result;
    }
}

/**
 * The apparitions an actor has bonded and the primary ones, by apparition key.
 *
 * @param {Actor} actor
 * @returns {{ bondedKeys: string[], primaryKeys: string[] }}
 */
function getApparitionState(actor) {
    const bondedKeys = getBondedApparitionFeats(actor)
        .map((feat) => getApparitionKey(feat))
        .filter(Boolean);
    const primaryKeys = getPrimaryVesselState(actor).primary;
    return { bondedKeys, primaryKeys, primaryApparitions: primaryKeys };
}

/**
 * Merge provenance for an existing spell/Lore item from all currently bonded
 * apparitions that actually grant it. This is crucial when the item predates
 * this module (for example a Lore created by another tool): a
 * newly added apparition must not become the sole recorded owner of a shared
 * Lore/spell.
 */
function collectCurrentGrantKeys(actor, { sourceId = null, loreName = null, vessel = false } = {}) {
    const normalized = loreName ? normalizeLoreName(loreName) : null;
    return getBondedApparitionFeats(actor)
        .filter((feat) => {
            if (vessel) return parseApparitionVesselUuid(feat) === sourceId;
            if (normalized) return parseApparitionLores(feat).some((name) => normalizeLoreName(name) === normalized);
            return parseApparitionSpellUuids(feat).includes(sourceId);
        })
        .map((feat) => getApparitionKey(feat))
        .filter(Boolean);
}

/* -------------------------------------------- */
/*  Coexistence with PF2e Dailies               */
/* -------------------------------------------- */

function isDailiesActive() {
    return !!game.modules.get(DAILIES_ID)?.active;
}

/**
 * This module runs the Animist itself, so PF2e Dailies must not run its own
 * Animist daily next to it. When Dailies is installed, that daily (and, for a
 * character of the Animist class, its Wandering Feats daily) is switched off
 * for the actor through Dailies' own per-actor flag; every other daily keeps
 * working. Nothing else is written into Dailies' data: mirroring this module's
 * state there would make its sheet strike out Vessels and offer a retrain
 * button that works on a different set. The flag's previous value is
 * remembered and put back when the module is switched off in its settings.
 *
 * Dailies flags written by pre-release builds are removed once per actor.
 *
 * @param {Actor} actor
 * @param {{ restore?: boolean }} [options] With the module disabled, `restore` puts Dailies' flag back.
 * @returns {Promise<boolean>} Whether the Animist daily is switched off for the actor now.
 */
async function syncDailiesIsolation(actor, { restore = false } = {}) {
    if (!isDailiesActive() || !actorCanModify(actor) || !actorHasApparitionAccess(actor)) return false;
    if (dailiesIsolationActors.has(actor.id)) return false;

    dailiesIsolationActors.add(actor.id);
    try {
        // The dailies this module runs instead: the Animist daily, and Wandering Feats for an Animist.
        const paths = { animist: DAILIES_ANIMIST_DISABLE_PATH, wandering: DAILIES_WANDERING_DISABLE_PATH };
        const legacy = actor.getFlag(MODULE_ID, LEGACY_ISOLATION_PREVIOUS_FLAG);
        const stored = actor.getFlag(MODULE_ID, DAILIES_ISOLATION_PREVIOUS_FLAG);
        const previous = { ...(legacy !== undefined ? { animist: legacy } : {}), ...(stored ?? {}) };

        if (!isEnabled()) {
            if (restore && Object.keys(previous).length) {
                for (const [name, value] of Object.entries(previous)) {
                    if (value === null) await actor.unsetFlag(DAILIES_ID, paths[name]);
                    else await actor.setFlag(DAILIES_ID, paths[name], value);
                }
                await actor.unsetFlag(MODULE_ID, DAILIES_ISOLATION_PREVIOUS_FLAG);
                if (legacy !== undefined) await actor.unsetFlag(MODULE_ID, LEGACY_ISOLATION_PREVIOUS_FLAG);
            }
            return false;
        }

        const taken = isAnimistClass(actor) ? ["animist", "wandering"] : ["animist"];
        let changed = legacy !== undefined;
        for (const name of taken) {
            const current = actor.getFlag(DAILIES_ID, paths[name]);
            if (!(name in previous)) {
                previous[name] = typeof current === "boolean" ? current : null;
                changed = true;
            }
            if (current !== true) await actor.setFlag(DAILIES_ID, paths[name], true);
        }
        if (changed) await actor.setFlag(MODULE_ID, DAILIES_ISOLATION_PREVIOUS_FLAG, previous);
        if (legacy !== undefined) await actor.unsetFlag(MODULE_ID, LEGACY_ISOLATION_PREVIOUS_FLAG);

        await clearMirroredDailiesFlags(actor);
        return true;
    } catch (error) {
        logError(`Dailies isolation failed for ${actor?.name ?? actor?.id ?? "actor"}`, error);
        return false;
    } finally {
        dailiesIsolationActors.delete(actor.id);
    }
}

/**
 * Pre-release builds copied the bonded apparitions and the primary Vessels
 * into Dailies' Animist flags. While they exist, Dailies' sheet grays out
 * Vessels that are not in its list, so they are removed - once per actor, and
 * only after the one-time migration has read the old values.
 */
async function clearMirroredDailiesFlags(actor) {
    if (!actor.getFlag(MODULE_ID, "migrated") || actor.getFlag(MODULE_ID, MIRROR_CLEARED_FLAG)) return;

    for (const path of DAILIES_MIRRORED_PATHS) {
        if (actor.getFlag(DAILIES_ID, path) !== undefined) await actor.unsetFlag(DAILIES_ID, path);
    }
    await actor.setFlag(MODULE_ID, MIRROR_CLEARED_FLAG, true);
}

async function syncDailiesIsolationForWorldActors() {
    if (!isDailiesActive()) return;

    const restore = !isEnabled();
    for (const actor of game.actors ?? []) {
        if (actor.type === "character" && actorCanModify(actor)) await syncDailiesIsolation(actor, { restore });
    }
}

// A character that gains Apparition Attunement / Animist Dedication while the
// world is running is isolated right away instead of at the next reload.
Hooks.on("createItem", (item, _options, userId) => {
    const actor = item.parent;
    if (userId !== game.user.id || item.type !== "feat" || !actor?.isOfType?.("character")) return;
    if (!isEnabled() || !isDailiesActive() || !actorHasApparitionAccess(actor)) return;
    void syncDailiesIsolation(actor);
});

/**
 * One-time migration of actors and items written by pre-release builds that
 * were coupled to pf2e-dailies. Normal operation never calls the pf2e-dailies
 * API or reads its settings.
 */
async function migrateLegacyDailiesState() {
    const actors = (game.actors ?? []).filter((actor) => actor.type === "character" && actorCanModify(actor));
    for (const actor of actors) {
        if (actor.getFlag(MODULE_ID, "migrated")) {
            await syncCurrentPrimaryState(actor);
            continue;
        }

        const primaryKeys = [];
        const legacyPrimaryIds = actor.getFlag(DAILIES_ID, "extra.dailies.animist.primaryVessels");

        for (const item of actor.items) {
            const legacyIdentifier = item.flags?.[DAILIES_ID]?.identifier;
            const isLegacyApparitionEntry = legacyIdentifier === "animist-spontaneous";
            const isLegacyVesselEntry = legacyIdentifier === "animist-focus";
            const isManagedGrant = Array.isArray(item.flags?.[MODULE_ID]?.apparitions);
            const oldTemporary = !!item.flags?.[DAILIES_ID]?.temporary;

            if (isLegacyApparitionEntry || isLegacyVesselEntry) {
                const identifier = isLegacyApparitionEntry ? getApparitionIdentifier() : getVesselIdentifier();
                await item.setFlag(MODULE_ID, "identifier", identifier);
                await item.setFlag(MODULE_ID, "temporary", true);
            } else if (isManagedGrant || oldTemporary) {
                if (oldTemporary || isManagedGrant) await item.setFlag(MODULE_ID, "temporary", true);
            }
        }

        const storedBonded = getBondedApparitionFeats(actor)
            .map((feat) => getApparitionKey(feat))
            .filter(Boolean);
        if (storedBonded.length) await actor.setFlag(MODULE_ID, "bondedApparitions", storedBonded);

        if (Array.isArray(legacyPrimaryIds)) {
            for (const itemId of legacyPrimaryIds) {
                const vessel = actor.items.get(itemId);
                if (!vessel) continue;
                const feat = getBondedApparitionFeats(actor).find(
                    (candidate) => parseApparitionVesselUuid(candidate) === (vessel.sourceId ?? vessel.uuid),
                );
                const primaryKey = feat ? getApparitionKey(feat) : null;
                if (primaryKey) primaryKeys.push(primaryKey);
            }
        }

        const vesselState = getPrimaryVesselState(actor);
        const finalPrimary = [...new Set(primaryKeys)]
            .filter((key) => vesselState.vesselKeys.some((entry) => entry.key === key))
            .slice(0, vesselState.limit);
        // Without Dailies' restriction flag every Vessel counted towards the pool,
        // so a character with no recorded primary set gets it filled up to its
        // limit instead of an empty one (which would subtract the whole pool).
        for (const entry of vesselState.vesselKeys) {
            if (finalPrimary.length >= vesselState.limit) break;
            if (!finalPrimary.includes(entry.key)) finalPrimary.push(entry.key);
        }
        if (vesselState.vesselKeys.length > 0 && !Array.isArray(actor.getFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG))) {
            await actor.setFlag(MODULE_ID, PRIMARY_APPARITIONS_FLAG, finalPrimary);
        }

        // Remove focus-pool rules left by the old Dailies-coupled version.
        for (const feat of [findFeature(actor, APPARITION_ATTUNEMENT), findFeature(actor, ANIMIST_DEDICATION)].filter(Boolean)) {
            const rules = foundry.utils.deepClone(feat._source.system.rules ?? []);
            const oldOverride = rules.find(
                (rule) =>
                    rule?.[MODULE_ID] === "focus-override" &&
                    rule.key === "ActiveEffectLike" &&
                    rule.path === "system.resources.focus.max" &&
                    typeof rule.value === "number" &&
                    rule.mode === "override",
            );
            const cleaned = rules.filter(
                (rule) =>
                    !(
                        rule?.[DAILIES_ID] &&
                        rule.key === "ActiveEffectLike" &&
                        rule.path === "system.resources.focus.max" &&
                        rule.mode === "subtract"
                    ) && !(rule?.[MODULE_ID] === FOCUS_OVERRIDE_RULE_TAG),
            );
            if (cleaned.length !== rules.length) {
                await feat.update({ "system.rules": cleaned });
            }
            if (oldOverride && !Number.isFinite(actor.getFlag(MODULE_ID, FOCUS_OVERRIDE_FLAG_KEY))) {
                await actor.setFlag(MODULE_ID, FOCUS_OVERRIDE_FLAG_KEY, oldOverride.value);
            }
        }

        // Repair provenance for shared grants left behind by pre-release
        // builds. Only legacy-temporary/managed items are
        // touched, so a manually-created Lore with the same name is preserved.
        for (const item of [...actor.itemTypes.spell, ...actor.itemTypes.lore]) {
            const existing = getSpellApparitionSources(item);
            const oldTemporary = !!item.flags?.[DAILIES_ID]?.temporary;
            const managedByUs = hasApparitionIdentifier(item.flags) || hasVesselIdentifier(item.flags) || existing.length > 0;
            if (!oldTemporary && !managedByUs) continue;

            const claims = new Set(existing);
            if (item.type === "lore") {
                for (const key of collectCurrentGrantKeys(actor, { loreName: item.name })) claims.add(key);
            } else if (item.sourceId) {
                const isVessel = hasVesselIdentifier(item.flags);
                for (const key of collectCurrentGrantKeys(actor, { sourceId: item.sourceId, vessel: isVessel })) claims.add(key);
            }
            const next = [...claims];
            if (next.length > existing.length || next.some((key, index) => key !== existing[index])) {
                await item.setFlag(MODULE_ID, "apparitions", next);
            }
        }

        await syncCurrentPrimaryState(actor);
        // Mark the one-time migration as complete even when there was nothing
        // to convert. Normal startup must not inspect the legacy Dailies
        // namespace again.
        await actor.setFlag(MODULE_ID, "migrated", true);
    }
}

/**
 * Move legacy Animist Lore Items to PF2e 8.6+'s Rule Element model. Only
 * module-owned Lore items and Dailies-temporary Lore items that correspond
 * to a currently bonded apparition are removed; ordinary player-created
 * Lore items are left alone.
 */
async function migrateApparitionLoresToRuleElements() {
    if (!supportsLoreRuleElements()) return;

    const actors = (game.actors ?? []).filter((actor) => actor.type === "character" && actorCanModify(actor));
    for (const actor of actors) {
        const feats = getBondedApparitionFeats(actor);
        for (const feat of feats) await syncApparitionLoreRuleElements(actor, feat);

        const currentlyGrantedLoreNames = new Set(feats.flatMap((feat) => parseApparitionLores(feat)).map(normalizeLoreName));
        const currentlyBondedKeys = new Set(feats.map((feat) => getApparitionKey(feat)).filter(Boolean));
        const removeIds = [];
        for (const lore of actor.itemTypes.lore ?? []) {
            const origin = getManagedOrigin(lore);
            const ownedTemporaryLore = isTemporary(lore) && origin?.grant === "lore";
            const sources = getSpellApparitionSources(lore);
            // A Dailies-temporary Lore may belong to another daily. Delete it
            // only when provenance explicitly ties it to a currently-bound
            // apparition; matching names alone are not sufficient grounds to
            // remove an item another daily/player may rely on.
            const oldDailiesLore =
                !!lore.flags?.[DAILIES_ID]?.temporary &&
                currentlyGrantedLoreNames.has(normalizeLoreName(lore.name)) &&
                sources.some((key) => currentlyBondedKeys.has(key));
            if (ownedTemporaryLore || oldDailiesLore) removeIds.push(lore.id);
        }
        if (removeIds.length) await actor.deleteEmbeddedDocuments("Item", removeIds);
    }
}

// Lore proficiency is based on Animist level, so update each bonded feat's
// rule when a character levels up. This keeps the Rule Element's rank current
// without requiring the user to unbind and re-bind an apparition.
Hooks.on("updateActor", (actor, changes, _options, userId) => {
    if (userId !== game.user?.id || !actorCanModify(actor) || !supportsLoreRuleElements() || !isEnabled()) return;
    const levelChanged =
        Object.prototype.hasOwnProperty.call(changes ?? {}, "system.details.level.value") ||
        changes?.system?.details?.level?.value !== undefined;
    if (!levelChanged || actor.type !== "character") return;
    void Promise.all(getBondedApparitionFeats(actor).map((feat) => syncApparitionLoreRuleElements(actor, feat))).catch((error) =>
        logError("Lore Rule Element level update failed", error),
    );
});

const fixCurrentAnimist = repairApparitionActor;

export {
    MODULE_ID,
    isEnabled,
    requireActorOwner,
    getFeatSource,
    isAnimistClass,
    ordinalString,
    addListenerAll,
    attachIconFallback,
    getSheetRoot,
    actorHasApparitionAccess,
    parseApparitionSpellUuids,
    parseApparitionVesselUuid,
    parseApparitionLores,
    getApparitionEntry,
    getVesselEntry,
    actorCanModify,
    getApparitionKey,
    getBondedApparitionFeats,
    apparitionStillGrantsAnything,
    supportsLoreRuleElements,
    syncApparitionLoreRuleElements,
    migrateApparitionLoresToRuleElements,
    pruneLeftoverApparitions,
    getVesselSpellForApparition,
    getPrimaryVesselState,
    setPrimaryVessel,
    isAutoPrimaryEnabled,
    setAutoPrimaryEnabled,
    getApparitionProfiles,
    saveApparitionProfile,
    deleteApparitionProfile,
    applyApparitionProfile,
    getLastDayApparitionSnapshot,
    restoreLastDayApparitions,
    repairApparitionActor,
    fixCurrentAnimist,
    getManagedOrigin,
    getFocusPointsOverride,
    setFocusPointsOverride,
    getApparitionState,
    migrateLegacyDailiesState,
    syncDailiesIsolation,
    getPermanentApparition,
    setPermanentApparition,
    syncFeatureSpells,
    promptPrimaryChange,
    changePrimaryApparition,
    diagnose,
    addApparition,
    removeApparition,
    notifyOperationFailed,
    formatLocalized,
    getFilePickerClass,
    getCustomAvatarFormUuid,
    loadAvatarsModuleExports,
    LEGACY_CUSTOM_APPARITION_AVATAR_FLAG,
};
