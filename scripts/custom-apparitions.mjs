/**
 * Custom apparitions - the editor for homebrew apparitions.
 *
 * Lets a GM author ordinary world feat Items that represent homebrew Animist
 * apparitions. The HTML structure of the official apparitions is kept, because
 * this module's own parser relies on it:
 *
 *   - an Animist feat tagged `animist-apparition`;
 *   - an `<hr/>` followed by the Lore paragraph;
 *   - an Apparition Spells `<ul>`;
 *   - a Vessel spell reference immediately after that list.
 *
 * The regular apparition spells are chosen by dragging existing spells from a
 * compendium or the world into the form. The Vessel is authored in the
 * built-in two-step form and stored as its own world spell Item. No external
 * registry is involved.
 */

import {
    MODULE_ID,
    isEnabled,
    ordinalString,
    parseApparitionSpellUuids,
    parseApparitionVesselUuid,
    parseApparitionLores,
    notifyOperationFailed,
    formatLocalized,
    addListenerAll,
    attachIconFallback,
    getFilePickerClass,
    getCustomAvatarFormUuid,
    loadAvatarsModuleExports,
    LEGACY_CUSTOM_APPARITION_AVATAR_FLAG,
} from "./apparition-fix.mjs";

const apps = foundry.applications.api;

const APPARITIONS_FOLDER_NAME_KEY = `${MODULE_ID}.CustomApparition.FolderName`;
const VESSELS_FOLDER_NAME_KEY = `${MODULE_ID}.CustomApparition.VesselFolderName`;
const FOLDER_KIND = { apparitions: "customApparitionsFolder", vessels: "customVesselsFolder" };

/**
 * The Animist avatar forms of pf2e-avatars, the same list that module uses.
 * pf2e-avatars is optional; when it is inactive or unavailable the editor
 * keeps any stored selection but offers no new choices.
 *
 * @returns {Promise<{ value: string, label: string }[]>}
 */
async function getAvatarFormChoices() {
    try {
        const avatars = await loadAvatarsModuleExports();
        return (avatars?.APPARITION_AVATARS ?? [])
            .filter((entry) => typeof entry?.value === "string" && typeof entry?.label === "string")
            .map((entry) => ({ value: entry.value, label: entry.label }));
    } catch (error) {
        console.warn(`${MODULE_ID} | Could not read the available forms from pf2e-avatars`, error);
        return [];
    }
}

/* -------------------------------------------- */
/*  Small shared helpers                        */
/* -------------------------------------------- */

/**
 * @param {Item} doc A live SpellPF2e document (from `fromUuid`).
 * @returns {{ uuid: string, name: string, img: string, isCantrip: boolean, rank: number }}
 */
function spellToRow(doc) {
    return {
        uuid: doc.uuid,
        name: doc.name,
        img: doc.img,
        isCantrip: !!doc.isCantrip,
        rank: doc.baseRank ?? doc.system?.level?.value ?? 1,
    };
}

/**
 * Every trait PF2e itself considers valid on a spell (`CONFIG.PF2E.spellTraits`
 * - the same list the system's own spell sheet offers), minus "animist" and
 * "focus" - those two are always applied to a Vessel spell automatically and
 * aren't meant to be toggled here.
 *
 * @returns {{ value: string, label: string }[]}
 */
