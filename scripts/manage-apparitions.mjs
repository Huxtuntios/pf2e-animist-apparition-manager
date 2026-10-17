/**
 * Management window - "Manage Animist Abilities".
 *
 * A text button at the top of the character sheet's spellcasting tab (for an
 * Animist, or any character with Animist Dedication) opens a window with:
 *
 *   - the bonded apparitions, each with an unbond button and a warning when it
 *     has stopped granting anything (see `apparitionStillGrantsAnything`);
 *   - a searchable list of every apparition available to bond - the system's
 *     and the custom ones - with the Lore skills each grants;
 *   - the primary apparitions, preparation profiles, Wandering Feats,
 *     diagnostics and cleanup.
 *
 * Everything is backed by this module's own `addApparition` /
 * `removeApparition`. The button is shown only to whoever can edit the actor:
 * the owning player or a GM.
 */

import {
    MODULE_ID,
    isEnabled,
    ordinalString,
    addListenerAll,
    attachIconFallback,
    getSheetRoot,
    actorHasApparitionAccess,
    actorCanModify,
    getApparitionKey,
    getBondedApparitionFeats,
    parseApparitionSpellUuids,
    parseApparitionVesselUuid,
    parseApparitionLores,
    apparitionStillGrantsAnything,
    pruneLeftoverApparitions,
    getVesselSpellForApparition,
    getPrimaryVesselState,
    getPermanentApparition,
    setPermanentApparition,
    setPrimaryVessel,
    promptPrimaryChange,
    isAutoPrimaryEnabled,
    setAutoPrimaryEnabled,
    getApparitionProfiles,
    saveApparitionProfile,
    deleteApparitionProfile,
    applyApparitionProfile,
    getLastDayApparitionSnapshot,
    restoreLastDayApparitions,
    diagnose,
    repairApparitionActor,
    getFocusPointsOverride,
    setFocusPointsOverride,
    notifyOperationFailed,
    formatLocalized,
    addApparition,
    removeApparition,
} from "./apparition-fix.mjs";
import { getWanderingContext, replaceWanderingFeat } from "./wandering-feats.mjs";
import { openCustomApparitionCopy } from "./custom-apparitions.mjs";

const apps = foundry.applications.api;

// What an apparition that grants nothing (or can't be described) shows.
const NO_GRANTS = { spells: [], vessel: null, lores: [], hasGrants: false };

/**
 * Opens the original item (a compendium entry stays the compendium entry, not a copy on the actor).
 *
 * @param {string} uuid
 * @param {"spell"|"feat"} type
 * @param {Item|null} [fallback] Shown when the source cannot be found (e.g. the character's own copy).
 */
