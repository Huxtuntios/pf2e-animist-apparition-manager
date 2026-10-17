/**
 * Module settings for Wandering Feats: which apparitions suit which wandering
 * feat (the requirement that is only written in the feats' descriptions),
 * and custom wandering feats. See wandering-feats.mjs for how the lists are
 * used.
 */

import {
    MODULE_ID,
    isEnabled,
    addListenerAll,
    attachIconFallback,
    getFilePickerClass,
    formatLocalized,
    notifyOperationFailed,
} from "./apparition-fix.mjs";
import { loadAvailableApparitions } from "./manage-apparitions.mjs";
import {
    loadAllWanderingFeats,
    getFeatRule,
    isSuitable,
    getRequiredLoreIds,
    getLoreName,
    setApparitionSuitable,
    resetFeatRule,
    saveCustomWanderingFeat,
    DEFAULT_WANDERING_FEAT_IMG,
    MANDATORY_TRAITS,
    getFeatTraitChoices,
} from "./wandering-feats.mjs";

const apps = foundry.applications.api;
const WINDOW_ID = "apparition-fix-wandering-requirements";

const loresText = (entry) => (entry.lores ?? []).join(", ");

async function openFeatSource(uuid) {
    const doc = uuid ? await fromUuid(uuid).catch(() => null) : null;
    if (doc?.sheet) await doc.sheet.render(true);
    else ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.ManageApparitions.Notify.SourceNotFound`));
}

/* -------------------------------------------- */
/*  The list of wandering feats                 */
/* -------------------------------------------- */

class WanderingRequirementsApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: WINDOW_ID,
        classes: ["apparition-fix", "apparition-fix-list"],
        window: { icon: "fa-solid fa-feather", resizable: true },
        position: { width: 560, height: 640 },
    };

    static PARTS = {
        list: { template: `modules/${MODULE_ID}/templates/wandering/requirements.hbs`, scrollable: ["ol"] },
    };

    #entries = new Map();

    get title() {
        return game.i18n.localize(`${MODULE_ID}.WanderingSettings.Title`);
    }

    async _prepareContext(_options) {
        const entries = (await loadAvailableApparitions()).map((entry) => ({
            key: entry.uuid,
            name: entry.name,
            img: entry.img,
            lores: entry.lores ?? [],
        }));
        this.#entries = new Map(entries.map((entry) => [entry.key, entry]));

        const feats = (await loadAllWanderingFeats()).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name, game.i18n.lang));
        return {
            feats: feats.map((feat) => {
                const rule = getFeatRule(feat.uuid);
                const suitable = entries.filter((entry) => isSuitable(feat.uuid, entry));
                const named = [...new Set([...rule.added, ...rule.marked])];
                const unknown = named.filter((key) => !this.#entries.has(key));
                return {
                    uuid: feat.uuid,
                    name: feat.name,
                    img: feat.img,
                    levelLabel: formatLocalized(`${MODULE_ID}.ManageApparitions.Wandering.OptionLevel`, { level: feat.level }),
                    custom: rule.custom,
                    modified: !rule.custom && (rule.added.size > 0 || rule.removed.size > 0),
                    loreText: getRequiredLoreIds(feat.uuid).map(getLoreName).join(" / "),
                    suitable: suitable.map((entry) => ({ ...entry, added: rule.added.has(entry.key) || rule.marked.has(entry.key) })),
                    unknown: unknown.map((key) => ({ key, name: key.split(".").pop() })),
                    candidates: entries.filter((entry) => !suitable.includes(entry)),
                    count: suitable.length,
                    none: suitable.length + unknown.length === 0,
                };
            }),
        };
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "list") return;
        attachIconFallback(html);

        addListenerAll(html, "[data-action='create-feat']", () => {
            if (game.user.isGM) new WanderingFeatEditorApp(null, { onSave: () => this.render() }).render({ force: true });
        });

        addListenerAll(html, "[data-action='edit-feat']", (el) => {
            const item = game.items.find((entry) => entry.uuid === el.dataset.uuid);
            if (game.user.isGM && item) new WanderingFeatEditorApp(item, { onSave: () => this.render() }).render({ force: true });
        });

        addListenerAll(html, "[data-action='delete-feat']", async (el) => {
            const item = game.items.find((entry) => entry.uuid === el.dataset.uuid);
            if (!game.user.isGM || !item) return;
            const confirmed = await apps.DialogV2.confirm({
                window: { title: game.i18n.localize(`${MODULE_ID}.WanderingSettings.DeleteTitle`) },
                content: `<p>${formatLocalized(`${MODULE_ID}.WanderingSettings.DeleteConfirm`, { name: foundry.utils.escapeHTML(item.name) })}</p>`,
                rejectClose: false,
            });
            if (!confirmed) return;
            await item.delete();
            this.render();
        });

        addListenerAll(html, "[data-action='open-feat']", (el) => openFeatSource(el.dataset.uuid));

        addListenerAll(html, "[data-action='reset-feat']", async (el) => {
            await resetFeatRule(el.dataset.uuid);
            this.render();
        });

        addListenerAll(html, "[data-action='add-apparition']", async (el) => {
            const entry = this.#entries.get(html.querySelector(`[name="${el.dataset.select}"]`)?.value);
            if (!entry) return;
            await this.#change(el.dataset.uuid, entry, true);
        });

        addListenerAll(html, "[data-action='remove-apparition']", async (el) => {
            const key = el.dataset.key;
            await this.#change(el.dataset.uuid, this.#entries.get(key) ?? { key, lores: [] }, false);
        });
    }

    async #change(featUuid, entry, suitable) {
        try {
            await setApparitionSuitable(featUuid, entry, suitable);
            this.render();
        } catch (error) {
            notifyOperationFailed(error);
        }
    }
}

/* -------------------------------------------- */
/*  Creating / editing a custom wandering feat  */
/* -------------------------------------------- */

class WanderingFeatEditorApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        classes: ["apparition-fix", "apparition-fix-editor"],
        window: { icon: "fa-solid fa-feather", resizable: true },
        position: { width: 520, height: 680 },
    };

    static PARTS = {
        form: { template: `modules/${MODULE_ID}/templates/wandering/editor.hbs`, scrollable: [""] },
    };

    constructor(item = null, { onSave = null, ...options } = {}) {
        super({ id: `apparition-fix-wandering-feat-editor-${item?.id ?? foundry.utils.randomID()}`, ...options });
        this.item = item;
        this.onSave = onSave;
        // Not `state`: ApplicationV2 has a read-only `state` (its render state).
        this.draft = {
            name: item?.name ?? "",
            img: item?.img || DEFAULT_WANDERING_FEAT_IMG,
            level: Number(item?.system?.level?.value) || 2,
            description: item ? this.#plainText(item.system?.description?.value) : "",
            selected: new Set(item?.getFlag(MODULE_ID, "wanderingApparitions") ?? []),
            // The extra traits the tag picker shows (the two every wandering feat has are not among them).
            traits: (item?.system?.traits?.value ?? []).filter(
                (trait) => !MANDATORY_TRAITS.includes(trait) && getFeatTraitChoices().some((choice) => choice.value === trait),
            ),
        };
    }

    get title() {
        return game.i18n.localize(`${MODULE_ID}.WanderingSettings.${this.item ? "EditTitle" : "CreateTitle"}`);
    }

    #plainText(html) {
        const element = document.createElement("div");
        element.innerHTML = String(html ?? "").replace(/<\/p>/gi, "\n");
        return (element.textContent ?? "").trim();
    }

    async _prepareContext(_options) {
        const available = await loadAvailableApparitions();
        const choices = getFeatTraitChoices();
        return {
            ...this.draft,
            traitTags: this.draft.traits.map((value) => ({
                value,
                label: choices.find((choice) => choice.value === value)?.label ?? value,
            })),
            traitChoices: choices.filter((choice) => !this.draft.traits.includes(choice.value)),
            apparitions: available
                .map((entry) => ({
                    key: entry.uuid,
                    name: entry.name,
                    img: entry.img,
                    loresText: loresText(entry),
                    searchText: `${entry.name} ${loresText(entry)}`.toLowerCase(),
                    checked: this.draft.selected.has(entry.uuid),
                }))
                .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)),
        };
    }

    /** Copy what is typed in the form into the state (before a re-render or saving). */
    #sync(root) {
        const field = (name) => root.querySelector(`[name="${name}"]`);
        this.draft.name = field("name")?.value ?? this.draft.name;
        this.draft.img = field("img")?.value.trim() || this.draft.img;
        this.draft.level = Number(field("level")?.value) || this.draft.level;
        this.draft.description = field("description")?.value ?? this.draft.description;
        if (root.querySelector('[name="apparition"]')) {
            this.draft.selected = new Set([...root.querySelectorAll('[name="apparition"]:checked')].map((box) => box.value));
        }
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "form") return;
        attachIconFallback(html);
        html.addEventListener("submit", (event) => event.preventDefault());

        // Typing a path updates the preview in place.
        html.querySelector("[data-icon-input]")?.addEventListener("change", (event) => {
            const preview = html.querySelector("[data-icon-preview]");
            if (!preview) return;
            delete preview.dataset.fallbackApplied;
            preview.src = event.target.value.trim() || DEFAULT_WANDERING_FEAT_IMG;
        });

        html.querySelector('[data-role="filter"]')?.addEventListener("input", (event) => {
            const needle = event.target.value.trim().toLowerCase();
            for (const row of html.querySelectorAll("[data-filter-text]"))
                row.hidden = !!needle && !row.dataset.filterText.includes(needle);
        });

        addListenerAll(html, "[data-action='pickIcon']", () => {
            this.#sync(this.element);
            const FilePicker = getFilePickerClass();
            if (!FilePicker) {
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NoFilePicker`));
                return;
            }
            try {
                new FilePicker({
                    type: "image",
                    current: this.draft.img || DEFAULT_WANDERING_FEAT_IMG,
                    callback: (path) => {
                        if (!path || !this.element) return;
                        this.#sync(this.element);
                        this.draft.img = path;
                        this.render();
                    },
                }).render({ force: true });
            } catch (error) {
                notifyOperationFailed(error);
            }
        });

        // Tags, as in the custom spell editor: pick one from the list to add it, click the cross to remove it.
        html.querySelector("[data-action='addTrait']")?.addEventListener("change", (event) => {
            const value = event.target.value;
            if (!value) return;
            this.#sync(this.element);
            if (!this.draft.traits.includes(value)) this.draft.traits = [...this.draft.traits, value];
            this.render();
        });

        addListenerAll(html, "[data-action='removeTrait']", (el) => {
            this.#sync(this.element);
            this.draft.traits = this.draft.traits.filter((trait) => trait !== el.dataset.value);
            this.render();
        });

        addListenerAll(html, "[data-action='cancel']", () => this.close());

        addListenerAll(html, "[data-action='save']", async () => {
            this.#sync(this.element);
            if (!game.user.isGM) return;
            if (!this.draft.name.trim()) {
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.WanderingSettings.Notify.NameRequired`));
                return;
            }
            try {
                await saveCustomWanderingFeat({
                    item: this.item,
                    name: this.draft.name.trim(),
                    img: this.draft.img,
                    level: this.draft.level,
                    description: this.draft.description,
                    apparitions: [...this.draft.selected],
                    traits: this.draft.traits,
                });
                ui.notifications.info(formatLocalized(`${MODULE_ID}.WanderingSettings.Notify.Saved`, { name: this.draft.name.trim() }));
                this.onSave?.();
                await this.close();
            } catch (error) {
                notifyOperationFailed(error);
            }
        });
    }
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

Hooks.once("init", () => {
    // The GM's changes to the lists of suitable apparitions of the system's wandering feats.
    game.settings.register(MODULE_ID, "wanderingFeatRules", { scope: "world", config: false, type: Object, default: {} });

    game.settings.registerMenu(MODULE_ID, "wanderingRequirements", {
        name: `${MODULE_ID}.Settings.WanderingRequirements.Name`,
        label: `${MODULE_ID}.Settings.WanderingRequirements.Label`,
        hint: `${MODULE_ID}.Settings.WanderingRequirements.Hint`,
        icon: "fa-solid fa-feather",
        type: WanderingRequirementsApp,
        restricted: true,
    });
});

Hooks.once("ready", () => {
    if (!isEnabled() || game.system.id !== "pf2e") return;

    const openWanderingRequirements = () => {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
            return;
        }
        (foundry.applications.instances.get(WINDOW_ID) ?? new WanderingRequirementsApp()).render({ force: true });
    };

    const module = game.modules.get(MODULE_ID);
    if (module) module.api = { ...module.api, openWanderingRequirements };
});