function getVesselTraitChoices() {
    return Object.entries(CONFIG.PF2E.spellTraits ?? {})
        .filter(([slug]) => slug !== "animist" && slug !== "focus")
        .map(([value, labelKey]) => ({ value, label: game.i18n.localize(labelKey) }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Find (or create) the world Item folder of the given kind - used to keep
 * everything this feature creates organized and easy for a GM to find,
 * inspect, or delete directly. The folder is recognized by a flag, not by
 * its name, so renaming it or switching the UI language doesn't spawn a
 * second one; a folder from before it was flagged is found by name once
 * and adopted.
 *
 * @param {string} kind A `FOLDER_KIND` value.
 * @param {string} name Localized name for a newly created folder.
 * @param {string|null} parentId
 * @returns {Promise<Folder>}
 */
async function getOrCreateFolder(kind, name, parentId) {
    const tagged = game.folders.find((folder) => folder.type === "Item" && folder.getFlag(MODULE_ID, kind));
    if (tagged) return tagged;

    const byName = game.folders.find(
        (folder) => folder.type === "Item" && folder.name === name && (folder.folder?.id ?? null) === (parentId ?? null),
    );
    if (byName) {
        await byName.setFlag(MODULE_ID, kind, true);
        return byName;
    }

    return Folder.create({ name, type: "Item", folder: parentId ?? null, color: "#4b0082", flags: { [MODULE_ID]: { [kind]: true } } });
}

function getApparitionsFolder() {
    return getOrCreateFolder(FOLDER_KIND.apparitions, game.i18n.localize(APPARITIONS_FOLDER_NAME_KEY), null);
}

async function getVesselsFolder() {
    const parent = await getApparitionsFolder();
    return getOrCreateFolder(FOLDER_KIND.vessels, game.i18n.localize(VESSELS_FOLDER_NAME_KEY), parent.id);
}

async function extractEditorSeed(apparitionItem, { copyName = true } = {}) {
    const spellUuids = parseApparitionSpellUuids(apparitionItem);
    const spellDocs = await Promise.all(spellUuids.map((uuid) => fromUuid(uuid)));
    const vesselUuid = parseApparitionVesselUuid(apparitionItem);
    const vesselDoc = vesselUuid ? await fromUuid(vesselUuid) : null;
    const description = vesselDoc?.description ?? vesselDoc?.system?.description?.value ?? "";
    const container = document.createElement("div");
    container.innerHTML = description;
    const vesselDescription = Array.from(container.querySelectorAll("p"))
        .map((p) => p.textContent?.trim() ?? "")
        .filter(Boolean)
        .join("\n");
    const seed = {
        name: copyName ? `${apparitionItem.name} (${game.i18n.localize(`${MODULE_ID}.CustomApparition.CopySuffix`)})` : apparitionItem.name,
        img: apparitionItem.img || DEFAULT_APPARITION_IMG,
        avatarUuid: getCustomAvatarFormUuid(apparitionItem),
        flavor: parseApparitionFlavor(apparitionItem),
        loresText: parseApparitionLores(apparitionItem).join(", "),
        spells: spellDocs
            .filter((doc) => doc?.isOfType?.("spell"))
            .map((doc) => ({ ...spellToRow(doc), source: doc.toObject?.() ?? null })),
        vessel: vesselDoc?.isOfType?.("spell")
            ? {
                  name: vesselDoc.name,
                  img: vesselDoc.img || DEFAULT_VESSEL_IMG,
                  rank: vesselDoc.system?.level?.value ?? 1,
                  actions: vesselDoc.system?.time?.value ?? "1",
                  range: vesselDoc.system?.range?.value ?? "",
                  target: vesselDoc.system?.target?.value ?? "",
                  duration: vesselDoc.system?.duration?.value ?? "",
                  description: vesselDescription,
                  extraTraits: (vesselDoc.system?.traits?.value ?? []).filter((trait) => trait !== "animist" && trait !== "focus"),
                  source: vesselDoc.toObject(),
              }
            : {
                  name: `${apparitionItem.name} ${game.i18n.localize(`${MODULE_ID}.CustomApparition.Vessel`)}`,
                  img: DEFAULT_VESSEL_IMG,
                  rank: 1,
                  actions: "1",
                  range: "",
                  target: "",
                  duration: "",
                  description: "",
                  extraTraits: [],
                  source: null,
              },
    };
    return seed;
}

function downloadJson(filename, data) {
    foundry.utils.saveDataToFile(JSON.stringify(data, null, 2), "application/json", filename);
}

/* -------------------------------------------- */
/*  Reconstructing form state for editing       */
/* -------------------------------------------- */

function getDescriptionContainer(item) {
    const container = document.createElement("div");
    container.innerHTML = item?.description ?? item?.system?.description?.value ?? "";
    return container;
}

/**
 * The apparition's own flavor text - whatever `<p>` this module's own
 * generator put first (see `buildApparitionDescriptionHtml`). Best-effort
 * only: if the description was hand-edited into something unusual, this
 * simply returns the first paragraph found, if any.
 */
function parseApparitionFlavor(item) {
    const p = getDescriptionContainer(item).querySelector("p");
    return p?.textContent?.trim() ?? "";
}

/* -------------------------------------------- */
/*  Building the actual Item sources            */
/* -------------------------------------------- */

/**
 * The description structure this module's parser reads: an intro paragraph,
 * optional Lore paragraph after `<hr/>`, then a spell `<ul>` of `@UUID[]`
 * links (possibly empty), then an optional Vessel paragraph immediately after
 * that `<ul>`. Keeping the structure simple also keeps old custom Items
 * readable after upgrades.
 */
function buildApparitionDescriptionHtml({ flavor, lores, spells, vessel }) {
    const esc = (s) => foundry.utils.escapeHTML(s ?? "");

    const flavorHtml = flavor ? `<p>${esc(flavor)}</p>` : "";

    const loreNames = lores.map((name) => (/ Lore$/i.test(name) ? name : `${name} Lore`));
    const loresHtml = loreNames.length
        ? `<hr /><p><strong>${esc(game.i18n.localize(`${MODULE_ID}.CustomApparition.SkillsLabel`))}</strong> ${esc(loreNames.join(", "))}</p>`
        : "";

    const spellItems = spells
        .map((spell) => {
            const label = spell.isCantrip ? game.i18n.localize(`${MODULE_ID}.CustomApparition.Cantrip`) : ordinalString(spell.rank);
            return `<li><strong>${esc(label)}</strong> @UUID[${spell.uuid}]{${esc(spell.name)}}</li>`;
        })
        .join("");
    // Always emit the <ul>, even when it is empty: the module parser safely
    // iterates an empty list, and the Vessel parser expects the Vessel paragraph
    // to be `ul.nextElementSibling`.
    const spellsHtml = `<p><strong>${esc(game.i18n.localize(`${MODULE_ID}.CustomApparition.SpellsLabel`))}</strong></p><ul>${spellItems}</ul>`;

    const vesselHtml = vessel
        ? `<p><strong>${esc(game.i18n.localize(`${MODULE_ID}.CustomApparition.VesselLabel`))}</strong> @UUID[${vessel.uuid}]{${esc(vessel.name)}}</p>`
        : "";

    return [flavorHtml, loresHtml, spellsHtml, vesselHtml].filter(Boolean).join("\n");
}

// PF2e itself ships one generic default icon per item type at
// `systems/pf2e/icons/default-icons/<type>.svg` (see `ItemPF2e.getDefaultArtwork`
// in the system's own code: `{ img: \`systems/pf2e/icons/default-icons/${e.type}.svg\` }`) -
// guaranteed to exist as long as the type is a real PF2e item type, unlike
// picking some specific Foundry-core icon by path and hoping it's still
// there under that exact name in this Foundry version.
const DEFAULT_VESSEL_IMG = "systems/pf2e/icons/default-icons/spell.svg";
const DEFAULT_APPARITION_IMG = "systems/pf2e/icons/default-icons/feat.svg";
const DEFAULT_ICONS = { apparition: DEFAULT_APPARITION_IMG, vessel: DEFAULT_VESSEL_IMG };

/**
 * Only the fields the Vessel spell form actually edits. Used as-is for the
 * *update* payload when editing an existing custom apparition - and
 * deliberately does NOT touch `area`, `defense`, `damage`, `cost`,
 * `requirements`, `duration.sustained`, `rarity`, `traditions`, or
 * `system.rules` at all, so anything a GM adds directly on the Vessel
 * spell's own item sheet (a damage roll, a save DC, a Rule Element, etc.)
 * survives being re-saved here instead of getting silently reset.
 *
 * Two fields are rebuilt from plain form text, so on an existing spell they
 * are protected explicitly: traits the form's picker can't show are kept,
 * and the description (links and formatting added by hand) is only replaced
 * when its text was actually edited (`vessel.descriptionChanged`).
 *
 * @param {{ name: string, img?: string, rank: number, actions: string, range: string, target: string, duration: string, description: string, descriptionChanged?: boolean, extraTraits?: string[] }} vessel
 * @param {Item|null} [existing] The Vessel spell being updated, if any.
 */
function buildVesselSpellFields(vessel, existing = null) {
    const paragraphs = (vessel.description ?? "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
    const descriptionHtml = paragraphs.map((line) => `<p>${foundry.utils.escapeHTML(line)}</p>`).join("");

    // "animist" and "focus" are always present - they're what makes this a
    // proper focus spell PF2e recognizes (per `SpellPF2e#isFocusSpell`,
    // which checks `traits.value.includes("focus")`; there's no separate
    // "category" field on a spell's own schema). Anything else the GM picked
    // from PF2e's own full spell trait list is added on top, de-duplicated.
    const extraTraits = (Array.isArray(vessel.extraTraits) ? vessel.extraTraits : []).filter(
        (trait) => trait && trait !== "animist" && trait !== "focus",
    );
    const pickable = new Set(getVesselTraitChoices().map((choice) => choice.value));
    const preserved = (existing?.system?.traits?.value ?? []).filter(
        (trait) => trait !== "animist" && trait !== "focus" && !pickable.has(trait),
    );
    const traitValue = [...new Set(["animist", "focus", ...extraTraits, ...preserved])];

    const fields = {
        name: vessel.name,
        ...(vessel.img ? { img: vessel.img } : {}),
        system: {
            level: { value: Math.min(10, Math.max(1, Number(vessel.rank) || 1)) },
            traits: { value: traitValue },
            time: { value: vessel.actions || "1" },
            range: { value: vessel.range ?? "" },
            target: { value: vessel.target ?? "" },
            duration: { value: vessel.duration ?? "" },
        },
    };
    if (!existing || vessel.descriptionChanged) fields.system.description = { value: descriptionHtml };
    return fields;
}

/**
 * The full source for a brand-new Vessel spell: the form's own fields (see
 * `buildVesselSpellFields`) plus sensible blank defaults for everything
 * else a real spell needs but this form doesn't expose - those defaults are
 * only ever applied once, at creation; see `buildVesselSpellFields` for why
 * they're deliberately left out of the update path.
 *
 * @param {Parameters<typeof buildVesselSpellFields>[0]} vessel
 */
function buildNewVesselSpellSource(vessel) {
    const preservedSystem = vessel?.source?.system ? foundry.utils.deepClone(vessel.source.system) : {};
    const base = {
        type: "spell",
        img: vessel.img || DEFAULT_VESSEL_IMG,
        system: foundry.utils.mergeObject(
            {
                traits: { traditions: [], rarity: "common" },
                area: null,
                cost: { value: "" },
                defense: null,
                damage: {},
                duration: { sustained: false },
                requirements: "",
            },
            preservedSystem,
            { inplace: false },
        ),
        flags: {
            [MODULE_ID]: { customApparitionVessel: true },
        },
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
    };
    return foundry.utils.mergeObject(base, buildVesselSpellFields(vessel), { inplace: false });
}

/**
 * Create or update a custom apparition (and its Vessel spell).
 *
 * @param {object} data
 * @param {Item|null} data.existingItem The apparition feat to update, or null to create a new one.
 * @param {string} data.name
 * @param {string} data.img Icon path of the apparition feat.
 * @param {string} data.flavor
 * @param {string[]} data.lores
 * @param {{uuid:string,name:string}[]} data.spells
 * @param {object} data.vessel See `buildVesselSpellSource`.
 * @returns {Promise<Item>} The apparition feat item.
 */
async function saveCustomApparition({ existingItem, name, img, flavor, lores, spells, vessel, sourceUuid = null, avatarUuid = "" }) {
    if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
        return null;
    }

    try {
        const vesselsFolder = await getVesselsFolder();
        const apparitionsFolder = await getApparitionsFolder();

        // Create or update the vessel spell - always this apparition's own,
        // never shared with another apparition.
        const existingVesselUuid = existingItem ? parseApparitionVesselUuid(existingItem) : null;
        const existingVesselItem = existingVesselUuid ? await fromUuid(existingVesselUuid) : null;
        const isExistingVessel = existingVesselItem?.isOwner && existingVesselItem.getFlag(MODULE_ID, "customApparitionVessel");

        let vesselItem;
        if (isExistingVessel) {
            await existingVesselItem.update(buildVesselSpellFields(vessel, existingVesselItem));
            vesselItem = existingVesselItem;
        } else {
            const vesselSource = buildNewVesselSpellSource(vessel);
            [vesselItem] = await Item.createDocuments([{ ...vesselSource, folder: vesselsFolder?.id ?? null }]);
        }

        const descriptionHtml = buildApparitionDescriptionHtml({
            flavor,
            lores,
            spells,
            vessel: { uuid: vesselItem.uuid, name: vesselItem.name },
        });

        const apparitionSource = {
            name,
            type: "feat",
            img: img || existingItem?.img || DEFAULT_APPARITION_IMG,
            system: {
                actionType: { value: "passive" },
                actions: { value: null },
                category: "classfeature",
                level: { value: 1 },
                traits: { value: ["animist"], otherTags: ["animist-apparition"], rarity: "common" },
                description: { value: descriptionHtml },
            },
            flags: {
                [MODULE_ID]: {
                    customApparition: true,
                    vesselAvatarFormUuid: typeof avatarUuid === "string" ? avatarUuid : "",
                    ...(sourceUuid || existingItem?.getFlag(MODULE_ID, "customApparitionSourceUuid")
                        ? { customApparitionSourceUuid: sourceUuid || existingItem.getFlag(MODULE_ID, "customApparitionSourceUuid") }
                        : {}),
                },
            },
            ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
        };

        let apparitionItem;
        if (existingItem?.isOwner) {
            const { type: _type, ownership: _ownership, ...updateData } = apparitionSource;
            await existingItem.update(updateData);
            apparitionItem = existingItem;
        } else {
            [apparitionItem] = await Item.createDocuments([{ ...apparitionSource, folder: apparitionsFolder?.id ?? null }]);
        }

        await apparitionItem.unsetFlag(MODULE_ID, LEGACY_CUSTOM_APPARITION_AVATAR_FLAG);

        await vesselItem.update({
            [`flags.${MODULE_ID}.customApparitionSource`]: apparitionItem.uuid,
            [`flags.${MODULE_ID}.origin`]: { type: "custom-apparition", apparitionUuid: apparitionItem.uuid, grant: "vessel" },
        });
        await apparitionItem.setFlag(MODULE_ID, "origin", { type: "custom-apparition", vesselUuid: vesselItem.uuid });

        ui.notifications.info(formatLocalized(`${MODULE_ID}.CustomApparition.Notify.Saved`, { name }));

        return apparitionItem;
    } catch (error) {
        notifyOperationFailed(error);
        return null;
    }
}

/**
 * @param {Item} apparitionItem
 */
async function deleteCustomApparition(apparitionItem) {
    if (!game.user.isGM) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
        return;
    }

    try {
        const vesselUuid = parseApparitionVesselUuid(apparitionItem);

        await apparitionItem.delete();

        // Only clean up the vessel spell if it's actually one this feature
        // created for this apparition - never delete something else a GM might
        // have pointed the description at by hand.
        const vesselItem = vesselUuid ? await fromUuid(vesselUuid) : null;
        if (vesselItem?.isOwner && vesselItem.getFlag(MODULE_ID, "customApparitionVessel")) {
            await vesselItem.delete();
        }
    } catch (error) {
        notifyOperationFailed(error);
    }
}

/* -------------------------------------------- */
/*  Applications                                */
/* -------------------------------------------- */

/**
 * Options of the Vessel's cast-time select. A value a GM set by hand on the
 * spell (e.g. "1 minute") is kept as an extra option, so the select can't
 * silently replace it with "1" on the next save.
 *
 * @param {string} current
 * @returns {{ value: string, label: string, selected: boolean }[]}
 */
function getVesselActionOptions(current) {
    const value = current || "1";
    const options = [
        { value: "1", label: "1" },
        { value: "2", label: "2" },
        { value: "3", label: "3" },
        { value: "reaction", label: game.i18n.localize(`${MODULE_ID}.CustomApparition.Reaction`) },
        { value: "free", label: game.i18n.localize(`${MODULE_ID}.CustomApparition.Free`) },
    ];
    if (!options.some((option) => option.value === value)) options.push({ value, label: value });
    return options.map((option) => ({ ...option, selected: option.value === value }));
}

class CustomApparitionEditorApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    /**
     * @param {Item|null} apparitionItem Existing custom apparition to edit, or null to create a new one.
     * @param {{ onSave?: () => void }} [options]
     */
    constructor(apparitionItem = null, { onSave = null, seed = null, ...options } = {}) {
        // One window per apparition (a fixed id would make two editors collide).
        super({ id: `apparition-fix-custom-apparition-editor-${apparitionItem?.id ?? foundry.utils.randomID()}`, ...options });
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
        }
        this.apparitionItem = apparitionItem ?? null;
        this.onSave = onSave;
        this.seed = seed;
        this.sourceUuid = seed?.sourceUuid ?? apparitionItem?.getFlag?.(MODULE_ID, "customApparitionSourceUuid") ?? null;

        this.nameValue = seed?.name ?? apparitionItem?.name ?? "";
        this.img = seed?.img ?? apparitionItem?.img ?? DEFAULT_APPARITION_IMG;
        this.avatarUuid = seed?.vessel?.avatarFormUuid ?? seed?.avatarUuid ?? getCustomAvatarFormUuid(apparitionItem);
        this.flavor = seed?.flavor ?? "";
        this.loresText = seed?.loresText ?? "";
        this.spells = seed?.spells ? [...seed.spells] : [];
        this.vessel = seed?.vessel
            ? { ...seed.vessel }
            : {
                  name: "",
                  img: DEFAULT_VESSEL_IMG,
                  rank: 1,
                  actions: "1",
                  range: "",
                  target: "",
                  duration: "",
                  description: "",
                  extraTraits: [],
              };
        this.vesselDescriptionOriginal = seed?.vessel?.description ?? "";
        this.isSaving = false;
        this.step = 1;

        this.ready = this.#initialize();
    }

    static DEFAULT_OPTIONS = {
        classes: ["apparition-fix", "apparition-fix-editor"],
        window: { icon: "fa-solid fa-ghost", resizable: true },
        // A fixed height (rather than "auto") is what actually lets the
        // scrollable part below take over once content overflows it -
        // "auto" just kept growing the window past the screen edge, making
        // the bottom of a long form (and its Save button) unreachable.
        // Smaller than before now that the form is split into steps (see
        // `this.step`) - each one only ever shows a fraction of the fields
        // the old single giant page did.
        position: { width: 560, height: 560 },
    };

    static PARTS = {
        form: {
            template: `modules/${MODULE_ID}/templates/custom-apparitions/editor.hbs`,
            scrollable: [""],
        },
    };

    get title() {
        return this.apparitionItem
            ? game.i18n.localize(`${MODULE_ID}.CustomApparition.EditTitle`)
            : game.i18n.localize(`${MODULE_ID}.CustomApparition.CreateTitle`);
    }

    async #initialize() {
        const item = this.apparitionItem;
        if (!item) return;

        this.flavor = parseApparitionFlavor(item);
        this.loresText = parseApparitionLores(item).join(", ");

        const spellUuids = parseApparitionSpellUuids(item);
        const resolvedSpells = await Promise.all(spellUuids.map((uuid) => fromUuid(uuid)));
        this.spells = resolvedSpells.filter((doc) => doc?.isOfType?.("spell")).map(spellToRow);

        const vesselUuid = parseApparitionVesselUuid(item);
        const vesselDoc = vesselUuid ? await fromUuid(vesselUuid) : null;
        if (vesselDoc) {
            const paragraphs = Array.from(
                (() => {
                    const container = document.createElement("div");
                    container.innerHTML = vesselDoc.description ?? vesselDoc.system?.description?.value ?? "";
                    return container.querySelectorAll("p");
                })(),
            );
            this.vessel = {
                name: vesselDoc.name,
                img: vesselDoc.img || DEFAULT_VESSEL_IMG,
                rank: vesselDoc.system?.level?.value ?? 1,
                actions: vesselDoc.system?.time?.value ?? "1",
                range: vesselDoc.system?.range?.value ?? "",
                target: vesselDoc.system?.target?.value ?? "",
                duration: vesselDoc.system?.duration?.value ?? "",
                description: paragraphs.map((p) => p.textContent?.trim() ?? "").join("\n"),
                extraTraits: (vesselDoc.system?.traits?.value ?? []).filter((trait) => trait !== "animist" && trait !== "focus"),
            };
            this.vesselDescriptionOriginal = this.vessel.description;
        }
    }

    async _prepareContext(_options) {
        await this.ready;

        const allTraitChoices = getVesselTraitChoices();
        const selectedTraits = new Set(this.vessel.extraTraits ?? []);
        const avatarFormChoices = await getAvatarFormChoices();

        return {
            step: this.step,
            isStep1: this.step === 1,
            isStep2: this.step === 2,
            name: this.nameValue,
            img: this.img,
            flavor: this.flavor,
            loresText: this.loresText,
            spells: this.spells.map((spell) => ({
                ...spell,
                rankLabel: spell.isCantrip ? game.i18n.localize(`${MODULE_ID}.CustomApparition.Cantrip`) : ordinalString(spell.rank),
            })),
            vessel: this.vessel,
            avatarUuid: this.avatarUuid,
            hasAvatarFormChoices: avatarFormChoices.length > 0,
            avatarFormChoices: avatarFormChoices.map((choice) => ({ ...choice, selected: choice.value === this.avatarUuid })),
            vesselActionOptions: getVesselActionOptions(this.vessel.actions),
            // Split so the "add a trait" dropdown never offers one that's
            // already a tag - see the tag-picker markup in editor.hbs.
            vesselTraitTags: allTraitChoices.filter((choice) => selectedTraits.has(choice.value)),
            vesselTraitChoices: allTraitChoices.filter((choice) => !selectedTraits.has(choice.value)),
        };
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "form") return;

        // The part root is the <form>; it has no submit button, but make sure
        // Enter in a text field can never navigate the page away.
        html.addEventListener("submit", (event) => event.preventDefault());

        const dropzone = html.querySelector('[data-drop-zone="spells"]');
        dropzone?.addEventListener("dragover", (event) => event.preventDefault());
        dropzone?.addEventListener("drop", (event) => this.#onDropSpell(event));

        addListenerAll(html, "[data-action='removeSpell']", (el) => {
            this.#syncFormState(html);
            this.spells = this.spells.filter((spell) => spell.uuid !== el.dataset.uuid);
            this.render();
        });

        addListenerAll(html, "[data-action='save']", () => this.#onSave(html));
        addListenerAll(html, "[data-action='cancel']", () => this.close());
        attachIconFallback(html);

        addListenerAll(html, "[data-action='pickIcon']", (el) => this.#onPickIcon(el.dataset.target));
        // Typing a path by hand updates the preview in place (no re-render,
        // which would swallow the click that just blurred the field).
        for (const input of html.querySelectorAll("[data-icon-input]")) {
            input.addEventListener("change", () => {
                const target = input.dataset.iconInput;
                const preview = html.querySelector(`[data-icon-preview="${target}"]`);
                if (!preview) return;
                delete preview.dataset.fallbackApplied;
                preview.src = input.value.trim() || DEFAULT_ICONS[target];
            });
        }

        addListenerAll(html, "[data-action='next']", () => {
            this.#syncFormState(html);
            this.step = Math.min(2, this.step + 1);
            this.render();
        });
        addListenerAll(html, "[data-action='back']", () => {
            this.#syncFormState(html);
            this.step = Math.max(1, this.step - 1);
            this.render();
        });

        // The trait tag-picker: a plain native `<select>` to add (its own
        // options list already excludes whatever's already a tag - see
        // `_prepareContext`'s `vesselTraitChoices`), and a click-to-remove
        // "×" on each tag already rendered - no custom element, no Ctrl/
        // Shift-click, nothing with its own render lifecycle to fight with.
        const addTraitSelect = html.querySelector('[data-action="addTrait"]');
        addTraitSelect?.addEventListener("change", (event) => {
            const value = event.currentTarget.value;
            if (!value) return;
            this.#syncFormState(html);
            if (!this.vessel.extraTraits.includes(value)) {
                this.vessel.extraTraits = [...this.vessel.extraTraits, value];
            }
            this.render();
        });

        addListenerAll(html, "[data-action='removeTrait']", (el) => {
            this.#syncFormState(html);
            this.vessel.extraTraits = this.vessel.extraTraits.filter((trait) => trait !== el.dataset.value);
            this.render();
        });
    }

    /**
     * Opens Foundry's own file browser so the icon can be picked from PF2e's
     * or Foundry's bundled icon sets, or anything uploaded to the world. The
     * picker class is looked up at click time (its location has moved
     * between Foundry versions) and its callback only stores the chosen
     * path - the path is also editable as plain text in the form, so an icon
     * can always be entered by hand if the browser is unavailable.
     *
     * @param {"apparition"|"vessel"} target Which icon is being picked.
     */
    #onPickIcon(target) {
        this.#syncFormState(this.element); // don't lose in-progress typing

        const FilePicker = getFilePickerClass();
        if (!FilePicker) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NoFilePicker`));
            return;
        }

        try {
            new FilePicker({
                type: "image",
                current: (target === "vessel" ? this.vessel.img : this.img) || DEFAULT_ICONS[target],
                callback: (path) => {
                    if (!path || !this.element) return; // nothing picked, or the editor was closed meanwhile
                    // The window may have been re-rendered while the browser was open.
                    this.#syncFormState(this.element);
                    if (target === "vessel") this.vessel.img = path;
                    else this.img = path;
                    this.render();
                },
            }).render({ force: true });
        } catch (error) {
            notifyOperationFailed(error);
        }
    }

    /**
     * Re-rendering (after a spell is dropped or removed) rebuilds the form
     * from this instance's own state - so without this, whatever the GM had
     * typed into name/flavor/lores/vessel fields in the meantime would be
     * silently discarded. Called right before every such `render()`.
     */
    #syncFormState(html) {
        if (!html) return;

        this.nameValue = html.querySelector('[name="name"]')?.value ?? this.nameValue;
        this.img = html.querySelector('[name="apparitionImg"]')?.value.trim() || this.img;
        this.flavor = html.querySelector('[name="flavor"]')?.value ?? this.flavor;
        this.loresText = html.querySelector('[name="lores"]')?.value ?? this.loresText;
        this.avatarUuid = html.querySelector('[name="avatarUuid"]')?.value ?? this.avatarUuid;
        this.vessel = {
            name: html.querySelector('[name="vesselName"]')?.value ?? this.vessel.name,
            img: html.querySelector('[name="vesselImg"]')?.value.trim() || this.vessel.img,
            rank: html.querySelector('[name="vesselRank"]')?.value ?? this.vessel.rank,
            actions: html.querySelector('[name="vesselActions"]')?.value ?? this.vessel.actions,
            range: html.querySelector('[name="vesselRange"]')?.value ?? this.vessel.range,
            target: html.querySelector('[name="vesselTarget"]')?.value ?? this.vessel.target,
            duration: html.querySelector('[name="vesselDuration"]')?.value ?? this.vessel.duration,
            description: html.querySelector('[name="vesselDescription"]')?.value ?? this.vessel.description,
            // Not read from a form field - the tag-picker's add/remove
            // handlers mutate this array directly (see
            // `_attachPartListeners`), this just carries it forward as-is.
            extraTraits: this.vessel.extraTraits,
        };
    }

    async #onDropSpell(event) {
        event.preventDefault();
        event.stopPropagation();

        let data;
        try {
            data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        } catch {
            return;
        }
        if (data?.type !== "Item" || !data.uuid) return;

        const doc = await fromUuid(data.uuid);
        if (!doc?.isOfType?.("spell")) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotASpell`));
            return;
        }
        if (this.spells.some((spell) => spell.uuid === doc.uuid)) return; // no duplicates, silently ignored

        this.#syncFormState(event.currentTarget?.closest("form") ?? this.element);
        this.spells.push(spellToRow(doc));
        this.spells.sort((a, b) => (a.isCantrip === b.isCantrip ? a.rank - b.rank : a.isCantrip ? -1 : 1));
        this.render();
    }

    async #onSave(html) {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
            return;
        }
        if (this.isSaving) return; // guards against a double click firing two parallel saves
        this.isSaving = true;

        try {
            // Only the current step's fields are actually in `html` right
            // now (see the wizard markup in editor.hbs) - captures step 3's
            // Vessel fields; step 1's name/flavor/lores were already synced
            // into instance state when "Next" was clicked to leave that
            // step, same for step 2's spells (see `_attachPartListeners`
            // and `#onDropSpell`/`removeSpell` above). Validation and the
            // save payload below read that instance state exclusively,
            // never `html`, for exactly that reason.
            this.#syncFormState(html);

            const name = (this.nameValue ?? "").trim();
            if (!name) {
                this.step = 1;
                this.render();
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NameRequired`));
                return;
            }

            const vesselName = (this.vessel.name ?? "").trim();
            if (!vesselName) {
                this.step = 2;
                this.render();
                ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.VesselNameRequired`));
                return;
            }

            const lores = (this.loresText ?? "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);

            const vessel = {
                ...this.vessel,
                name: vesselName,
                range: (this.vessel.range ?? "").trim(),
                target: (this.vessel.target ?? "").trim(),
                duration: (this.vessel.duration ?? "").trim(),
                description: (this.vessel.description ?? "").trim(),
                extraTraits: this.vessel.extraTraits ?? [],
            };
            vessel.descriptionChanged = vessel.description !== this.vesselDescriptionOriginal;

            const saved = await saveCustomApparition({
                existingItem: this.apparitionItem,
                name,
                img: this.img,
                flavor: (this.flavor ?? "").trim(),
                lores,
                spells: this.spells,
                vessel,
                sourceUuid: this.sourceUuid,
                avatarUuid: this.avatarUuid,
            });

            if (saved) {
                this.onSave?.();
                this.close();
            }
        } finally {
            this.isSaving = false;
        }
    }
}