async function openItemSource(uuid, type, fallback = null) {
    try {
        const doc = (uuid ? await fromUuid(uuid).catch(() => null) : null) ?? fallback;
        if (doc?.isOfType?.(type) && doc.sheet) {
            await doc.sheet.render(true);
            return;
        }
    } catch (error) {
        console.error(`${MODULE_ID} | Failed to open the original item ${uuid}`, error);
    }
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.ManageApparitions.Notify.SourceNotFound`));
}

/**
 * The spells (and Vessel spell, and Lore skills) a given apparition would
 * grant, resolved for display in the "view spells" disclosure this module
 * adds to both the bonded and available apparition rows - purely
 * informational, never touches the actor. Works on either a live Item
 * document or a lightweight compendium index entry (see
 * `getAvailableApparitions` below), since `parseApparitionSpellUuids` and
 * friends only ever need a `description`/`system.description.value`
 * string to parse, which both shapes provide.
 *
 * @param {Item|object} apparitionItem
 * @returns {Promise<{
 *   spells: { uuid: string, name: string, img: string, rankLabel: string }[],
 *   vessel: { name: string, img: string } | null,
 *   lores: string[],
 *   hasGrants: boolean,
 * }>}
 */
async function describeApparitionGrants(apparitionItem) {
    const spellUuids = parseApparitionSpellUuids(apparitionItem);
    const vesselUuid = parseApparitionVesselUuid(apparitionItem);
    const lores = parseApparitionLores(apparitionItem);

    const [spellDocs, vesselDoc] = await Promise.all([
        Promise.all(spellUuids.map((uuid) => fromUuid(uuid))),
        vesselUuid ? fromUuid(vesselUuid) : null,
    ]);

    const spells = spellDocs
        .filter((doc) => doc?.isOfType?.("spell"))
        .map((doc) => {
            const rank = doc.baseRank ?? doc.system?.level?.value ?? 1;
            return {
                uuid: doc.uuid,
                name: doc.name,
                img: doc.img,
                rank: doc.isCantrip ? 0 : rank,
                rankLabel: doc.isCantrip ? game.i18n.localize(`${MODULE_ID}.CustomApparition.Cantrip`) : ordinalString(rank),
            };
        })
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));

    const vessel = vesselDoc?.isOfType?.("spell") ? { uuid: vesselDoc.uuid, name: vesselDoc.name, img: vesselDoc.img } : null;

    return { spells, vessel, lores, hasGrants: spells.length > 0 || !!vessel || lores.length > 0 };
}

/**
 * UUIDs of custom apparition feats owned by this module. Custom apparitions
 * are ordinary world feat Items carrying this module's `customApparition`
 * flag; no external registry is required.
 *
 * @returns {string[]}
 */
function getCustomApparitionUuids() {
    return game.items.filter((item) => item.type === "feat" && item.getFlag(MODULE_ID, "customApparition")).map((item) => item.uuid);
}

/**
 * Every apparition available to bond - real compendium apparitions (tagged
 * "animist-apparition", the canonical system trait used by Animist feats)
 * plus this module's own Custom Apparitions - each with the
 * Lore skills it grants, so they can be searched/recognized by Lore too and
 * not just by name (apparitions can be hard to tell apart by name alone).
 *
 * @returns {Promise<{ uuid: string, name: string, img: string, lores: string[] }[]>}
 */
async function getAvailableApparitions() {
    const results = [];
    const seen = new Set();
    const packIds = ["pf2e.classfeatures", "pf2e-anachronism.class-features"];

    for (const packId of packIds) {
        const pack = game.packs.get(packId);
        if (!pack) continue;
        try {
            const index = await pack.getIndex({ fields: ["system.traits.otherTags", "system.description.value"] });
            const entries = index.filter(
                (entry) =>
                    entry.type === "feat" && entry.system?.traits?.otherTags?.includes("animist-apparition") && !seen.has(entry.uuid),
            );
            for (const entry of entries) seen.add(entry.uuid);
            const described = await Promise.all(
                entries.map(async (entry) => {
                    try {
                        return {
                            uuid: entry.uuid,
                            name: entry.name,
                            img: entry.img,
                            ...(await describeApparitionGrants(entry)),
                        };
                    } catch (error) {
                        console.error(`${MODULE_ID} | Failed to describe compendium apparition ${entry.uuid}`, error);
                        return null;
                    }
                }),
            );
            results.push(...described.filter(Boolean));
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to index apparition pack ${packId}`, error);
        }
    }

    const customUuids = getCustomApparitionUuids();
    for (const uuid of customUuids) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
        try {
            const doc = await fromUuid(uuid);
            if (!doc?.isOfType?.("feat")) continue;
            results.push({ uuid: doc.uuid, name: doc.name, img: doc.img, ...(await describeApparitionGrants(doc)) });
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to resolve custom apparition ${uuid}`, error);
        }
    }

    results.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return results;
}

let availableApparitionsPromise = null;
function loadAvailableApparitions() {
    availableApparitionsPromise ??= getAvailableApparitions().catch((error) => {
        console.error(`${MODULE_ID} | Failed to load available apparitions`, error);
        // Don't keep the failure: the next window (or reload) tries again.
        availableApparitionsPromise = null;
        return [];
    });
    return availableApparitionsPromise;
}

async function showDiagnostics(actor, manager = null) {
    const report = await diagnose(actor);
    const esc = (value) => foundry.utils.escapeHTML(String(value ?? ""));
    const integration = report.dailiesIntegration;
    const customCount = report.customApparitions?.length ?? 0;
    const bonded = report.bondedApparitions?.length ?? 0;
    const unresolved = report.unresolvableHomebrew?.length ?? 0;
    const rows = [
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.ModuleActive`), report.moduleActive ? "✓" : "✗"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.CanBond`), report.actor?.canBondApparitions ? "✓" : "✗"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.ApparitionEntry`), report.apparitionSpellcastingEntry || "—"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.VesselEntry`), report.vesselSpellsEntry || "—"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.Bonded`), bonded],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.Custom`), customCount],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.PackCount`), report.apparitionCount ?? 0],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.MissingTraits`), report.entriesWithoutTraits?.length ?? 0],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.UnresolvableHomebrew`), unresolved],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.Focus`), report.focusMaximum ?? "—"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.ManagedItems`), report.managedActorItems?.length ?? 0],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.Profiles`), report.profileCount ?? 0],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.Yesterday`), report.hasLastDaySnapshot ? "✓" : "—"],
        [game.i18n.localize(`${MODULE_ID}.Diagnostics.AutoPrimary`), isAutoPrimaryEnabled() ? "✓" : "✗"],
        [
            game.i18n.localize(`${MODULE_ID}.Diagnostics.Dailies`),
            integration?.active
                ? integration.animistDisabled
                    ? game.i18n.localize(`${MODULE_ID}.Diagnostics.DailiesIsolated`)
                    : game.i18n.localize(`${MODULE_ID}.Diagnostics.DailiesActive`)
                : game.i18n.localize(`${MODULE_ID}.Diagnostics.DailiesAbsent`),
        ],
    ];
    const table = rows.map(([label, value]) => `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`).join("");
    const missing = (report.entriesWithoutTraits ?? [])
        .slice(0, 8)
        .map((entry) => `<li>${esc(entry.name)} <small>${esc(entry.uuid)}</small></li>`)
        .join("");
    const unresolvedList = (report.unresolvableHomebrew ?? [])
        .slice(0, 8)
        .map((entry) => `<li>${esc(entry.name ?? entry.id)} <small>${esc((entry.missing ?? []).join(", "))}</small></li>`)
        .join("");
    const content = `<div class="apparition-fix-diagnostics"><table><tbody>${table}</tbody></table>${missing ? `<h4>${esc(game.i18n.localize(`${MODULE_ID}.Diagnostics.MissingTraits`))}</h4><ul>${missing}</ul>` : ""}${unresolvedList ? `<h4>${esc(game.i18n.localize(`${MODULE_ID}.Diagnostics.UnresolvableHomebrew`))}</h4><ul>${unresolvedList}</ul>` : ""}</div>`;

    await apps.DialogV2.wait({
        window: { title: formatLocalized(`${MODULE_ID}.Diagnostics.Title`, { name: actor.name }), icon: "fa-solid fa-stethoscope" },
        content,
        buttons: [
            {
                action: "repair",
                label: game.i18n.localize(`${MODULE_ID}.Diagnostics.Repair`),
                icon: "fa-solid fa-wand-magic-sparkles",
                callback: async () => {
                    const result = await repairApparitionActor(actor);
                    ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.RepairComplete`, result));
                    if (manager) manager.render();
                    return true;
                },
            },
            {
                action: "close",
                label: game.i18n.localize(`${MODULE_ID}.ManageApparitions.Close`),
                default: true,
                callback: () => false,
            },
        ],
    });
}

class ManageApparitionsApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    /** @param {Actor} actor */
    constructor(actor, options = {}) {
        super(foundry.utils.mergeObject({ id: `apparition-fix-manage-apparitions-${actor.id}` }, options));
        this.actor = actor;
        // Availability is intentionally loaded in the background. Waiting for
        // every compendium UUID to resolve before the first render made the
        // button feel dead on a cold Foundry session. The management window
        // must be usable immediately; the list fills itself in when ready.
        this.available = null;
        this.availableLoading = true;
        this.reloadAvailable();
    }

    /**
     * The saved profiles with a preview of their apparitions: name and icon (from the list of
     * bondable apparitions, the bonded ones, else resolved from the id), whether it is primary in the
     * profile, and what applying it would do (already bonded / to bond / not found), plus the
     * currently bonded apparitions it would unbond.
     */
    async #prepareProfiles(bondedFeats) {
        const known = new Map();
        for (const entry of this.available ?? []) known.set(entry.uuid, { name: entry.name, img: entry.img });
        for (const feat of bondedFeats) known.set(getApparitionKey(feat), { name: feat.name, img: feat.img });
        const bondedKeys = new Set(bondedFeats.map((feat) => getApparitionKey(feat)));

        const profiles = getApparitionProfiles(this.actor);
        for (const key of new Set(profiles.flatMap((profile) => profile.apparitions))) {
            if (known.has(key)) continue;
            const doc = await fromUuid(key).catch(() => null);
            known.set(key, doc?.isOfType?.("feat") ? { name: doc.name, img: doc.img } : null);
        }

        return profiles.map((profile) => ({
            ...profile,
            label: formatLocalized(`${MODULE_ID}.ManageApparitions.ProfileOption`, {
                name: profile.name,
                count: profile.apparitions.length,
            }),
            preview: profile.apparitions.map((key) => {
                const info = known.get(key);
                return {
                    name: info?.name ?? key.split(".").pop(),
                    img: info?.img ?? "systems/pf2e/icons/default-icons/mystery-man.svg",
                    primary: profile.primary.includes(key),
                    missing: !info,
                    bonded: bondedKeys.has(key),
                };
            }),
            toUnbind: bondedFeats.filter((feat) => !profile.apparitions.includes(getApparitionKey(feat))).map((feat) => feat.name),
        }));
    }

    /** Bond an apparition (by uuid) to the character. */
    async bondApparition(uuid) {
        if (!actorCanModify(this.actor)) return;
        try {
            const doc = await fromUuid(uuid);
            if (!doc?.isOfType?.("feat")) return;
            await addApparition(this.actor, doc);
            this.render();
        } catch (error) {
            notifyOperationFailed(error);
        }
    }

    /**
     * (Re)load the list of bondable apparitions. Called on open and whenever a
     * custom apparition is created, edited, imported or deleted.
     */
    reloadAvailable() {
        this.availableLoading = true;
        this.availableReady = loadAvailableApparitions()
            .then((available) => {
                this.available = available;
                return available;
            })
            .catch((error) => {
                notifyOperationFailed(error);
                this.available = [];
                return [];
            })
            .finally(() => {
                this.availableLoading = false;
                // A render is queued by ApplicationV2, so it is safe to ask
                // for one while the first is still in flight; that is
                // exactly the case a plain `element.isConnected` check
                // missed, leaving "loading" on screen until something else
                // re-rendered the window. Never re-open a closed window.
                if (this.state > 0) void this.render();
            });
        return this.availableReady;
    }

    _onRender(context, options) {
        super._onRender?.(context, options);
        // Belt and braces: if the list finished loading after this render's
        // data was prepared, draw it now.
        if (this.#renderedWhileLoading && !this.availableLoading) void this.render();
    }

    #renderedWhileLoading = false;

    static DEFAULT_OPTIONS = {
        classes: ["apparition-fix", "apparition-fix-manage"],
        window: { icon: "fa-solid fa-ghost", resizable: true },
        // A fixed height (rather than "auto") is what actually lets the
        // scrollable part below take over once content overflows it -
        // "auto" just keeps growing the window past the screen edge.
        position: { width: 480, height: 640 },
    };

    static PARTS = {
        manage: {
            template: `modules/${MODULE_ID}/templates/manage-apparitions.hbs`,
            scrollable: [""],
        },
    };

    get title() {
        return formatLocalized(`${MODULE_ID}.ManageApparitions.Title`, { name: this.actor.name });
    }

    async _prepareContext(_options) {
        const bondedFeats = getBondedApparitionFeats(this.actor);
        const permanent = getPermanentApparition(this.actor);
        this.#renderedWhileLoading = this.availableLoading;

        const { primary } = getPrimaryVesselState(this.actor);
        const primaryIds = new Set(primary);

        const bonded = await Promise.all(
            bondedFeats.map(async (item) => {
                // A feat that grants nothing anymore (typically one bonded before
                // the module flagged its items as temporary, which a rest does
                // not delete) is listed with a warning rather than hidden. Its old source
                // UUIDs are deliberately NOT resolved - doing that for a
                // stale feat is what once left this window loading forever.
                const grantsAnything = apparitionStillGrantsAnything(this.actor, item);
                let grants = NO_GRANTS;
                if (grantsAnything) {
                    try {
                        grants = await describeApparitionGrants(item);
                    } catch (error) {
                        console.error(`${MODULE_ID} | Failed to describe bonded apparition ${item.uuid}`, error);
                    }
                }

                const apparitionKey = getApparitionKey(item);
                const vesselSpell = grantsAnything ? getVesselSpellForApparition(this.actor, item) : null;
                const isPrimary = !!vesselSpell && primaryIds.has(apparitionKey);
                return {
                    id: item.id,
                    key: apparitionKey,
                    isPermanent: !!permanent.key && apparitionKey === permanent.key,
                    name: item.name,
                    img: item.img,
                    stale: !grants.hasGrants,
                    vesselSpellId: vesselSpell?.id ?? null,
                    vesselIsPrimary: isPrimary,
                    canTogglePrimary: !!vesselSpell && !!apparitionKey,
                    primaryTitle: isPrimary
                        ? game.i18n.localize(`${MODULE_ID}.ManageApparitions.PrimaryActive`)
                        : game.i18n.localize(`${MODULE_ID}.ManageApparitions.PrimaryInactive`),
                    ...grants,
                };
            }),
        );
        bonded.sort((a, b) => a.name.localeCompare(b.name));

        const bondedUuids = new Set(bondedFeats.map((item) => getApparitionKey(item)));
        const available = (this.available ?? [])
            .filter((entry) => !bondedUuids.has(entry.uuid))
            .map((entry) => ({
                ...entry,
                loresText: entry.lores.join(", "),
                searchText: `${entry.name} ${entry.lores.join(" ")}`.toLowerCase(),
            }));

        // Relinquish Control: the apparition the character is tied to, and the ones it can be changed to.
        const known = new Map([
            ...(this.available ?? []).map((entry) => [entry.uuid, { name: entry.name, img: entry.img }]),
            ...bondedFeats.map((feat) => [getApparitionKey(feat), { name: feat.name, img: feat.img }]),
        ]);
        const permanentContext = permanent.available
            ? {
                  show: true,
                  hasKey: !!permanent.key,
                  key: permanent.key,
                  name: known.get(permanent.key)?.name ?? permanent.name,
                  img: known.get(permanent.key)?.img,
                  options: [...known]
                      .map(([key, info]) => ({ key, name: info.name, selected: key === permanent.key }))
                      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)),
              }
            : { show: false };

        let wandering = { show: false, rows: [] };
        try {
            wandering = await getWanderingContext(this.actor, {
                names: new Map((this.available ?? []).map((entry) => [entry.uuid, entry.name])),
            });
        } catch (error) {
            console.error(`${MODULE_ID} | Failed to prepare wandering feats`, error);
        }

        const focusOverride = getFocusPointsOverride(this.actor);

        const profiles = await this.#prepareProfiles(bondedFeats);
        const lastDay = getLastDayApparitionSnapshot(this.actor);

        return {
            bonded,
            available,
            availableLoading: this.availableLoading,
            focusMax: this.actor.system.resources?.focus?.max ?? 0,
            wandering,
            permanent: permanentContext,
            focusOverride,
            hasFocusOverride: focusOverride !== null,
            profiles,
            hasProfiles: profiles.length > 0,
            hasLastDaySnapshot: !!lastDay?.apparitions.length,
            autoPrimary: isAutoPrimaryEnabled(),
            isGM: !!game.user.isGM,
        };
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "manage") return;

        addListenerAll(html, "[data-action='copy-custom']", async (el) => {
            if (!game.user.isGM) return;
            try {
                const item = await fromUuid(el.dataset.uuid);
                if (item?.isOfType?.("feat")) await openCustomApparitionCopy(item);
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='unbond']", async (el) => {
            if (!actorCanModify(this.actor)) return;
            try {
                const item = this.actor.items.get(el.dataset.id);
                if (!item) return;
                // Relinquish Control: the permanent apparition is attuned every day, so it is changed, not unbound.
                const permanentKey = getPermanentApparition(this.actor).key;
                if (permanentKey && getApparitionKey(item) === permanentKey) {
                    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.PermanentLocked`));
                    return;
                }
                await removeApparition(this.actor, item);
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='bond']", (el) => this.bondApparition(el.dataset.uuid));

        addListenerAll(html, "[data-action='set-permanent']", async () => {
            const key = html.querySelector('[name="permanentApparition"]')?.value;
            if (!key || !actorCanModify(this.actor)) return;
            try {
                if (await setPermanentApparition(this.actor, key)) this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        // A random apparition out of the list as it is shown (the search field narrows it).
        addListenerAll(html, "[data-action='bond-random']", () => {
            const bondable = [...html.querySelectorAll("[data-searchable]")].filter((row) => !row.hidden);
            if (!bondable.length) {
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NoRandomApparition`));
                return;
            }
            const row = bondable[Math.floor(Math.random() * bondable.length)];
            return this.bondApparition(row.querySelector("[data-action='bond']")?.dataset.uuid);
        });

        // The original apparition (the compendium entry, not the copy on the character).
        addListenerAll(html, "[data-action='open-apparition-source']", async (el, event) => {
            // Inside <summary>: never fold/unfold the list of what the apparition grants.
            event.preventDefault();
            event.stopPropagation();
            await openItemSource(el.dataset.uuid, "feat", this.actor.items.get(el.dataset.itemId));
        });

        // Missing icons (e.g. a path a custom Vessel spell was saved with that
        // no longer exists) get a generic one instead of a broken image.
        attachIconFallback(html);

        addListenerAll(html, "[data-action='open-spell-source']", async (el, event) => {
            event.preventDefault();
            event.stopPropagation();
            await openItemSource(el.dataset.uuid, "spell");
        });

        addListenerAll(html, "[data-action='toggle-primary']", async (el, event) => {
            // The star sits inside <summary>; never allow the click to fold/unfold the grants.
            event.preventDefault();
            event.stopPropagation();
            const key = el.dataset.key;
            if (!actorCanModify(this.actor) || !key) return;
            try {
                if (getPrimaryVesselState(this.actor).primary.includes(key)) {
                    await setPrimaryVessel(this.actor, key, false);
                } else {
                    // Same dialog as the sheet's change button:
                    // a full set swaps the clicked apparition in; with several primaries
                    // the player says which one it replaces.
                    const choice = await promptPrimaryChange(this.actor, { newKey: key });
                    if (!choice) return;
                    await setPrimaryVessel(this.actor, choice.newKey, true, { replaceKey: choice.replaceKey });
                }
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        // Wandering Feats: the original of the character's feat or of the feat chosen in the list.
        addListenerAll(html, "[data-action='open-wandering-source']", async (el, event) => {
            event.preventDefault();
            const uuid = el.dataset.select ? html.querySelector(`[name="${el.dataset.select}"]`)?.value : el.dataset.uuid;
            await openItemSource(uuid, "feat", this.actor.items.get(el.dataset.itemId));
        });

        // The Lore requirement of the feat chosen in a row is shown under it.
        for (const select of html.querySelectorAll('select[name^="wandering-"]')) {
            select.addEventListener("change", () => {
                const option = select.selectedOptions[0];
                const target = select.closest("li")?.querySelector('[data-role="option-requirement"]');
                if (!option || !target) return;
                target.textContent = option.dataset.requirement || "—";
                target.classList.toggle("unmet", option.dataset.met === "false");
            });
        }

        addListenerAll(html, "[data-action='replace-wandering']", async (el) => {
            if (!actorCanModify(this.actor)) return;
            const select = html.querySelector(`[name="wandering-${el.dataset.featId}"]`);
            if (await replaceWanderingFeat(this.actor, el.dataset.featId, select?.value)) this.render();
        });

        addListenerAll(html, "[data-action='cleanup-vessels']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const removed = await pruneLeftoverApparitions(this.actor);
                const messageKey = removed ? `${MODULE_ID}.Notify.VesselsCleanedUp` : `${MODULE_ID}.Notify.NoVesselsToCleanUp`;
                ui.notifications.info(formatLocalized(messageKey, { count: removed }));
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        const profileSelect = html.querySelector("[name='profileId']");
        const showProfilePreview = () => {
            for (const list of html.querySelectorAll("[data-profile-preview]"))
                list.hidden = list.dataset.profilePreview !== profileSelect?.value;
        };
        profileSelect?.addEventListener("change", (event) => {
            const profile = getApparitionProfiles(this.actor).find((entry) => entry.id === event.target.value);
            const input = html.querySelector('[name="profileName"]');
            if (profile && input) input.value = profile.name;
            showProfilePreview();
        });
        showProfilePreview();

        addListenerAll(html, "[data-action='save-profile']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const input = html.querySelector('[name="profileName"]');
                const name = input?.value?.trim() ?? "";
                if (!name) {
                    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.ProfileNameRequired`));
                    return;
                }
                const selectedId = html.querySelector('[name="profileId"]')?.value || null;
                await saveApparitionProfile(this.actor, name, { id: selectedId });
                ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.ProfileSaved`, { name }));
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='apply-profile']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const id = html.querySelector('[name="profileId"]')?.value;
                if (!id) return;
                const result = await applyApparitionProfile(this.actor, id);
                ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.ProfileApplied`, result));
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='delete-profile']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const id = html.querySelector('[name="profileId"]')?.value;
                if (!id) return;
                await deleteApparitionProfile(this.actor, id);
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='restore-yesterday']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const result = await restoreLastDayApparitions(this.actor);
                ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.LastDayRestored`, result));
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='toggle-auto-primary']", async () => {
            if (!game.user.isGM) {
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NotGM`));
                return;
            }
            try {
                await setAutoPrimaryEnabled(!isAutoPrimaryEnabled());
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='diagnose']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                await showDiagnostics(this.actor, this);
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='set-focus-override']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const input = html.querySelector('[name="focusOverrideInput"]');
                const value = Number(input?.value);
                if (!Number.isFinite(value)) return;
                await setFocusPointsOverride(this.actor, value);
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='clear-focus-override']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                await setFocusPointsOverride(this.actor, null);
                this.render();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='closeWindow']", () => this.close());

        const search = html.querySelector('[data-role="apparition-search"]');
        search?.addEventListener("input", () => {
            const query = search.value.trim().toLowerCase();
            for (const row of html.querySelectorAll("[data-searchable]")) {
                row.hidden = query.length > 0 && !row.dataset.searchable.includes(query);
            }
        });
    }
}

