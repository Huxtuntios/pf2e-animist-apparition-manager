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
    addListenerAll,
    attachIconFallback,
    getSheetRoot,
    actorHasApparitionAccess,
    actorCanModify,
    getApparitionKey,
    getBondedApparitionFeats,
    apparitionStillGrantsAnything,
    pruneLeftoverApparitions,
    getVesselSpellForApparition,
    getPrimaryVesselState,
    getPermanentApparition,
    getAttunementSummary,
    getSpiritFamiliarState,
    setSpiritFamiliar,
    markSpiritFamiliarDestroyed,
    remanifestSpiritFamiliar,
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
import { getWanderingContext, replaceWanderingFeat, resetWanderingCache, getWanderingLoadErrors } from "./wandering-feats.mjs";
import { openCustomApparitionCopy } from "./custom-apparitions.mjs";

import {
    loadAvailableApparitions,
    getCatalogErrors,
    summarizeApparition,
    getApparitionDetails,
    resolveManagerDocument,
    invalidateManagerData,
    withTimeout,
} from "./manager-data.mjs";

const apps = foundry.applications.api;

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
    if (manager) {
        const timing = manager.reportPerformance();
        for (const [label, value] of [
            ["First render", timing.firstRenderMs],
            ["Context", timing.lastContextMs],
            ["Catalog", timing.catalog?.ms],
            ["Wandering", timing.wandering?.ms],
            ["Selected profile", timing.profile?.ms],
        ]) {
            if (typeof value === "number")
                rows.push([`${game.i18n.localize(`${MODULE_ID}.ManagerUI.Timings`)} · ${label}`, `${value.toFixed(1)} ms`]);
        }
    }
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

// Client-session UI state: no world/actor data is written when browsing.
const managerUI = new WeakMap();
const managerReports = new WeakMap();
const TAB_NAMES = ["apparitions", "abilities", "profiles"];
const emptyDetails = { spells: [], vessel: null, errors: [] };
const normalizeSearchText = (value) =>
    String(value ?? "")
        .trim()
        .toLowerCase()
        .replaceAll("ё", "е");

class ManageApparitionsApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    constructor(actor, options = {}) {
        const saved = managerUI.get(actor);
        super(
            foundry.utils.mergeObject(
                { id: `apparition-fix-manage-apparitions-${actor.id}`, ...(saved?.size ? { position: saved.size } : {}) },
                options,
            ),
        );
        this.actor = actor;
        this.uiState = saved ?? { tab: "apparitions", search: "", profileId: "", fields: {}, openKeys: new Set(), scroll: {} };
        managerUI.set(actor, this.uiState);
        this.available = [];
        this.availableLoading = true;
        this.catalogError = false;
        this.details = new Map();
        this.profilePreview = null;
        this.wanderingState = null;
        this.closed = false;
        this.hasRendered = false;
        this.started = false;
        this.randomBinding = false;
        this.renderTimer = null;
        this.metrics = {
            openedAt: performance.now(),
            firstRenderMs: null,
            contextMs: 0,
            catalog: null,
            wandering: null,
            profile: null,
            details: 0,
        };
    }
    static DEFAULT_OPTIONS = {
        classes: ["apparition-fix", "apparition-fix-manage"],
        window: { icon: "fa-solid fa-ghost", resizable: true },
        position: { width: 820, height: 720 },
    };
    static PARTS = { manage: { template: `modules/${MODULE_ID}/templates/manage-apparitions.hbs`, scrollable: [] } };
    get title() {
        return formatLocalized(`${MODULE_ID}.ManageApparitions.Title`, { name: this.actor.name });
    }

    captureUI(root = this.element) {
        if (!(root instanceof HTMLElement)) return;
        for (const field of root.querySelectorAll("input[name], select[name], textarea[name]"))
            this.uiState.fields[field.name] = field.value;
        this.uiState.search = root.querySelector('[data-role="apparition-search"]')?.value ?? this.uiState.search;
        this.uiState.profileId = root.querySelector('[name="profileId"]')?.value ?? this.uiState.profileId;
        for (const details of root.querySelectorAll("details[data-detail-key], details[data-ui-section]")) {
            const key = details.dataset.detailKey ?? details.dataset.uiSection;
            if (details.open) this.uiState.openKeys.add(key);
            else this.uiState.openKeys.delete(key);
        }
        for (const scroller of root.querySelectorAll("[data-scroll-key]"))
            if (!scroller.closest("[hidden]") && scroller.getClientRects().length)
                this.uiState.scroll[scroller.dataset.scrollKey] = scroller.scrollTop;
        const focused = root.contains(document.activeElement) ? document.activeElement : null;
        if (this.pendingProfileId !== undefined) {
            this.uiState.profileId = this.pendingProfileId;
            this.uiState.fields.profileId = this.pendingProfileId;
            // Keep pending selection until the new option is present in the rendered DOM.
        }
        if (this.resetFocusInput) {
            delete this.uiState.fields.focusOverrideInput;
            // Keep this marker through queued renders until the new input is installed.
        }
        this.uiState.focus = focused
            ? {
                  name: focused.name,
                  action: focused.dataset.action,
                  key: focused.dataset.key,
                  start: focused.selectionStart,
                  end: focused.selectionEnd,
              }
            : null;
        const width = this.position?.width,
            height = this.position?.height;
        if (typeof width === "number" && typeof height === "number") this.uiState.size = { width, height };
    }
    render(options = {}) {
        if (this.closed) return this;
        this.captureUI();
        return super.render(options);
    }
    async close(options = {}) {
        this.captureUI();
        this.closed = true;
        clearTimeout(this.renderTimer);
        managerReports.set(this.actor, this.reportPerformance());
        return super.close(options);
    }
    requestRender() {
        if (this.closed || !this.hasRendered || this.renderTimer) return;
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            if (!this.closed) void this.render();
        }, 25);
    }
    reportPerformance() {
        return {
            version: "1.3.4",
            foundry: game.version,
            system: game.system.version,
            firstRenderMs: this.metrics.firstRenderMs,
            lastContextMs: this.metrics.contextMs,
            catalog: this.metrics.catalog,
            wandering: this.metrics.wandering,
            profile: this.metrics.profile,
            detailLoads: this.metrics.details,
            note: "Client observations, not a controlled benchmark. First render excludes deferred sections.",
        };
    }
    async reloadAvailable({ force = false } = {}) {
        const token = {};
        this.catalogToken = token;
        this.availableLoading = true;
        this.catalogError = false;
        const started = performance.now();
        this.availableReady = loadAvailableApparitions({ force });
        try {
            const available = await this.availableReady;
            if (this.closed || this.catalogToken !== token) return;
            this.available = available;
            this.catalogError = getCatalogErrors().length > 0;
        } catch {
            if (!this.closed && this.catalogToken === token) this.catalogError = true;
        } finally {
            if (!this.closed && this.catalogToken === token) {
                this.availableLoading = false;
                this.metrics.catalog = { ms: performance.now() - started, error: this.catalogError, count: this.available.length };
                this.requestRender();
            }
        }
    }
    summaryFor(key) {
        const feat = getBondedApparitionFeats(this.actor).find((item) => getApparitionKey(item) === key);
        return feat ? summarizeApparition(feat) : this.available.find((entry) => entry.uuid === key);
    }
    async loadDetails(key, { force = false } = {}) {
        const summary = this.summaryFor(key);
        if (!summary || this.closed) return;
        const fingerprint = JSON.stringify([summary.spellUuids, summary.vesselUuid, summary.lores, game.i18n.lang]);
        const old = this.details.get(key);
        if (!force && old?.fingerprint === fingerprint && ["loading", "ready", "error"].includes(old.status)) return;
        const state = { fingerprint, status: "loading", data: emptyDetails };
        this.details.set(key, state);
        this.requestRender();
        try {
            const data = await getApparitionDetails(summary, { force });
            if (this.closed || this.details.get(key) !== state) return;
            state.data = data;
            state.status = data.errors.length ? "error" : "ready";
        } catch {
            if (this.details.get(key) === state) state.status = "error";
        } finally {
            if (!this.closed) {
                this.metrics.details++;
                this.requestRender();
            }
        }
    }
    wanderingFingerprint() {
        return JSON.stringify([
            game.i18n.lang,
            this.actor.itemTypes.feat.map((feat) => [
                feat.id,
                feat._stats?.modifiedTime,
                feat.system?.level,
                feat.system?.description?.value,
            ]),
            this.available.map((entry) => [entry.uuid, entry.name]),
            game.settings.get(MODULE_ID, "wanderingFeatRules"),
        ]);
    }
    async ensureWandering({ force = false } = {}) {
        if (this.closed) return;
        const fingerprint = this.wanderingFingerprint();
        if (!force && this.wanderingState?.fingerprint === fingerprint) return;
        if (force) resetWanderingCache();
        const state = { fingerprint, status: "loading", data: { show: true, rows: [] } };
        this.wanderingState = state;
        const started = performance.now();
        this.requestRender();
        try {
            const data = await withTimeout(
                getWanderingContext(this.actor, { names: new Map(this.available.map((entry) => [entry.uuid, entry.name])) }),
            );
            if (this.closed || this.wanderingState !== state) return;
            state.data = data;
            state.status = data.rows?.length && getWanderingLoadErrors().length ? "error" : "ready";
        } catch {
            if (this.wanderingState === state) state.status = "error";
        } finally {
            if (!this.closed && this.wanderingState === state) {
                this.metrics.wandering = { ms: performance.now() - started, error: state.status === "error" };
                this.requestRender();
            }
        }
    }
    async ensureProfile({ force = false } = {}) {
        const profile = getApparitionProfiles(this.actor).find((profile) => profile.id === this.uiState.profileId);
        if (!profile || this.closed) {
            this.profilePreview = null;
            return;
        }
        const fingerprint = JSON.stringify([profile, game.i18n.lang]);
        if (!force && this.profilePreview?.fingerprint === fingerprint) return;
        const state = { id: profile.id, fingerprint, status: "loading", info: new Map() };
        this.profilePreview = state;
        const started = performance.now();
        this.requestRender();
        const known = new Map([
            ...this.available.map((entry) => [entry.uuid, entry]),
            ...getBondedApparitionFeats(this.actor).map((feat) => [getApparitionKey(feat), feat]),
        ]);
        const rows = await Promise.all(
            profile.apparitions.map(async (key) => {
                if (known.has(key)) return [key, known.get(key)];
                try {
                    const doc = await resolveManagerDocument(key, { force });
                    return [key, doc?.isOfType?.("feat") ? doc : null];
                } catch {
                    return [key, { error: true, name: key.split(".").pop() }];
                }
            }),
        );
        if (this.closed || this.profilePreview !== state) return;
        state.info = new Map(rows);
        state.status = rows.some(([, info]) => !info || info.error) ? "error" : "ready";
        this.metrics.profile = { ms: performance.now() - started, error: state.status === "error", count: rows.length };
        this.requestRender();
    }
    async bondApparition(uuid) {
        if (!actorCanModify(this.actor) || !uuid) return;
        if (getBondedApparitionFeats(this.actor).some((item) => getApparitionKey(item) === uuid)) return;
        try {
            const doc = await resolveManagerDocument(uuid);
            if (!doc?.isOfType?.("feat")) return;
            await addApparition(this.actor, doc);
            this.requestRender();
        } catch (error) {
            notifyOperationFailed(error);
        }
    }
    activateTab(tab, root = this.element) {
        if (!TAB_NAMES.includes(tab)) return;
        this.uiState.tab = tab;
        if (root instanceof HTMLElement) {
            for (const panel of root.querySelectorAll("[data-manager-panel]")) panel.hidden = panel.dataset.managerPanel !== tab;
            for (const button of root.querySelectorAll("[data-manager-tab]")) {
                const active = button.dataset.managerTab === tab;
                button.setAttribute("aria-selected", String(active));
                button.tabIndex = active ? 0 : -1;
            }
        }
        if (root instanceof HTMLElement)
            for (const scroller of root.querySelectorAll("[data-scroll-key]")) {
                if (!scroller.closest("[hidden]")) scroller.scrollTop = this.uiState.scroll[scroller.dataset.scrollKey] ?? 0;
            }
        if (tab === "abilities") void this.ensureWandering();
        if (tab === "profiles") void this.ensureProfile();
    }
    getFilteredAvailableApparitions() {
        const query = normalizeSearchText(this.uiState.search);
        const bonded = new Set(getBondedApparitionFeats(this.actor).map(getApparitionKey));
        return this.available.filter((entry) => {
            if (bonded.has(entry.uuid)) return false;
            if (!query) return true;
            return normalizeSearchText(`${entry.name} ${(entry.lores ?? []).join(" ")}`).includes(query);
        });
    }
    applySearch(root) {
        const query = normalizeSearchText(this.uiState.search);
        let count = 0;
        for (const row of root.querySelectorAll("[data-searchable]")) {
            row.hidden = !!query && !row.dataset.searchable.includes(query);
            if (!row.hidden) count++;
        }
        const empty = root.querySelector('[data-role="search-empty"]');
        if (empty) empty.hidden = !query || count > 0;
        const random = root.querySelector('[data-action="bond-random"]');
        if (random) random.disabled = this.getFilteredAvailableApparitions().length === 0;
    }
    _onRender(context, options) {
        super._onRender?.(context, options);
        if (this.closed) return;
        const root = this.element;
        this.hasRendered = true;
        if (this.metrics.firstRenderMs === null) this.metrics.firstRenderMs = performance.now() - this.metrics.openedAt;
        if (root instanceof HTMLElement) {
            // Restore fields only if the selected option still exists after an actor update.
            for (const field of root.querySelectorAll("input[name],select[name],textarea[name]")) {
                const value = this.uiState.fields[field.name];
                if (value !== undefined && (!(field instanceof HTMLSelectElement) || [...field.options].some((o) => o.value === value)))
                    field.value = value;
            }
            const search = root.querySelector('[data-role="apparition-search"]');
            if (search) search.value = this.uiState.search;
            for (const section of root.querySelectorAll("details[data-detail-key],details[data-ui-section]")) {
                const key = section.dataset.detailKey ?? section.dataset.uiSection;
                section.open = this.uiState.openKeys.has(key);
            }
            const selected = root.querySelector('[name="profileId"]');
            if (this.pendingProfileId !== undefined && selected?.value === this.pendingProfileId) delete this.pendingProfileId;
            if (this.resetFocusInput) this.resetFocusInput = false;
            this.activateTab(this.uiState.tab, root);
            this.applySearch(root);
            for (const scroller of root.querySelectorAll("[data-scroll-key]"))
                scroller.scrollTop = this.uiState.scroll[scroller.dataset.scrollKey] ?? 0;
            const focused = this.uiState.focus;
            if (focused) {
                const field = [...root.querySelectorAll("input,select,textarea,button")].find((el) =>
                    focused.name
                        ? el.name === focused.name
                        : focused.action && el.dataset.action === focused.action && el.dataset.key === focused.key,
                );
                if (field && !field.closest("[hidden]")) {
                    field.focus({ preventScroll: true });
                    if (typeof focused.start === "number" && field.setSelectionRange)
                        try {
                            field.setSelectionRange(focused.start, focused.end);
                        } catch {
                            /* e.g. number input */
                        }
                }
            }
        }
        if (!this.started) {
            this.started = true;
            void this.reloadAvailable();
        }
        if (this.uiState.tab === "apparitions") for (const key of this.uiState.openKeys) void this.loadDetails(key);
    }

    /** Deliberately local-only. No compendium/UUID await belongs on this path. */
    async _prepareContext(_options) {
        const started = performance.now();
        const feats = getBondedApparitionFeats(this.actor),
            permanent = getPermanentApparition(this.actor),
            familiarState = getSpiritFamiliarState(this.actor);
        const primary = new Set(getPrimaryVesselState(this.actor).primary);
        const decorate = (summary) => {
            const state = this.details.get(summary.uuid);
            return {
                ...summary,
                key: summary.uuid,
                loresText: summary.lores.join(", "),
                searchText: `${summary.name} ${summary.lores.join(" ")}`.toLowerCase().replaceAll("ё", "е"),
                expanded: this.uiState.openKeys.has(summary.uuid),
                detailLoading: !state || state.status === "loading",
                hasGrants: !!(state?.data?.spells?.length || state?.data?.vessel),
                detailError: state?.status === "error",
                detailReady: !!state && state.status !== "loading",
                ...(state?.data ?? emptyDetails),
            };
        };
        const bonded = feats
            .map((feat) => {
                const summary = summarizeApparition(feat),
                    key = summary.uuid;
                const suspended = familiarState.available && familiarState.key === key && familiarState.status === "destroyed";
                const vessel = getVesselSpellForApparition(this.actor, feat);
                return {
                    ...decorate(summary),
                    id: feat.id,
                    isPermanent: permanent.key === key,
                    suspended,
                    stale: !suspended && !apparitionStillGrantsAnything(this.actor, feat),
                    vesselIsPrimary: primary.has(key),
                    canTogglePrimary: !suspended && !!vessel,
                    primaryTitle: game.i18n.localize(
                        `${MODULE_ID}.ManageApparitions.${primary.has(key) ? "PrimaryActive" : "PrimaryInactive"}`,
                    ),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
        const keys = new Set(bonded.map((entry) => entry.key));
        const available = this.available.filter((entry) => !keys.has(entry.uuid)).map(decorate);
        const known = new Map([...this.available.map((entry) => [entry.uuid, entry]), ...bonded.map((entry) => [entry.key, entry])]);
        const profiles = getApparitionProfiles(this.actor).map((profile) => ({
            ...profile,
            selected: profile.id === this.uiState.profileId,
            label: formatLocalized(`${MODULE_ID}.ManageApparitions.ProfileOption`, {
                name: profile.name,
                count: profile.apparitions.length,
            }),
        }));
        const selected = profiles.find((profile) => profile.selected);
        const preview = selected && this.profilePreview?.id === selected.id ? this.profilePreview : null;
        const previewRows =
            selected?.apparitions.map((key) => {
                const info = known.get(key) ?? preview?.info.get(key);
                return {
                    key,
                    name: info?.name ?? key.split(".").pop(),
                    img: info?.img ?? "systems/pf2e/icons/default-icons/mystery-man.svg",
                    missing: !!preview && preview.status !== "loading" && preview.info.has(key) && !info,
                    primary: selected.primary.includes(key),
                    bonded: keys.has(key),
                    unresolved: !info || info.error,
                };
            }) ?? [];
        const focusOverride = getFocusPointsOverride(this.actor),
            attunement = getAttunementSummary(this.actor);
        const context = {
            instanceId: `am-${this.actor.id}`,
            actorName: this.actor.name,
            castingMode: game.i18n.localize(`${MODULE_ID}.ManagerUI.${attunement.mode === "archetype" ? "Archetype" : "Class"}`),
            bonded,
            available,
            availableLoading: this.availableLoading,
            catalogError: this.catalogError,
            attunement,
            attunementCompact: formatLocalized(`${MODULE_ID}.ManagerUI.AttunementCompact`, {
                count: attunement.count,
                expected: attunement.expected,
            }),
            focusValue: this.actor.system.resources?.focus?.value ?? 0,
            focusMax: this.actor.system.resources?.focus?.max ?? 0,
            wandering: this.wanderingState?.data ?? { show: true, rows: [], lores: [] },
            hasAbilitySections: permanent.available || familiarState.available || !this.wanderingState || this.wanderingState.data?.show,
            wanderingLoading: !this.wanderingState || this.wanderingState.status === "loading",
            wanderingError: this.wanderingState?.status === "error",
            permanent: {
                show: permanent.available,
                hasKey: !!permanent.key,
                key: permanent.key,
                name: known.get(permanent.key)?.name ?? permanent.name,
                img: known.get(permanent.key)?.img,
                options: [...known]
                    .map(([key, info]) => ({ key, name: info.name, selected: key === permanent.key }))
                    .sort((a, b) => a.name.localeCompare(b.name)),
            },
            familiar: {
                ...familiarState,
                destroyed: familiarState.status === "destroyed",
                options: bonded.map((entry) => ({ key: entry.key, name: entry.name, selected: entry.key === familiarState.key })),
                actors: [...game.actors]
                    .filter((actor) => actor.isOfType?.("familiar") && (actor.isOwner || game.user.isGM))
                    .map((actor) => ({
                        uuid: actor.uuid,
                        name: actor.name,
                        selected: actor.uuid === (familiarState.actorUuid ?? this.actor.familiar?.uuid),
                    })),
            },
            profiles,
            hasProfiles: profiles.length > 0,
            selectedProfile: !!selected,
            profileLoading: !!selected && (!preview || preview.status === "loading"),
            profileError: preview?.status === "error",
            previewRows,
            toUnbind: selected ? bonded.filter((entry) => !selected.apparitions.includes(entry.key)).map((entry) => entry.name) : [],
            hasLastDaySnapshot: !!getLastDayApparitionSnapshot(this.actor)?.apparitions.length,
            focusOverride,
            hasFocusOverride: focusOverride !== null,
            autoPrimary: isAutoPrimaryEnabled(),
            isGM: !!game.user.isGM,
            tabApparitions: this.uiState.tab === "apparitions",
            tabAbilities: this.uiState.tab === "abilities",
            tabProfiles: this.uiState.tab === "profiles",
        };
        this.metrics.contextMs = performance.now() - started;
        return context;
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "manage") return;
        for (const button of html.querySelectorAll("[data-manager-tab]")) {
            button.addEventListener("click", () => {
                this.captureUI(html);
                this.activateTab(button.dataset.managerTab, html);
            });
            button.addEventListener("keydown", (event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const index = TAB_NAMES.indexOf(this.uiState.tab);
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? TAB_NAMES.length - 1
                          : (index + (event.key === "ArrowRight" ? 1 : -1) + TAB_NAMES.length) % TAB_NAMES.length;
                this.captureUI(html);
                this.activateTab(TAB_NAMES[next], html);
                html.querySelector(`[data-manager-tab="${TAB_NAMES[next]}"]`)?.focus();
            });
        }
        for (const details of html.querySelectorAll("details[data-detail-key]")) {
            details.addEventListener("toggle", () => {
                if (details.open) {
                    this.uiState.openKeys.add(details.dataset.detailKey);
                    void this.loadDetails(details.dataset.detailKey);
                } else this.uiState.openKeys.delete(details.dataset.detailKey);
            });
        }
        addListenerAll(html, "[data-action='retry-catalog']", () => {
            void this.reloadAvailable({ force: true });
            this.requestRender();
        });
        addListenerAll(html, "[data-action='retry-details']", (button) => void this.loadDetails(button.dataset.key, { force: true }));
        addListenerAll(html, "[data-action='retry-wandering']", () => void this.ensureWandering({ force: true }));
        addListenerAll(html, "[data-action='retry-profile']", () => void this.ensureProfile({ force: true }));
        addListenerAll(html, "[data-action='clear-search']", () => {
            this.uiState.search = "";
            const search = html.querySelector('[data-role="apparition-search"]');
            if (search) search.value = "";
            this.applySearch(html);
        });

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
                await removeApparition(this.actor, item);
                this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='bond']", (el) => this.bondApparition(el.dataset.uuid));

        addListenerAll(html, "[data-action='set-spirit-familiar']", async () => {
            try {
                const key = html.querySelector('[name="familiarApparition"]')?.value;
                const uuid = html.querySelector('[name="spiritFamiliarActor"]')?.value || null;
                if (key && (await setSpiritFamiliar(this.actor, key, uuid))) this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });
        addListenerAll(html, "[data-action='destroy-spirit-familiar']", async () => {
            try {
                if (await markSpiritFamiliarDestroyed(this.actor)) this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });
        addListenerAll(html, "[data-action='remanifest-spirit-familiar']", async () => {
            try {
                if (await remanifestSpiritFamiliar(this.actor)) this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='set-permanent']", async () => {
            const key = html.querySelector('[name="permanentApparition"]')?.value;
            if (!key || !actorCanModify(this.actor)) return;
            try {
                if (await setPermanentApparition(this.actor, key)) this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        // Choose from the same current state the search UI represents, never from DOM visibility.
        addListenerAll(html, "[data-action='bond-random']", async () => {
            if (this.randomBinding) return;
            const candidates = this.getFilteredAvailableApparitions();
            if (!candidates.length) {
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.Notify.NoRandomApparition`));
                return;
            }
            this.randomBinding = true;
            try {
                const entry = candidates[Math.floor(Math.random() * candidates.length)];
                await this.bondApparition(entry.uuid);
            } finally {
                this.randomBinding = false;
            }
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
                this.requestRender();
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
            if (await replaceWanderingFeat(this.actor, el.dataset.featId, select?.value)) this.requestRender();
        });

        addListenerAll(html, "[data-action='cleanup-vessels']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const removed = await pruneLeftoverApparitions(this.actor);
                const messageKey = removed ? `${MODULE_ID}.Notify.VesselsCleanedUp` : `${MODULE_ID}.Notify.NoVesselsToCleanUp`;
                ui.notifications.info(formatLocalized(messageKey, { count: removed }));
                this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        const profileSelect = html.querySelector("[name='profileId']");
        profileSelect?.addEventListener("change", (event) => {
            this.uiState.profileId = event.target.value;
            const profile = getApparitionProfiles(this.actor).find((entry) => entry.id === event.target.value);
            const input = html.querySelector('[name="profileName"]');
            if (profile && input) input.value = profile.name;
            this.captureUI(html);
            void this.ensureProfile();
            this.requestRender();
        });

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
                const saved = await saveApparitionProfile(this.actor, name, { id: selectedId });
                this.uiState.profileId = saved.id;
                this.uiState.fields.profileId = saved.id;
                if (html.querySelector('[name="profileId"]')) html.querySelector('[name="profileId"]').value = selectedId ?? "";
                // The new option does not exist until render; captureUI must not restore the old selection.
                this.pendingProfileId = saved.id;
                ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.ProfileSaved`, { name }));
                this.requestRender();
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
                this.requestRender();
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
                this.pendingProfileId = "";
                this.profilePreview = null;
                this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='restore-yesterday']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                const result = await restoreLastDayApparitions(this.actor);
                ui.notifications.info(formatLocalized(`${MODULE_ID}.Notify.LastDayRestored`, result));
                this.requestRender();
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
                this.requestRender();
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
                this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='clear-focus-override']", async () => {
            if (!actorCanModify(this.actor)) return;
            try {
                await setFocusPointsOverride(this.actor, null);
                this.resetFocusInput = true;
                this.requestRender();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        addListenerAll(html, "[data-action='closeWindow']", () => this.close());

        const search = html.querySelector('[data-role="apparition-search"]');
        search?.addEventListener("input", () => {
            this.uiState.search = search.value;
            this.applySearch(html);
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

// Refresh client caches on relevant source changes, never by writing actor data.
function refreshManagerSources() {
    invalidateManagerData();
    resetWanderingCache();
    for (const app of foundry.applications.instances.values())
        if (app instanceof ManageApparitionsApp) {
            app.details.clear();
            app.profilePreview = null;
            app.wanderingState = null;
            void app.reloadAvailable();
            app.requestRender();
        }
}
for (const hook of ["createItem", "updateItem", "deleteItem"])
    Hooks.on(hook, (item) => {
        if (item.parent) {
            for (const app of foundry.applications.instances.values())
                if (app instanceof ManageApparitionsApp && app.actor === item.parent) app.requestRender();
            return;
        }
        // World spell/feat metadata can be referenced by custom apparitions even without module flags.
        const relevant = item.type === "feat" || item.type === "spell";
        if (relevant) refreshManagerSources();
    });
Hooks.on("updateCompendium", refreshManagerSources);
Hooks.on("updateActor", (actor) => {
    for (const app of foundry.applications.instances.values())
        if (app instanceof ManageApparitionsApp && app.actor === actor) app.requestRender();
});

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
        module.api = { ...module.api, openManageApparitions, getManagerPerformance };
    }

    void ensureBuiltinMacro().catch((error) => console.error(`${MODULE_ID} | Failed to ensure built-in macro`, error));
});

function getManagerPerformance(actor) {
    const app = foundry.applications.instances.get(`apparition-fix-manage-apparitions-${actor?.id}`);
    return app instanceof ManageApparitionsApp ? app.reportPerformance() : (managerReports.get(actor) ?? null);
}
export { loadAvailableApparitions, ManageApparitionsApp, getManagerPerformance };