async function openCustomApparitionCopy(item) {
    if (!game.user.isGM || !item) return;
    try {
        const seed = await extractEditorSeed(item, { copyName: true });
        seed.sourceUuid = item.uuid;
        new CustomApparitionEditorApp(null, { seed }).render({ force: true });
    } catch (error) {
        notifyOperationFailed(error);
    }
}

async function exportCustomApparition(item) {
    if (!game.user.isGM) return;
    try {
        const seed = await extractEditorSeed(item, { copyName: false });
        const vesselUuid = parseApparitionVesselUuid(item);
        const vessel = vesselUuid ? await fromUuid(vesselUuid) : null;
        const payload = {
            format: "pf2e-dailies-apparition-fix-custom-apparition",
            version: 4,
            sourceUuid: item.getFlag(MODULE_ID, "customApparitionSourceUuid") ?? null,
            name: item.name,
            img: item.img,
            flavor: seed.flavor,
            lores: seed.loresText
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            spells: seed.spells.map((spell) => ({
                uuid: spell.uuid,
                name: spell.name,
                img: spell.img,
                rank: spell.rank,
                isCantrip: spell.isCantrip,
                source: spell.source ?? null,
            })),
            vessel: {
                ...(seed.vessel ?? {}),
                avatarFormUuid: seed.avatarUuid ?? "",
                source: vessel?.toObject?.() ?? null,
            },
        };
        downloadJson(`${item.name.replace(/[^a-z0-9_-]+/gi, "_")}.json`, payload);
    } catch (error) {
        notifyOperationFailed(error);
    }
}