// Rest cleanup is asynchronous. Refresh an already-open management window only
// after the actor's stale apparition feats and grants have actually been removed.
Hooks.on(`${MODULE_ID}:rest-cleanup`, (actor) => {
    const app = foundry.applications.instances.get(`apparition-fix-manage-apparitions-${actor.id}`);
    if (app instanceof ManageApparitionsApp) void app.render();
});

/* -------------------------------------------- */
/*  Sheet button                                */
/* -------------------------------------------- */

// The button always sits in the same place - a full text button at the very top
// of the spellcasting tab, above every spell list - whether or not the
// character has Apparition / Vessel spellcasting entries yet.
Hooks.on("renderCharacterSheetPF2e", (app, html) => {
    if (!isEnabled() || game.system.id !== "pf2e") return;

    const actor = app.actor ?? app.document;
    if (!actorCanModify(actor)) return;
    if (!actorHasApparitionAccess(actor)) return;

    const root = getSheetRoot(html);
    const tab = root?.querySelector('.tab[data-tab="spellcasting"]');
    if (!tab || tab.querySelector('[data-action="apparition-fix-manage"]')) return;

    const label = game.i18n.localize(`${MODULE_ID}.ManageApparitions.ButtonTooltip`);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = "apparition-fix-manage";
    button.classList.add("apparition-fix-manage-standalone");
    button.innerHTML = `<i class="fa-solid fa-ghost"></i> <span></span>`;
    button.querySelector("span").textContent = label;
    button.addEventListener("click", (event) => {
        event.preventDefault();
        openManageApparitions(actor);
    });

    tab.prepend(button);
});

/* -------------------------------------------- */
/*  Built-in macro                              */
/* -------------------------------------------- */

const BUILTIN_MACRO_FLAG = "manage-apparitions";

// The list of bondable apparitions is cached; any change to a custom apparition
// (or its Vessel) - made here, by an import, or by another GM - refreshes it
// and every open management window.
for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, (item) => {
        if (item.parent) return; // world items only
        const flag = item.type === "spell" ? "customApparitionVessel" : item.type === "feat" ? "customApparition" : null;
        if (!flag || !item.getFlag(MODULE_ID, flag)) return;
        availableApparitionsPromise = null;
        for (const app of foundry.applications.instances.values()) {
            if (app instanceof ManageApparitionsApp) app.reloadAvailable();
        }
    });
}

/**
 * Creates a ready-to-use "Bond/Unbond Apparition" world macro once (a GM
 * can then drag it onto their own or a player's hotbar) - a hotbar-friendly
 * alternative to the sheet button above, for anyone who'd rather not dig
 * through the sheet, or whose sheet the button doesn't apply to for some
 * reason. It just resolves the acting user's own selected token or
 * assigned character and opens the same dialog the sheet button does, so
 * there's only one bonding/unbonding implementation to trust.
 */
async function ensureBuiltinMacro() {
    if (!game.user.isGM) return; // one GM client is enough to create the shared macro once
    if (game.macros.find((macro) => macro.getFlag(MODULE_ID, "builtinMacro") === BUILTIN_MACRO_FLAG)) return;

    const command = [
        `const api = game.modules.get("${MODULE_ID}")?.api;`,
        "if (!api?.openManageApparitions) {",
        `    ui.notifications.error(game.i18n.localize("${MODULE_ID}.Notify.ModuleDisabled"));`,
        "    return;",
        "}",
        "",
        "const actor = canvas.tokens?.controlled[0]?.actor ?? game.user.character;",
        "if (!actor) {",
        `    ui.notifications.warn(game.i18n.localize("${MODULE_ID}.ManageApparitions.Notify.NoActor"));`,
        "    return;",
        "}",
        "",
        "api.openManageApparitions(actor);",
    ].join("\n");

    const macro = await Macro.create({
        name: game.i18n.localize(`${MODULE_ID}.ManageApparitions.MacroName`),
        type: "script",
        // A confirmed-present PF2e-shipped icon (not a guessed Foundry-core
        // path) - see the same reasoning in custom-apparitions.mjs's
        // DEFAULT_VESSEL_IMG.
        img: "systems/pf2e/icons/default-icons/mystery-man.svg",
        command,
        flags: { [MODULE_ID]: { builtinMacro: BUILTIN_MACRO_FLAG } },
        // Executing a script macro requires OWNER-level permission on it, not
        // just the ability to see it - OBSERVER would let a player drag this
        // onto their hotbar but not actually click it.
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER },
    });

    if (macro) {
        ui.notifications.info(game.i18n.localize(`${MODULE_ID}.ManageApparitions.Notify.MacroCreated`));
    }
}