async function importSpellForCustomApparition(entry, folder = null) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.uuid) {
        try {
            const existing = await fromUuid(entry.uuid);
            if (existing?.isOfType?.("spell")) return existing;
        } catch (error) {
            console.warn(`${MODULE_ID} | Failed to resolve exported spell ${entry.uuid}; trying embedded source`, error);
        }
    }

    if (!entry.source || entry.source.type !== "spell") return null;

    try {
        const source = foundry.utils.deepClone(entry.source);
        delete source._id;
        delete source.folder;
        delete source.sort;
        source.flags ??= {};
        delete source.flags[MODULE_ID];
        source._stats ??= {};
        delete source._stats.compendiumSource;
        delete source._stats.duplicateSource;
        const [created] = await Item.createDocuments([
            {
                ...source,
                folder: folder?.id ?? null,
                name: entry.name || source.name || game.i18n.localize(`${MODULE_ID}.CustomApparition.ImportedName`),
                // Players bind apparitions too, and a world Item they cannot observe does not resolve for them.
                ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER },
            },
        ]);
        return created ?? null;
    } catch (error) {
        console.error(`${MODULE_ID} | Failed to import embedded spell ${entry.name ?? entry.uuid ?? "unknown"}`, error);
        return null;
    }
}

async function importCustomApparitionData(data) {
    if (!game.user.isGM) return null;
    if (!data || data.format !== "pf2e-dailies-apparition-fix-custom-apparition") {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.InvalidImport`));
        return null;
    }
    const importedSpellFolder = await getApparitionsFolder();
    const spells = [];
    for (const entry of Array.isArray(data.spells) ? data.spells : []) {
        const doc = await importSpellForCustomApparition(entry, importedSpellFolder);
        if (doc?.isOfType?.("spell")) spells.push({ ...spellToRow(doc), source: doc.toObject?.() ?? null });
    }
    const baseName = String(data.name ?? "").trim() || game.i18n.localize(`${MODULE_ID}.CustomApparition.ImportedName`);
    let name = baseName;
    if (game.items.some((item) => item.type === "feat" && item.name === name && item.getFlag(MODULE_ID, "customApparition"))) {
        let i = 2;
        while (
            game.items.some(
                (item) => item.type === "feat" && item.name === `${baseName} (${i})` && item.getFlag(MODULE_ID, "customApparition"),
            )
        )
            i++;
        name = `${baseName} (${i})`;
    }
    const vessel = {
        name: String(data.vessel?.name ?? `${name} ${game.i18n.localize(`${MODULE_ID}.CustomApparition.Vessel`)}`).trim(),
        img: data.vessel?.img || DEFAULT_VESSEL_IMG,
        rank: Number(data.vessel?.rank) || 1,
        actions: data.vessel?.actions || "1",
        range: data.vessel?.range || "",
        target: data.vessel?.target || "",
        duration: data.vessel?.duration || "",
        description: data.vessel?.description || "",
        extraTraits: Array.isArray(data.vessel?.extraTraits) ? data.vessel.extraTraits : [],
        source: data.vessel?.source ?? null,
    };
    const item = await saveCustomApparition({
        existingItem: null,
        name,
        img: data.img || DEFAULT_APPARITION_IMG,
        flavor: String(data.flavor ?? ""),
        lores: Array.isArray(data.lores) ? data.lores.map(String).filter(Boolean) : [],
        spells,
        vessel,
        sourceUuid: String(data.sourceUuid ?? "").trim() || null,
        avatarUuid:
            typeof data.vessel?.avatarFormUuid === "string"
                ? data.vessel.avatarFormUuid
                : typeof data.avatarUuid === "string"
                  ? data.avatarUuid
                  : "",
    });
    if (!item) return null;

    const newVesselUuid = parseApparitionVesselUuid(item);
    const newVessel = newVesselUuid ? await fromUuid(newVesselUuid) : null;
    const source = data.vessel?.source;
    if (newVessel?.isOwner && source?.system) {
        const system = foundry.utils.deepClone(source.system);
        await newVessel.update({
            name: vessel.name,
            img: vessel.img,
            system,
        });
        await newVessel.setFlag(MODULE_ID, "customApparitionSource", item.uuid);
        await item.update({
            "flags.pf2e-dailies-apparition-fix.origin": { type: "custom-apparition", vesselUuid: newVessel.uuid },
        });
    }
    return item;
}

async function importCustomApparitionsFromFile(file, onDone = null) {
    try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const entries = Array.isArray(parsed.apparitions) ? parsed.apparitions : [parsed];
        let imported = 0;
        for (const entry of entries) {
            if (await importCustomApparitionData(entry)) imported++;
        }
        ui.notifications.info(formatLocalized(`${MODULE_ID}.CustomApparition.Notify.Imported`, { count: imported }));
        onDone?.();
    } catch (error) {
        notifyOperationFailed(error);
    }
}

class CustomApparitionsApp extends apps.HandlebarsApplicationMixin(apps.ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: "apparition-fix-custom-apparitions",
        classes: ["apparition-fix", "apparition-fix-list"],
        window: { icon: "fa-solid fa-ghost", resizable: true },
        position: { width: 480, height: 480 },
    };

    static PARTS = {
        list: {
            template: `modules/${MODULE_ID}/templates/custom-apparitions/list.hbs`,
            scrollable: ["ol"],
        },
    };

    get title() {
        return game.i18n.localize(`${MODULE_ID}.CustomApparition.ListTitle`);
    }

    _prepareContext(_options) {
        const items = game.items.filter((item) => item.type === "feat" && item.getFlag(MODULE_ID, "customApparition"));

        return {
            apparitions: items
                .map((item) => ({ id: item.id, name: item.name, img: item.img }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    _attachPartListeners(partId, html, _options) {
        if (partId !== "list") return;

        addListenerAll(html, "[data-action='create']", () => {
            if (!game.user.isGM) return;
            new CustomApparitionEditorApp(null, { onSave: () => this.render() }).render({ force: true });
        });

        addListenerAll(html, "[data-action='import']", () => {
            if (!game.user.isGM) return;
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "application/json,.json";
            input.addEventListener(
                "change",
                () => {
                    const file = input.files?.[0];
                    if (file) void importCustomApparitionsFromFile(file, () => this.render());
                },
                { once: true },
            );
            input.click();
        });

        addListenerAll(html, "[data-action='export-all']", async () => {
            if (!game.user.isGM) return;
            const items = game.items.filter((item) => item.type === "feat" && item.getFlag(MODULE_ID, "customApparition"));
            const data = [];
            for (const item of items) {
                const seed = await extractEditorSeed(item, { copyName: false });
                const vesselUuid = parseApparitionVesselUuid(item);
                const vessel = vesselUuid ? await fromUuid(vesselUuid) : null;
                data.push({
                    format: "pf2e-dailies-apparition-fix-custom-apparition",
                    version: 4,
                    sourceUuid: item.getFlag(MODULE_ID, "customApparitionSourceUuid") ?? null,
                    name: item.name,
                    img: item.img,
                    flavor: seed.flavor,
                    lores: seed.loresText
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean),
                    spells: seed.spells.map((spell) => ({
                        uuid: spell.uuid,
                        name: spell.name,
                        img: spell.img,
                        rank: spell.rank,
                        isCantrip: spell.isCantrip,
                        source: spell.source ?? null,
                    })),
                    vessel: { ...seed.vessel, avatarFormUuid: seed.avatarUuid ?? "", source: vessel?.toObject?.() ?? null },
                });
            }
            downloadJson("pf2e-dailies-apparition-fix-custom-apparitions.json", {
                format: "pf2e-dailies-apparition-fix-custom-apparitions",
                version: 4,
                apparitions: data,
            });
        });

        addListenerAll(html, "[data-action='edit']", (el) => {
            if (!game.user.isGM) return;
            const item = game.items.get(el.dataset.id);
            if (!item) return;
            new CustomApparitionEditorApp(item, { onSave: () => this.render() }).render({ force: true });
        });

        addListenerAll(html, "[data-action='copy']", async (el) => {
            if (!game.user.isGM) return;
            const item = game.items.get(el.dataset.id);
            if (item) await openCustomApparitionCopy(item);
        });

        addListenerAll(html, "[data-action='export']", async (el) => {
            if (!game.user.isGM) return;
            const item = game.items.get(el.dataset.id);
            if (item) await exportCustomApparition(item);
        });

        addListenerAll(html, "[data-action='delete']", async (el) => {
            if (!game.user.isGM) return;
            const item = game.items.get(el.dataset.id);
            if (!item) return;

            const confirmed = await apps.DialogV2.confirm({
                window: { title: game.i18n.localize(`${MODULE_ID}.CustomApparition.DeleteTitle`) },
                content: `<p>${formatLocalized(`${MODULE_ID}.CustomApparition.DeleteConfirm`, { name: foundry.utils.escapeHTML(item.name) })}</p>`,
                rejectClose: false,
            });
            if (!confirmed) return;

            await deleteCustomApparition(item);
            this.render();
        });
    }
}

/* -------------------------------------------- */
/*  Wiring                                      */
/* -------------------------------------------- */

Hooks.once("init", () => {
    game.settings.registerMenu(MODULE_ID, "customApparitions", {
        name: `${MODULE_ID}.Settings.CustomApparitions.Name`,
        label: `${MODULE_ID}.Settings.CustomApparitions.Label`,
        hint: `${MODULE_ID}.Settings.CustomApparitions.Hint`,
        icon: "fa-solid fa-ghost",
        type: CustomApparitionsApp,
        restricted: true,
    });
});

Hooks.once("ready", () => {
    if (!isEnabled() || game.system.id !== "pf2e") return;

    const openCustomApparitions = () => {
        if (!game.user.isGM) {
            ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.CustomApparition.Notify.NotGM`));
            return;
        }
        const open = foundry.applications.instances.get(CustomApparitionsApp.DEFAULT_OPTIONS.id) ?? new CustomApparitionsApp();
        open.render({ force: true });
    };

    const module = game.modules.get(MODULE_ID);
    if (module) {
        module.api = { ...module.api, openCustomApparitions, openCustomApparitionCopy, exportCustomApparition, importCustomApparitionData };
    }
});

export { openCustomApparitionCopy, exportCustomApparition, importCustomApparitionData };