// Precompile the management Handlebars template during initialization so the
// first click on a cold client does not also pay the one-time compile cost.
Hooks.once("init", () => {
    void foundry.applications.handlebars
        .getTemplate(`modules/${MODULE_ID}/templates/manage-apparitions.hbs`)
        .catch((error) => console.error(`${MODULE_ID} | Failed to precompile management template`, error));
});

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

function openManageApparitions(actor) {
    if (!actor) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.ManageApparitions.Notify.NoActor`));
        return null;
    }
    if (!actorCanModify(actor)) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NotOwner`));
        return null;
    }
    // ApplicationV2 instances are tracked here (`ui.windows` only holds V1 apps).
    const existing = foundry.applications.instances.get(`apparition-fix-manage-apparitions-${actor.id}`);
    if (existing instanceof ManageApparitionsApp) {
        void existing.render({ force: true });
        return existing;
    }
    const app = new ManageApparitionsApp(actor);
    void app.render({ force: true });
    return app;
}

Hooks.once("ready", () => {
    if (!isEnabled() || game.system.id !== "pf2e") return;
    void loadAvailableApparitions();

    const module = game.modules.get(MODULE_ID);
    if (module) {
        module.api = { ...module.api, openManageApparitions };
    }

    void ensureBuiltinMacro().catch((error) => console.error(`${MODULE_ID} | Failed to ensure built-in macro`, error));
});

export { loadAvailableApparitions };
