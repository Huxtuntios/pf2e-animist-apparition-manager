// Browser-only unit/regression tests. Foundry documents, permissions and dialogs are mocked.
// Serve the repository root over HTTP, then open tests/audit.html. No world data is used.
const ID = "pf2e-dailies-apparition-fix";
const results = [];
let errors = [];
console.error = (...args) => errors.push(args.map((x) => String(x?.stack ?? x)).join(" "));
const assert = (ok, message = "Assertion failed") => {
    if (!ok) throw Error(message);
};
const equal = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const callbacks = new Map();
const on = (name, fn) => {
    if (!callbacks.has(name)) callbacks.set(name, []);
    callbacks.get(name).push(fn);
    return fn;
};
globalThis.Hooks = {
    on,
    once: on,
    off() {},
    callAll(name, ...args) {
        for (const fn of callbacks.get(name) ?? []) fn(...args);
    },
};
const getProperty = (o, path) => path.split(".").reduce((v, k) => v?.[k], o);
const setProperty = (o, path, value) => {
    const parts = path.split(".");
    const key = parts.pop();
    for (const p of parts) o = o[p] ??= {};
    o[key] = value;
    return true;
};
function merge(target, source) {
    for (const [k, v] of Object.entries(source)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
            if (!target[k] || typeof target[k] !== "object") target[k] = {};
            merge(target[k], v);
        } else target[k] = structuredClone(v);
    }
    return target;
}
class Collection extends Array {
    get(id) {
        return this.find((x) => x.id === id);
    }
    has(id) {
        return !!this.get(id);
    }
}
const documents = new Map();
let nextId = 0,
    notices = [],
    dialogs = [],
    savedFile;
function doc(source, parent = null) {
    const data = structuredClone(source);
    data._id ??= `id${++nextId}`;
    data.flags ??= {};
    data.system ??= {};
    return {
        ...data,
        id: data._id,
        parent,
        isEmbedded: !!parent,
        isOwner: true,
        _source: data,
        uuid: parent ? `Actor.${parent.id}.Item.${data._id}` : `Item.${data._id}`,
        get sourceId() {
            return this._stats?.compendiumSource;
        },
        get traits() {
            return new Set(this.system.traits?.value ?? []);
        },
        get slug() {
            return this.system.slug;
        },
        get isCantrip() {
            return this.type === "spell" && this.system.traits?.value?.includes("cantrip") === true;
        },
        get description() {
            return this.system.description?.value ?? "";
        },
        isOfType(...types) {
            return types.includes(this.type);
        },
        getFlag(ns, path) {
            return getProperty(this.flags[ns], path);
        },
        async setFlag(ns, path, value) {
            return this.update({ [`flags.${ns}.${path}`]: value });
        },
        async unsetFlag(ns, path) {
            const parts = path.split(".");
            const key = parts.pop();
            const target = parts.length ? getProperty(this.flags[ns], parts.join(".")) : this.flags[ns];
            if (target) delete target[key];
        },
        async update(changes) {
            for (const [k, v] of Object.entries(changes)) {
                if (k.includes(".")) {
                    setProperty(this, k, structuredClone(v));
                    setProperty(data, k, structuredClone(v));
                } else {
                    if (v && typeof v === "object" && !Array.isArray(v)) {
                        merge((this[k] ??= {}), v);
                        merge((data[k] ??= {}), v);
                    } else {
                        this[k] = structuredClone(v);
                        data[k] = structuredClone(v);
                    }
                }
            }
            return this;
        },
        toObject() {
            return structuredClone(data);
        },
        async delete() {
            documents.delete(this.uuid);
            const items = parent?.items ?? game.items;
            const i = items.indexOf(this);
            if (i >= 0) items.splice(i, 1);
        },
    };
}
function actor() {
    const a = doc({ type: "character", name: "Test", system: { resources: { focus: { max: 1 } } } });
    a.level = 5;
    a.items = new Collection();
    Object.defineProperty(a, "itemTypes", {
        get() {
            return Object.fromEntries(["feat", "spell", "lore", "spellcastingEntry"].map((t) => [t, a.items.filter((i) => i.type === t)]));
        },
    });
    Object.defineProperty(a, "spellcasting", {
        get() {
            return a.itemTypes.spellcastingEntry;
        },
    });
    a.createEmbeddedDocuments = async (type, sources) => {
        const created = sources.map((s) => doc(s, a));
        a.items.push(...created);
        for (const item of created)
            if (item.type === "spellcastingEntry")
                Object.defineProperty(item, "spells", {
                    get: () => new Map(a.itemTypes.spell.filter((s) => s.system.location?.value === item.id).map((s) => [s.id, s])),
                });
        return created;
    };
    a.updateEmbeddedDocuments = async (type, updates) => Promise.all(updates.map((u) => a.items.get(u._id).update(u)));
    a.deleteEmbeddedDocuments = async (type, ids) => {
        for (const id of ids) await a.items.get(id)?.delete();
        return [];
    };
    return a;
}
class App {
    constructor(options = {}) {
        this.options = options;
        this.state = 0;
    }
    render() {
        if (App.renderer) return App.renderer(this);
        return this;
    }
    async close() {}
}
const settings = new Map([
    ["enabled", true],
    ["apparitionIdentifier", "animist-spontaneous"],
    ["vesselIdentifier", "animist-focus"],
    ["autoPrimary", false],
    ["wanderingFeatRules", {}],
]);
globalThis.game = {
    system: { id: "pf2e", version: "8.6.1" },
    user: { id: "gm", isGM: true },
    settings: {
        get: (ns, k) => settings.get(k),
        set: async (ns, k, v) => {
            settings.set(k, v);
            return v;
        },
        register() {},
        registerMenu() {},
    },
    i18n: { has: () => false, lang: "en", localize: (k) => k, format: (k, d) => k + JSON.stringify(d) },
    modules: new Map([[ID, { active: true }]]),
    items: new Collection(),
    actors: new Collection(),
    folders: new Collection(),
    packs: new Map(),
    pf2e: { system: { sluggify: (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "") } },
};
globalThis.ui = { notifications: { warn: (x) => notices.push(x), error: (x) => notices.push(x), info: (x) => notices.push(x) } };
globalThis.CONFIG = {
    PF2E: {
        featTraits: { animist: "animist", wandering: "wandering", fire: "fire" },
        spellTraits: { focus: "focus", animist: "animist", fire: "fire" },
    },
};
globalThis.CONST = { DOCUMENT_OWNERSHIP_LEVELS: { OBSERVER: 2, OWNER: 3 } };
globalThis.foundry = {
    utils: {
        getProperty,
        setProperty,
        isNewerVersion: (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0,
        deepClone: (value) => structuredClone(value),
        mergeObject: (a, b, { inplace = true } = {}) => merge(inplace ? a : structuredClone(a), b),
        randomID: () => `id${++nextId}`,
        escapeHTML: (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"),
        saveDataToFile: (text) => {
            savedFile = JSON.parse(text);
        },
    },
    applications: {
        api: {
            ApplicationV2: App,
            HandlebarsApplicationMixin: (Base) => Base,
            DialogV2: { wait: async () => dialogs.shift() ?? null, confirm: async () => true },
        },
        instances: new Map(),
        handlebars: { getTemplate: async () => () => "" },
    },
};
globalThis.fromUuid = async (uuid) => {
    if (String(uuid).startsWith("Broken.")) throw Error("Missing document");
    return documents.get(uuid) ?? game.items.find((i) => i.uuid === uuid) ?? null;
};
globalThis.Item = {
    createDocuments: async (sources) => {
        const docs = sources.map((s) => doc(s));
        game.items.push(...docs);
        for (const d of docs) documents.set(d.uuid, d);
        return docs;
    },
    create: async (source) => (await Item.createDocuments([source]))[0],
};
globalThis.Folder = {
    create: async (source) => {
        const f = doc(source);
        game.folders.push(f);
        return f;
    },
};
globalThis.ChatMessage = { create: async () => null, getSpeaker: () => ({}) };
Math.clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const core = await import("../scripts/apparition-fix.mjs");
const wandering = await import("../scripts/wandering-feats.mjs");
const custom = await import("../scripts/custom-apparitions.mjs");
await import("../scripts/wandering-settings.mjs");
const manager = await import("../scripts/manage-apparitions.mjs");
function add(a, s) {
    const item = doc(s, a);
    a.items.push(item);
    return item;
}
function feat(a, key, vessel = "Item.vessel") {
    return add(a, {
        type: "feat",
        name: key,
        _stats: { compendiumSource: key },
        system: {
            traits: { value: ["animist"], otherTags: ["animist-apparition"] },
            rules: [],
            description: { value: `<hr><p><strong>Skills</strong> Forest Lore, Ocean Lore</p><ul></ul><p>@UUID[${vessel}]{Vessel}</p>` },
        },
        flags: { [ID]: { temporary: true } },
    });
}
function vessel(a, uuid = "Item.vessel") {
    return add(a, { type: "spell", name: "Vessel", _stats: { compendiumSource: uuid }, flags: { [ID]: { identifier: "animist-focus" } } });
}
function attunement(a) {
    return add(a, { type: "feat", name: "Attunement", system: { slug: "apparition-attunement", rules: [] } });
}
async function test(name, fn) {
    notices = [];
    errors = [];
    settings.set("enabled", true);
    game.user.isGM = true;
    try {
        await fn();
        assert(errors.length === 0, errors.join("\n"));
        results.push({ name, pass: true });
    } catch (e) {
        results.push({ name, pass: false, error: String(e.stack ?? e), errors, notices });
    } finally {
        game.actors = new Collection();
        game.packs.clear();
        game.modules.delete("pf2e-dailies");
    }
}
await test("all five runtime modules import without errors", () =>
    assert(core.addApparition && wandering.getWanderingContext && custom.importCustomApparitionData && manager.loadAvailableApparitions));
await test("diagnostics requests leaf fields without parent/child projection collisions", async () => {
    let requested;
    game.packs.set("pf2e.classfeatures", {
        getIndex: async ({ fields }) => {
            requested = fields;
            const merged = ["system.traits.value", ...fields];
            assert(!merged.some((x, i) => merged.some((y, j) => i !== j && y.startsWith(x + "."))), "projection collision");
            return [{ type: "feat", name: "Test", uuid: "Item.apparition", system: { traits: { otherTags: ["animist-apparition"] } } }];
        },
    });
    const report = await core.diagnose(actor());
    equal(report.apparitionCount, 1);
    assert(!report.packReports[0].error);
    equal(requested, ["system.traits.otherTags"]);
});
await test("diagnostics reports missing traits without crashing", async () => {
    game.packs.set("pf2e.classfeatures", { getIndex: async () => [{ type: "feat", name: "Bad", uuid: "Item.bad" }] });
    const r = await core.diagnose(actor());
    equal(r.entriesWithoutTraits.length, 1);
});
await test("description parser: Lore labels and Vessel", () => {
    const a = actor(),
        f = feat(a, "Item.a");
    equal(core.parseApparitionLores(f), ["Forest Lore", "Ocean Lore"]);
    equal(core.parseApparitionVesselUuid(f), "Item.vessel");
    equal(core.parseApparitionSpellUuids(f), []);
});
await test("description parser: empty or malformed description is safe", () => {
    equal(core.parseApparitionSpellUuids({}), []);
    equal(core.parseApparitionVesselUuid({}), null);
    equal(core.parseApparitionLores({}), []);
});
await test("migration does not adopt unrelated Dailies temporary grants", async () => {
    const a = actor(),
        item = add(a, { type: "feat", flags: { "pf2e-dailies": { temporary: true } }, system: { rules: [] } });
    game.actors.push(a);
    await core.migrateLegacyDailiesState();
    assert(!item.getFlag(ID, "temporary"));
});
await test("migration still adopts legacy Apparition Spellcasting", async () => {
    const a = actor(),
        item = add(a, { type: "spellcastingEntry", flags: { "pf2e-dailies": { identifier: "animist-spontaneous", temporary: true } } });
    game.actors.push(a);
    await core.migrateLegacyDailiesState();
    equal(item.getFlag(ID, "identifier"), "animist-spontaneous");
    equal(item.getFlag(ID, "temporary"), true);
});
await test("migration still adopts temporary bonded apparition feats", async () => {
    const a = actor(),
        f = feat(a, "Item.a");
    delete f.flags[ID].temporary;
    f.flags["pf2e-dailies"] = { temporary: true };
    game.actors.push(a);
    await core.migrateLegacyDailiesState();
    equal(f.getFlag(ID, "temporary"), true);
});
await test("migration is idempotent after migrated flag", async () => {
    const a = actor();
    game.actors.push(a);
    await core.migrateLegacyDailiesState();
    const before = JSON.stringify(a.flags);
    await core.migrateLegacyDailiesState();
    equal(JSON.stringify(a.flags), before);
});
function vesselSheet(a, spells) {
    const entry = add(a, { type: "spellcastingEntry", flags: { [ID]: { identifier: "animist-focus" } } });
    entry.spells = new Map(spells.map((s) => [s.id, s]));
    const root = document.getElementById("fixture");
    root.innerHTML = `<div data-container-id="${entry.id}"><div class="action-header"><div class="item-controls"></div></div>${spells.map((s) => `<li data-item-id="${s.id}" data-entry-id="${entry.id}"><h4 class="name">Vessel</h4><button class="cast-spell" data-action="cast-spell">Cast</button><div class="item-controls"></div></li>`).join("")}</div>`;
    const render = () => coreRender({ actor: a }, root);
    return { root, render, button: (s) => root.querySelector(`[data-item-id="${s.id}"] button`) };
}
const coreRender = callbacks.get("renderCharacterSheetPF2e")[0];
await test("Vessel disabled when explicit primary set is empty, even with only one apparition", async () => {
    const a = actor();
    feat(a, "Item.a");
    const v = vessel(a);
    await a.setFlag(ID, "primaryApparitions", []);
    const sheet = vesselSheet(a, [v]);
    sheet.render();
    assert(sheet.button(v).disabled);
});
await test("changing primary on reused DOM restores the previously disabled button", async () => {
    const a = actor();
    feat(a, "Item.a");
    const v = vessel(a);
    const sheet = vesselSheet(a, [v]);
    sheet.render();
    assert(sheet.button(v).disabled);
    await a.setFlag(ID, "primaryApparitions", ["Item.a"]);
    sheet.render();
    assert(!sheet.button(v).disabled);
    assert(!sheet.root.querySelector(".apparition-fix-inactive-name"));
});
await test("Vessel redecoration preserves a preexisting disabled state", async () => {
    const a = actor();
    feat(a, "Item.a");
    const v = vessel(a);
    const sheet = vesselSheet(a, [v]);
    sheet.button(v).disabled = true;
    sheet.render();
    await a.setFlag(ID, "primaryApparitions", ["Item.a"]);
    sheet.render();
    assert(sheet.button(v).disabled);
});
await test("a shared Vessel is usable when at least one granting apparition is primary", async () => {
    const a = actor();
    feat(a, "Item.a");
    feat(a, "Item.b");
    const v = vessel(a);
    await a.setFlag(ID, "primaryApparitions", ["Item.a"]);
    const sheet = vesselSheet(a, [v]);
    sheet.render();
    assert(!sheet.button(v).disabled);
});
await test("inactive Vessel stays disabled across repeated renders without duplicate swap controls", async () => {
    const a = actor();
    feat(a, "Item.a");
    const v = vessel(a);
    const sheet = vesselSheet(a, [v]);
    sheet.render();
    sheet.render();
    equal(sheet.root.querySelectorAll('[data-apparition-fix="swap-primary"]').length, 1);
    assert(sheet.button(v).disabled);
});
await test("focus subtraction counts unique inactive spells, not apparition keys", async () => {
    const a = actor(),
        parent = attunement(a);
    feat(a, "Item.a");
    feat(a, "Item.b");
    vessel(a);
    await core.setPrimaryVessel(a, "Item.a", false);
    const rules = parent.system.rules.filter((r) => r[ID] === "focus-pool");
    equal(rules.length, 1);
    equal(rules[0].value, 1);
});
await test("shared active Vessel is not subtracted from focus", async () => {
    const a = actor(),
        parent = attunement(a);
    feat(a, "Item.a");
    feat(a, "Item.b");
    vessel(a);
    await core.setPrimaryVessel(a, "Item.a", true);
    equal(parent.system.rules.filter((r) => r[ID] === "focus-pool").length, 0);
});
await test("primary changes keep within the limit and swap the current primary", async () => {
    const a = actor();
    feat(a, "Item.a", "Item.v1");
    feat(a, "Item.b", "Item.v2");
    vessel(a, "Item.v1");
    vessel(a, "Item.v2");
    await core.setPrimaryVessel(a, "Item.a");
    await core.setPrimaryVessel(a, "Item.b");
    equal(core.getPrimaryVesselState(a).primary, ["Item.b"]);
});
await test("actor ownership is required for primary changes", async () => {
    const a = actor();
    a.isOwner = false;
    game.user.isGM = false;
    feat(a, "Item.a");
    vessel(a);
    equal(await core.setPrimaryVessel(a, "Item.a"), false);
    assert(!a.getFlag(ID, "primaryApparitions"));
});
await test("profiles sanitize malformed entries and duplicate keys", async () => {
    const a = actor();
    await a.setFlag(ID, "apparitionProfiles", [
        null,
        { id: 1, name: "Bad" },
        { id: "x", name: " Good ", apparitions: ["Item.a", "Item.a", null], primary: ["Item.a", "Item.a"] },
    ]);
    const p = core.getApparitionProfiles(a);
    equal(p.length, 1);
    equal(p[0].name, "Good");
    equal(p[0].apparitions, ["Item.a"]);
});
await test("saving a profile twice by name updates rather than duplicates", async () => {
    const a = actor();
    feat(a, "Item.a");
    await core.saveApparitionProfile(a, "Daily");
    await core.saveApparitionProfile(a, "daily");
    equal(core.getApparitionProfiles(a).length, 1);
});
await test("deleting last profile removes flag", async () => {
    const a = actor();
    const p = await core.saveApparitionProfile(a, "Daily");
    assert(await core.deleteApparitionProfile(a, p.id));
    equal(core.getApparitionProfiles(a), []);
});
await test("restore yesterday skips UUID resolution failures", async () => {
    const a = actor();
    await a.setFlag(ID, "lastDayApparitions", { apparitions: ["Broken.deleted"], primary: [] });
    const r = await core.restoreLastDayApparitions(a);
    equal(r.missing, 1);
    equal(r.restored, 0);
});
await test("apply profile skips UUID resolution failures", async () => {
    const a = actor();
    await a.setFlag(ID, "apparitionProfiles", [{ id: "x", name: "Broken", apparitions: ["Broken.deleted"], primary: [] }]);
    const r = await core.applyApparitionProfile(a, "x");
    equal(r.missing, 1);
});
await test("repair skips unresolved UUID and reports it", async () => {
    const a = actor();
    await a.setFlag(ID, "bondedApparitions", ["Broken.deleted"]);
    const r = await core.repairApparitionActor(a);
    equal(r.missing, 1);
    assert(!r.error);
});
await test("Wandering Feat save preserves unchanged rich description", async () => {
    const item = doc({
        type: "feat",
        system: { traits: { value: ["animist", "wandering"] }, description: { value: "<p><b>Rich</b> @UUID[Item.a]{Link}</p>" } },
    });
    await wandering.saveCustomWanderingFeat({
        item,
        name: "Rename",
        level: 6,
        description: "Rich Link",
        descriptionChanged: false,
        apparitions: [],
    });
    equal(item.system.description.value, "<p><b>Rich</b> @UUID[Item.a]{Link}</p>");
});
await test("Wandering Feat edited description is HTML escaped", async () => {
    const item = await wandering.saveCustomWanderingFeat({ name: "Feat", level: 6, description: "<script>bad</script>", apparitions: [] });
    equal(item.system.description.value, "<p>&lt;script&gt;bad&lt;/script&gt;</p>");
});
await test("Wandering Feat world save is GM-only", async () => {
    game.user.isGM = false;
    equal(await wandering.saveCustomWanderingFeat({ name: "No", level: 6, apparitions: [] }), null);
});
await test("Wandering Feat level is an integer within 1–20", async () => {
    const item = await wandering.saveCustomWanderingFeat({ name: "Feat", level: 6.9, apparitions: [] });
    equal(item.system.level.value, 6);
});
await test("import custom apparition preserves full Vessel damage but normalizes mandatory traits", async () => {
    const item = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Custom",
        lores: ["Forest"],
        spells: [],
        vessel: {
            name: "Custom Vessel",
            rank: 2,
            source: { type: "spell", system: { level: { value: 1 }, traits: { value: ["fire"] }, damage: { main: { formula: "2d6" } } } },
        },
    });
    assert(item);
    const uuid = core.parseApparitionVesselUuid(item);
    const v = await fromUuid(uuid);
    equal(v.system.level.value, 2);
    assert(v.system.traits.value.includes("focus") && v.system.traits.value.includes("animist"));
    equal(v.system.damage.main.formula, "2d6");
    equal(core.parseApparitionLores(item), ["Forest Lore"]);
});
await test("custom import preserves an existing Vessel UUID without creating a duplicate Spell", async () => {
    const vessel = doc({
        type: "spell",
        name: "Original Focus",
        system: { level: { value: 2 }, traits: { value: ["focus", "animist"] }, rules: [], damage: { main: { formula: "2d6" } } },
    });
    documents.set(vessel.uuid, vessel);
    game.items.push(vessel);
    const before = game.items.length;
    const spellsBefore = game.items.filter((entry) => entry.type === "spell").length;
    const item = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Referenced",
        lores: [],
        spells: [],
        vessel: { uuid: vessel.uuid, name: vessel.name, source: vessel.toObject() },
    });
    assert(item);
    equal(core.parseApparitionVesselUuid(item), vessel.uuid);
    equal(game.items.length, before + 1);
    equal(game.items.filter((entry) => entry.type === "spell").length, spellsBefore);
});
await test("custom import keeps an unresolved Vessel reference instead of creating a fallback", async () => {
    const before = game.items.length;
    const item = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Unresolved",
        lores: [],
        spells: [],
        vessel: {
            uuid: "Broken.vessel",
            name: "Missing Vessel",
            source: { type: "spell", system: { level: { value: 1 }, traits: { value: ["focus"] } } },
        },
    });
    assert(item);
    equal(core.parseApparitionVesselUuid(item), "Broken.vessel");
    equal(game.items.length, before + 1);
});
await test("custom export stores the Vessel UUID and roundtrip reuses the original Spell", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Original",
        lores: [],
        spells: [],
        vessel: { name: "Owned Vessel", rank: 2, source: { type: "spell", system: { damage: { main: { formula: "2d6" } } } } },
    });
    const vesselUuid = core.parseApparitionVesselUuid(original);
    await custom.exportCustomApparition(original);
    equal(savedFile.vessel.uuid, vesselUuid);
    equal(savedFile.version, 5);
    const copy = await custom.importCustomApparitionData(savedFile);
    assert(copy && copy.id !== original.id);
    equal(core.parseApparitionVesselUuid(copy), vesselUuid);
});
await test("copy seed retains the original Vessel UUID as a read-only reference", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Original",
        lores: [],
        spells: [],
        vessel: { name: "Owned Vessel", source: { type: "spell", system: {} } },
    });
    const vesselUuid = core.parseApparitionVesselUuid(original);
    const seed = await custom.extractEditorSeed(original);
    equal(seed.vessel.uuid, vesselUuid);
    equal(seed.vessel.isReference, true);
});
await test("editing a copied apparition does not modify the shared Vessel Spell", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Original",
        lores: [],
        spells: [],
        vessel: { name: "Shared Vessel", rank: 2, source: { type: "spell", system: {} } },
    });
    const vessel = await fromUuid(core.parseApparitionVesselUuid(original));
    const copy = doc({
        type: "feat",
        name: "Copy",
        flags: { [ID]: { customApparition: true } },
        system: { description: { value: `<ul></ul><p>@UUID[${vessel.uuid}]{${vessel.name}}</p>` } },
    });
    game.items.push(copy);
    documents.set(copy.uuid, copy);
    await custom.saveCustomApparition({
        existingItem: copy,
        name: "Copy Edited",
        img: copy.img,
        flavor: "",
        lores: [],
        spells: [],
        vessel: {
            uuid: vessel.uuid,
            isReference: true,
            name: "Changed Name",
            rank: 9,
            actions: "1",
            range: "",
            target: "",
            duration: "",
            description: "",
            extraTraits: [],
        },
    });
    equal(vessel.name, "Shared Vessel");
    equal(vessel.system.level.value, 2);
});
await test("deleting a copied apparition never deletes the shared Vessel Spell", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Original",
        lores: [],
        spells: [],
        vessel: { name: "Shared Vessel", source: { type: "spell", system: {} } },
    });
    const vessel = await fromUuid(core.parseApparitionVesselUuid(original));
    const copy = doc({
        type: "feat",
        name: "Copy",
        flags: { [ID]: { customApparition: true } },
        system: { description: { value: `<ul></ul><p>@UUID[${vessel.uuid}]{${vessel.name}}</p>` } },
    });
    game.items.push(copy);
    documents.set(copy.uuid, copy);
    await custom.deleteCustomApparition(copy);
    assert(game.items.includes(vessel));
});
await test("deleting the original apparition keeps a Vessel still referenced by a copy", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Original",
        lores: [],
        spells: [],
        vessel: { name: "Shared Vessel", source: { type: "spell", system: {} } },
    });
    const vessel = await fromUuid(core.parseApparitionVesselUuid(original));
    const copy = doc({
        type: "feat",
        name: "Copy",
        flags: { [ID]: { customApparition: true } },
        system: { description: { value: `<ul></ul><p>@UUID[${vessel.uuid}]{${vessel.name}}</p>` } },
    });
    game.items.push(copy);
    documents.set(copy.uuid, copy);
    await custom.deleteCustomApparition(original);
    assert(game.items.includes(vessel));
    await custom.deleteCustomApparition(copy);
    assert(!game.items.includes(vessel));
});
await test("saving an authored Vessel deleted after editor load preserves its UUID", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Deleted Owned Vessel",
        lores: [],
        spells: [],
        vessel: { name: "Owned Vessel", source: { type: "spell", system: {} } },
    });
    const vesselUuid = core.parseApparitionVesselUuid(original);
    const vessel = await fromUuid(vesselUuid);
    await vessel.delete();
    const spellsBefore = game.items.filter((item) => item.type === "spell").length;
    const saved = await custom.saveCustomApparition({
        existingItem: original,
        name: original.name,
        img: original.img,
        flavor: "",
        lores: [],
        spells: [],
        vessel: {
            uuid: vesselUuid,
            isReference: false,
            name: vessel.name,
            rank: 1,
            actions: "1",
            range: "",
            target: "",
            duration: "",
            description: "",
            extraTraits: [],
        },
    });
    assert(saved);
    equal(core.parseApparitionVesselUuid(saved), vesselUuid);
    equal(game.items.filter((item) => item.type === "spell").length, spellsBefore);
});
await test("switching an owned Vessel removes the old unreferenced Spell", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Switch Vessel",
        lores: [],
        spells: [],
        vessel: { name: "Old Owned Vessel", source: { type: "spell", system: {} } },
    });
    const oldVessel = await fromUuid(core.parseApparitionVesselUuid(original));
    const replacement = doc({
        type: "spell",
        name: "Replacement Focus",
        system: { level: { value: 1 }, traits: { value: ["focus"] } },
    });
    game.items.push(replacement);
    documents.set(replacement.uuid, replacement);
    await custom.saveCustomApparition({
        existingItem: original,
        name: original.name,
        img: original.img,
        flavor: "",
        lores: [],
        spells: [],
        vessel: {
            uuid: replacement.uuid,
            isReference: true,
            name: replacement.name,
            rank: 1,
            actions: "1",
            range: "",
            target: "",
            duration: "",
            description: "",
            extraTraits: [],
        },
    });
    equal(core.parseApparitionVesselUuid(original), replacement.uuid);
    assert(!game.items.includes(oldVessel));
    assert(game.items.includes(replacement));
});
await test("concurrent copy save completes before shared Vessel cleanup", async () => {
    const original = await custom.importCustomApparitionData({
        format: "pf2e-dailies-apparition-fix-custom-apparition",
        name: "Concurrent Original",
        lores: [],
        spells: [],
        vessel: { name: "Concurrent Vessel", source: { type: "spell", system: {} } },
    });
    const vessel = await fromUuid(core.parseApparitionVesselUuid(original));
    const save = custom.saveCustomApparition({
        existingItem: null,
        name: "Concurrent Copy",
        img: original.img,
        flavor: "",
        lores: [],
        spells: [],
        vessel: {
            uuid: vessel.uuid,
            isReference: true,
            name: vessel.name,
            rank: 1,
            actions: "1",
            range: "",
            target: "",
            duration: "",
            description: "",
            extraTraits: [],
        },
    });
    const remove = custom.deleteCustomApparition(original);
    const [copy] = await Promise.all([save, remove]);
    assert(copy);
    equal(core.parseApparitionVesselUuid(copy), vessel.uuid);
    assert(game.items.includes(vessel));
});
await test("focus spell choices include world actor and compendium sources and filter by text", async () => {
    const worldFocus = doc({ type: "spell", name: "World Focus", system: { level: { value: 1 }, traits: { value: ["focus"] } } });
    const worldOther = doc({ type: "spell", name: "World Other", system: { level: { value: 1 }, traits: { value: [] } } });
    const worldFocusCantrip = doc({
        type: "spell",
        name: "World Focus Cantrip",
        system: { level: { value: 0 }, traits: { value: ["cantrip"], traditions: [] } },
    });
    game.items.push(worldFocus, worldOther, worldFocusCantrip);
    const actorDoc = actor();
    const actorFocus = add(actorDoc, { type: "spell", name: "Actor Focus", system: { level: { value: 1 }, traits: { value: ["focus"] } } });
    game.actors.push(actorDoc);
    let indexedFields;
    game.packs.set("pf2e.spells-srd", {
        metadata: { type: "Item", system: "pf2e", packageName: "pf2e", label: "Spells" },
        getIndex: async ({ fields }) => {
            indexedFields = fields;
            return [
                {
                    _id: "comp",
                    uuid: "Compendium.pf2e.spells-srd.Item.comp",
                    name: "Compendium Focus",
                    type: "spell",
                    img: "",
                    system: { level: { value: 2 }, traits: { value: ["focus"] } },
                },
            ];
        },
    });
    const choices = await custom.loadFocusSpellChoices();
    assert(choices.some((choice) => choice.uuid === worldFocus.uuid));
    assert(choices.some((choice) => choice.uuid === worldFocusCantrip.uuid));
    assert(choices.some((choice) => choice.uuid === actorFocus.uuid && choice.source === actorDoc.name));
    assert(choices.some((choice) => choice.uuid === "Compendium.pf2e.spells-srd.Item.comp" && choice.source === "Spells"));
    assert(!choices.some((choice) => choice.uuid === worldOther.uuid));
    assert(indexedFields.includes("system.traits.traditions"));
    equal(
        custom.filterFocusSpellChoices(choices, "compendium focus").map((choice) => choice.uuid),
        ["Compendium.pf2e.spells-srd.Item.comp"],
    );
});
await test("editing an apparition with an unresolved Vessel reference preserves the UUID", async () => {
    const item = doc({
        type: "feat",
        name: "Broken Reference",
        flags: { [ID]: { customApparition: true } },
        system: { description: { value: "<ul></ul><p>@UUID[Broken.vessel]{Missing Vessel}</p>" } },
    });
    game.items.push(item);
    documents.set(item.uuid, item);
    const saved = await custom.saveCustomApparition({
        existingItem: item,
        name: "Broken Reference Edited",
        img: item.img,
        flavor: "",
        lores: [],
        spells: [],
        vessel: {
            uuid: "Broken.vessel",
            isReference: true,
            name: "Missing Vessel",
            rank: 1,
            actions: "1",
            range: "",
            target: "",
            duration: "",
            description: "",
            extraTraits: [],
        },
    });
    assert(saved);
    equal(core.parseApparitionVesselUuid(saved), "Broken.vessel");
});
await test("exporting an apparition with an unresolved Vessel reference keeps its UUID", async () => {
    const item = doc({
        type: "feat",
        name: "Broken Export",
        flags: { [ID]: { customApparition: true } },
        system: { description: { value: "<ul></ul><p>@UUID[Broken.vessel]{Missing Vessel}</p>" } },
    });
    game.items.push(item);
    documents.set(item.uuid, item);
    await custom.exportCustomApparition(item);
    equal(savedFile.vessel.uuid, "Broken.vessel");
});
await test("focus spell picker filters choices by the current search text", async () => {
    const app = new custom.FocusSpellPickerApp(() => {});
    app.choices = [
        { uuid: "Item.alpha", name: "Alpha", source: "World", rank: 1, traits: ["focus"] },
        { uuid: "Item.beta", name: "Beta", source: "Spells", rank: 2, traits: ["focus", "healing"] },
    ];
    app.search = "beta";
    const context = await app._prepareContext({});
    equal(
        context.choices.map((choice) => choice.uuid),
        ["Item.beta"],
    );
});
await test("focus spell picker renders loading state before slow packs finish", async () => {
    const invalidate = () => {
        for (const callback of callbacks.get("createItem") ?? []) if (callback.name === "invalidateFocusSpellChoices") callback();
    };
    invalidate();
    let release;
    game.packs.set("pf2e.slow-spells", {
        metadata: { type: "Item", system: "pf2e", packageName: "pf2e", label: "Slow Spells" },
        getIndex: () => new Promise((resolve) => (release = resolve)),
    });
    const app = new custom.FocusSpellPickerApp(() => {});
    try {
        const context = await Promise.race([app._prepareContext({}), new Promise((resolve) => setTimeout(() => resolve("timeout"), 50))]);
        equal(context.loading, true);
    } finally {
        release?.([]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        game.packs.delete("pf2e.slow-spells");
        invalidate();
    }
});
await test("focus spell picker search filters rows without rerendering or losing focus", async () => {
    const app = new custom.FocusSpellPickerApp(() => {});
    app.choices = [
        { uuid: "Item.alpha", name: "Alpha", source: "World", rank: 1, traits: ["focus"] },
        { uuid: "Item.beta", name: "Beta", source: "Spells", rank: 2, traits: ["focus", "healing"] },
    ];
    const root = document.createElement("div");
    root.innerHTML = `<input data-role="focus-spell-search"><ol><li><button data-action="select-focus-spell" data-uuid="Item.alpha">Alpha</button></li><li><button data-action="select-focus-spell" data-uuid="Item.beta">Beta</button></li></ol><li class="empty" data-role="focus-spell-empty" hidden></li>`;
    document.body.append(root);
    let renders = 0;
    app.render = () => {
        renders++;
        return app;
    };
    app._attachPartListeners("picker", root);
    const input = root.querySelector("[data-role='focus-spell-search']");
    input.focus();
    input.value = "beta";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    equal(renders, 0);
    equal(root.querySelector('[data-uuid="Item.alpha"]').closest("li").hidden, true);
    equal(root.querySelector('[data-uuid="Item.beta"]').closest("li").hidden, false);
    equal(document.activeElement, input);
    input.value = "missing";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    equal(root.querySelector("[data-role='focus-spell-empty']").hidden, false);
    root.remove();
});
await test("focus spell picker shows UUIDs for duplicate names", async () => {
    globalThis.Handlebars.registerHelper("localize", (key) => key);
    const template = globalThis.Handlebars.compile(await (await fetch("../templates/custom-apparitions/focus-spell-picker.hbs")).text());
    const app = new custom.FocusSpellPickerApp(() => {});
    app.choices = [
        { uuid: "Item.alpha", name: "Duplicate", source: "World", rank: 1, traits: ["focus"] },
        { uuid: "Item.beta", name: "Duplicate", source: "World", rank: 1, traits: ["focus"] },
    ];
    const context = await app._prepareContext({});
    equal(
        context.choices.map((choice) => choice.duplicateName),
        [true, true],
    );
    const root = document.createElement("div");
    root.innerHTML = template(context);
    equal(
        [...root.querySelectorAll(".uuid")].map((element) => element.textContent.trim()),
        ["Item.alpha", "Item.beta"],
    );
});
await test("custom editor renders referenced Vessels read-only and authored Vessels editable", async () => {
    globalThis.Handlebars.registerHelper("localize", (key) => key);
    const template = globalThis.Handlebars.compile(await (await fetch("../templates/custom-apparitions/editor.hbs")).text());
    const referenced = new custom.CustomApparitionEditorApp(null, {
        seed: {
            name: "Referenced",
            vessel: {
                uuid: "Item.vessel",
                isReference: true,
                name: "Shared Vessel",
                img: "",
                rank: 1,
                actions: "1",
                range: "",
                target: "",
                duration: "",
                description: "",
                extraTraits: [],
            },
        },
    });
    referenced.step = 2;
    const referenceContext = await referenced._prepareContext({});
    const referenceRoot = document.createElement("div");
    referenceRoot.innerHTML = template(referenceContext);
    assert(referenceRoot.querySelector('[data-action="useAuthoredVessel"]'));
    assert(!referenceRoot.querySelector('[name="vesselName"]'));

    const authored = new custom.CustomApparitionEditorApp(null, {
        seed: { name: "Authored", vessel: { name: "Owned Vessel", isReference: false, extraTraits: [] } },
    });
    authored.step = 2;
    const authoredContext = await authored._prepareContext({});
    const authoredRoot = document.createElement("div");
    authoredRoot.innerHTML = template(authoredContext);
    assert(authoredRoot.querySelector('[data-action="selectExistingVessel"]'));
    assert(authoredRoot.querySelector('[name="vesselName"]'));
});
await test("custom import rejects an invalid Vessel UUID before writing documents", async () => {
    const count = game.items.length;
    equal(
        await custom.importCustomApparitionData({
            format: "pf2e-dailies-apparition-fix-custom-apparition",
            name: "Invalid UUID",
            lores: [],
            spells: [],
            vessel: { uuid: "Bad]uuid", name: "Invalid" },
        }),
        null,
    );
    equal(game.items.length, count);
});
await test("custom import rejects wrong format without writes", async () => {
    const count = game.items.length;
    equal(await custom.importCustomApparitionData({ format: "wrong" }), null);
    equal(game.items.length, count);
});
await test("custom import is GM-only", async () => {
    game.user.isGM = false;
    equal(await custom.importCustomApparitionData({ format: "pf2e-dailies-apparition-fix-custom-apparition" }), null);
});
await test("preUpdate retains genuine class signature flags for flattened and nested updates", async () => {
    const a = actor();
    attunement(a);
    const [entry] = await a.createEmbeddedDocuments("Item", [
        {
            type: "spellcastingEntry",
            system: { prepared: { value: "spontaneous" } },
            flags: { [ID]: { identifier: "animist-spontaneous" } },
        },
    ]);
    const item = add(a, {
        type: "spell",
        system: { location: { value: entry.id, signature: true } },
        flags: { [ID]: { identifier: "animist-spontaneous" } },
    });
    const handler = callbacks.get("preUpdateItem")[0];
    const flat = { "system.location.signature": false };
    handler(item, flat);
    equal(flat["system.location.signature"], true);
    const nested = { system: { location: { signature: false } } };
    handler(item, nested);
    equal(nested.system.location.signature, true);
});
await test("preUpdate does not alter unmanaged signature spells", () => {
    const handler = callbacks.get("preUpdateItem")[0],
        item = doc({ type: "spell" }),
        changes = { "system.location.signature": true };
    handler(item, changes);
    equal(changes["system.location.signature"], true);
});

await test("spell parser deduplicates references and accepts lowercase legacy compendium syntax", () => {
    const f = {
        system: {
            description: { value: "<ul><li>@compendium[pf2e.spells-srd.abc]</li><li>@UUID[Compendium.pf2e.spells-srd.abc]</li></ul>" },
        },
    };
    equal(core.parseApparitionSpellUuids(f), ["Compendium.pf2e.spells-srd.abc"]);
});
await test("bonding creates one spell copy; re-bonding is idempotent on PF2e 8.6.1", async () => {
    const a = actor();
    attunement(a);
    const spell = doc({ type: "spell", name: "Shared", system: { level: { value: 1 }, traits: { value: [] } } });
    spell.baseRank = 1;
    documents.set(spell.uuid, spell);
    const apparition = doc({
        type: "feat",
        name: "Apparition",
        system: {
            rules: [],
            traits: { value: ["animist"], otherTags: ["animist-apparition"] },
            description: {
                value: `<hr><p><strong>Lore</strong> Forest Lore</p><ul><li>@UUID[${spell.uuid}]{Shared}</li><li>@UUID[${spell.uuid}]{Shared}</li></ul>`,
            },
        },
    });
    documents.set(apparition.uuid, apparition);
    await core.addApparition(a, apparition);
    await core.addApparition(a, apparition);
    equal(core.getBondedApparitionFeats(a).length, 1);
    equal(a.itemTypes.spell.length, 1);
    equal(a.itemTypes.lore.length, 0);
    assert(core.getBondedApparitionFeats(a)[0].system.rules.some((r) => r.path?.startsWith("system.skills.")));
});
await test("unbond preserves a shared spell until its last granting apparition is removed", async () => {
    const a = actor();
    attunement(a);
    const spell = doc({ type: "spell", name: "Shared", system: { level: { value: 1 }, traits: { value: [] } } });
    spell.baseRank = 1;
    documents.set(spell.uuid, spell);
    const create = (name) =>
        doc({
            type: "feat",
            name,
            system: {
                rules: [],
                traits: { value: ["animist"], otherTags: ["animist-apparition"] },
                description: { value: `<ul><li>@UUID[${spell.uuid}]{Shared}</li></ul>` },
            },
        });
    const first = create("First"),
        second = create("Second");
    await core.addApparition(a, first);
    await core.addApparition(a, second);
    equal(a.itemTypes.spell.length, 1);
    await core.removeApparition(a, first);
    equal(a.itemTypes.spell.length, 1);
    equal(a.itemTypes.spell[0].getFlag(ID, "apparitions"), [second.uuid]);
    await core.removeApparition(a, second);
    equal(a.itemTypes.spell.length, 0);
});
await test("Dailies isolation restores the previous disabled flag", async () => {
    const a = actor();
    attunement(a);
    game.modules.set("pf2e-dailies", { active: true });
    await a.setFlag("pf2e-dailies", "disabled.dailies.animist", false);
    await core.syncDailiesIsolation(a);
    equal(a.getFlag("pf2e-dailies", "disabled.dailies.animist"), true);
    settings.set("enabled", false);
    await core.syncDailiesIsolation(a, { restore: true });
    equal(a.getFlag("pf2e-dailies", "disabled.dailies.animist"), false);
});
await test("Lore rules scale at levels 8 and 16 without duplicates", async () => {
    const a = actor(),
        f = feat(a, "Item.a");
    for (const [level, rank] of [
        [1, 1],
        [8, 2],
        [16, 3],
    ]) {
        a.level = level;
        await core.syncApparitionLoreRuleElements(a, f);
        const rules = f.system.rules.filter((r) => r.path?.startsWith("system.skills."));
        equal(rules.length, 2);
        assert(rules.every((r) => r.value.rank === rank));
    }
});
await test("transient apparition index failure does not poison cache", async () => {
    let calls = 0;
    game.packs.set("pf2e.classfeatures", {
        getIndex: async () => {
            if (++calls === 1) throw Error("Network");
            return [];
        },
    });
    await manager.loadAvailableApparitions();
    assert(errors.length === 1);
    errors = [];
    await manager.loadAvailableApparitions();
    equal(calls, 2);
});
await test("transient wandering index failure is retried on next open", async () => {
    let calls = 0;
    game.packs.set("pf2e.feats-srd", {
        getIndex: async () => {
            if (++calls === 1) throw Error("Network");
            return [];
        },
    });
    await wandering.loadAllWanderingFeats();
    assert(errors.length === 1);
    errors = [];
    await wandering.loadAllWanderingFeats();
    equal(calls, 2);
});

await test("parallel bonding calls do not duplicate feats or shared spells", async () => {
    const a = actor();
    attunement(a);
    const spell = doc({ type: "spell", name: "Parallel", system: { level: { value: 1 }, traits: { value: [] } } });
    spell.baseRank = 1;
    documents.set(spell.uuid, spell);
    const apparition = doc({
        type: "feat",
        name: "Parallel apparition",
        system: {
            rules: [],
            traits: { value: ["animist"], otherTags: ["animist-apparition"] },
            description: { value: `<ul><li>@UUID[${spell.uuid}]{Parallel}</li></ul>` },
        },
    });
    await Promise.all([core.addApparition(a, apparition), core.addApparition(a, apparition)]);
    equal(core.getBondedApparitionFeats(a).length, 1);
    equal(a.itemTypes.spell.length, 1);
});
await test("nightly cleanup removes only module temporary items and stores yesterday", async () => {
    const a = actor();
    attunement(a);
    const f = feat(a, "Item.daily");
    const keep = add(a, { type: "feat", name: "Other daily", flags: { "pf2e-dailies": { temporary: true } } });
    callbacks.get("pf2e.restForTheNight")[0](a);
    await new Promise((r) => setTimeout(r, 40));
    assert(!a.items.has(f.id));
    assert(a.items.has(keep.id));
    equal(core.getLastDayApparitionSnapshot(a).apparitions, ["Item.daily"]);
});
await test("rest hook does not mutate characters when module is disabled", async () => {
    const a = actor(),
        f = feat(a, "Item.daily");
    settings.set("enabled", false);
    callbacks.get("pf2e.restForTheNight")[0](a);
    await new Promise((r) => setTimeout(r, 10));
    assert(a.items.has(f.id));
});
await test("custom apparition JSON export/import roundtrip retains Vessel damage", async () => {
    const original = game.items.find((i) => i.type === "feat" && i.getFlag(ID, "customApparition"));
    assert(original);
    await custom.exportCustomApparition(original);
    assert(savedFile && savedFile.format === "pf2e-dailies-apparition-fix-custom-apparition");
    const copy = await custom.importCustomApparitionData(savedFile);
    assert(copy && copy.id !== original.id);
    const v = await fromUuid(core.parseApparitionVesselUuid(copy));
    equal(v.system.damage.main.formula, "2d6");
});

await test("disabled module does not run actor migrations", async () => {
    const a = actor();
    feat(a, "Item.a");
    game.actors.push(a);
    settings.set("enabled", false);
    const before = JSON.stringify(a.items.map((i) => i.toObject()));
    await core.migrateLegacyDailiesState();
    await core.migrateApparitionLoresToRuleElements();
    equal(JSON.stringify(a.items.map((i) => i.toObject())), before);
    assert(!a.getFlag(ID, "migrated"));
});
// 1.2.0 rules/data regressions (mock documents, not a running Foundry world).
function ruleApparition({ spellRank = 1, includeCantrip = true, vesselUuid = null, lore = "Forest Lore" } = {}) {
    const spells = [];
    if (includeCantrip) {
        const cantrip = doc({ type: "spell", name: "Cantrip", system: { level: { value: 1 }, traits: { value: ["cantrip"] } } });
        documents.set(cantrip.uuid, cantrip);
        spells.push(cantrip);
    }
    if (spellRank) {
        const spell = doc({ type: "spell", name: "Rank " + spellRank, system: { level: { value: spellRank }, traits: { value: [] } } });
        spell.baseRank = spellRank;
        documents.set(spell.uuid, spell);
        spells.push(spell);
    }
    if (!vesselUuid) {
        const focus = doc({ type: "spell", name: "Focus", system: { level: { value: 1 }, traits: { value: ["focus", "animist"] } } });
        documents.set(focus.uuid, focus);
        vesselUuid = focus.uuid;
    }
    const apparition = doc({
        type: "feat",
        name: "Rule spirit",
        system: {
            rules: [],
            traits: { value: ["animist"], otherTags: ["animist-apparition"] },
            description: {
                value: `<hr><p><strong>Skills</strong> ${lore}</p><ul>${spells.map((spell) => `<li>@UUID[${spell.uuid}]{Spell}</li>`).join("")}</ul><p>@UUID[${vesselUuid}]{Vessel}</p>`,
            },
        },
    });
    documents.set(apparition.uuid, apparition);
    return { apparition, spells, vesselUuid };
}
function dedication(a) {
    return add(a, { type: "feat", name: "Dedication", system: { slug: "animist-dedication", rules: [] } });
}
function archetypeFeat(a, slug) {
    return add(a, { type: "feat", name: slug, system: { slug, rules: [] } });
}
function spiritFamiliar(a) {
    return archetypeFeat(a, "spirit-familiar-animist");
}
function relinquish(a) {
    return add(a, {
        type: "feat",
        name: "Relinquish",
        _stats: { compendiumSource: "Compendium.pf2e.feats-srd.Item.Gw8tjM91F6i3fOnR" },
        system: { rules: [] },
    });
}

await test("class wins over dedication for dual-class/feature actors", () => {
    const a = actor();
    dedication(a);
    equal(core.getAnimistCastingMode(a), "archetype");
    attunement(a);
    equal(core.getAnimistCastingMode(a), "class");
});
await test("attunement count is informational: level 1 can still add five", async () => {
    const a = actor();
    a.level = 1;
    attunement(a);
    for (let n = 0; n < 5; n++)
        await core.addApparition(a, ruleApparition({ spellRank: 0, includeCantrip: false }).apparition, { silent: true });
    equal(core.getAttunementSummary(a).count, 5);
    equal(core.getAttunementSummary(a).expected, 2);
});
await test("count guidance scales at levels 7 and 15, dedication stays one", () => {
    const a = actor();
    attunement(a);
    for (const [level, expected] of [
        [1, 2],
        [6, 2],
        [7, 3],
        [14, 3],
        [15, 4],
        [20, 4],
    ]) {
        a.level = level;
        equal(core.getAttunementSummary(a).expected, expected);
    }
    const b = actor();
    b.level = 20;
    dedication(b);
    equal(core.getAttunementSummary(b).expected, 1);
});
await test("dedication only: prepared divine Wisdom, two cantrips, no ranked slots or Vessel", async () => {
    const a = actor();
    a.level = 2;
    a.classDC = { attribute: "int" };
    dedication(a);
    const { apparition, spells } = ruleApparition();
    await core.addApparition(a, apparition);
    const entry = core.getApparitionEntry(a);
    equal(entry.system.prepared.value, "prepared");
    equal(entry.system.ability.value, "wis");
    equal(entry.system.tradition.value, "divine");
    equal(entry.system.slots.slot0.max, 2);
    equal(entry.system.slots.slot1.max, 0);
    equal(core.getVesselEntry(a), null);
    assert([...entry.spells.values()].some((s) => s.sourceId === spells[0].uuid));
    assert(![...entry.spells.values()].some((s) => s.sourceId === spells[1].uuid));
    assert(core.getBondedApparitionFeats(a)[0].system.rules.some((r) => r.path?.startsWith("system.skills.")));
});
await test("basic/expert/master archetype rank progression", () => {
    const a = actor();
    dedication(a);
    archetypeFeat(a, "basic-animist-spellcasting");
    for (const [level, expected] of [
        [4, 1],
        [6, 2],
        [8, 3],
        [11, 3],
        [20, 3],
    ]) {
        a.level = level;
        equal(core.getArchetypeProgression(a).maxRank, expected);
    }
    archetypeFeat(a, "expert-animist-spellcasting");
    for (const [level, expected] of [
        [12, 4],
        [14, 5],
        [16, 6],
        [20, 6],
    ]) {
        a.level = level;
        equal(core.getArchetypeProgression(a).maxRank, expected);
    }
    archetypeFeat(a, "master-animist-spellcasting");
    a.level = 18;
    equal(core.getArchetypeProgression(a).maxRank, 7);
    a.level = 20;
    equal(core.getArchetypeProgression(a).maxRank, 8);
});
await test("prepared archetype grants appropriate spells without signature, native preparation remains", async () => {
    const a = actor();
    a.level = 6;
    dedication(a);
    archetypeFeat(a, "basic-animist-spellcasting");
    const { apparition, spells } = ruleApparition({ spellRank: 2 });
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    equal(e.system.slots.slot2.max, 1);
    equal(e.system.slots.slot3.max, 0);
    const spell = [...e.spells.values()].find((spell) => spell.sourceId === spells[1].uuid);
    assert(spell);
    assert(!spell.system.location.signature);
});
await test("Apparition Magic: separate prepared restricted slots, excludes two highest ranks", async () => {
    const a = actor();
    a.level = 14;
    dedication(a);
    for (const slug of ["basic-animist-spellcasting", "expert-animist-spellcasting", "apparition-magic"]) archetypeFeat(a, slug);
    const { apparition, spells } = ruleApparition({ spellRank: 2 });
    await core.addApparition(a, apparition);
    const extra = a.spellcasting.find((e) => e.flags[ID]?.identifier.endsWith("-restricted"));
    assert(extra);
    equal(extra.system.slots.slot0.max, 0);
    equal(extra.system.slots.slot3.max, 1);
    equal(extra.system.slots.slot4.max, 0);
    assert([...extra.spells.values()].some((spell) => spell.sourceId === spells[1].uuid));
    assert(![...extra.spells.values()].some((spell) => spell.sourceId === spells[0].uuid));
    await core.removeApparition(a, apparition);
    equal(extra.spells.size, 0);
});
await test("archetype repeated bonding preserves prepared expenditure", async () => {
    const a = actor();
    a.level = 6;
    dedication(a);
    archetypeFeat(a, "basic-animist-spellcasting");
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    await e.update({ "system.slots.slot1.prepared": { 0: { id: "abc", expended: true } } });
    await core.addApparition(a, apparition);
    equal(e.system.slots.slot1.prepared[0].expended, true);
});
await test("legacy archetype conversion backs up module items and leaves unrelated caster alone", async () => {
    const a = actor();
    a.level = 2;
    dedication(a);
    const [legacy, foreign] = await a.createEmbeddedDocuments("Item", [
        {
            type: "spellcastingEntry",
            name: "Old",
            system: { prepared: { value: "spontaneous" }, slots: { slot1: { max: 1, value: 0 } } },
            flags: { [ID]: { identifier: "animist-spontaneous" } },
        },
        {
            type: "spellcastingEntry",
            name: "Wizard",
            system: { prepared: { value: "prepared" }, ability: { value: "int" }, slots: { slot1: { max: 3, value: 2 } } },
        },
    ]);
    const v = ruleApparition();
    await core.addApparition(a, v.apparition);
    assert(a.getFlag(ID, "rulesBackup120").items.some((item) => item._id === legacy.id));
    equal(legacy.system.prepared.value, "prepared");
    equal(legacy.system.slots.slot1.max, 0);
    equal(foreign.system.ability.value, "int");
    equal(foreign.system.slots.slot1.value, 2);
});
await test("class grants genuine signature spells and Wisdom", async () => {
    const a = actor();
    a.classDC = { attribute: "cha" };
    attunement(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    equal(e.system.prepared.value, "spontaneous");
    equal(e.system.ability.value, "wis");
    assert([...e.spells.values()].filter((s) => !s.isCantrip).every((s) => s.system.location.signature === true));
});
await test("startup restores legacy class signature flags without refilling spent slots", async () => {
    const a = actor();
    attunement(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    await e.update({ "system.slots.slot1.value": 0 });
    for (const s of e.spells.values()) await s.update({ "system.location.signature": false });
    game.actors.push(a);
    await core.migrateAnimistRules();
    assert([...e.spells.values()].filter((s) => !s.isCantrip).every((s) => s.system.location.signature));
    equal(e.system.slots.slot1.value, 0);
});
await test("prepared archetype cast buttons stay native", async () => {
    const a = actor();
    dedication(a);
    archetypeFeat(a, "basic-animist-spellcasting");
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    const spell = [...e.spells.values()].find((s) => !s.isCantrip);
    const root = document.createElement("div");
    root.innerHTML = `<li data-container-id="${e.id}"><div data-item-id="${spell.id}" data-entry-id="${e.id}"><button data-action="cast-spell">Cast</button></div></li>`;
    Hooks.callAll("renderCharacterSheetPF2e", { actor: a }, root);
    equal(root.querySelector("button").dataset.action, "cast-spell");
});
await test("signature virtual duplicates hidden via DOM marker, genuine data unchanged", async () => {
    const a = actor();
    attunement(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a),
        spell = [...e.spells.values()].find((s) => !s.isCantrip);
    const root = document.createElement("div");
    root.innerHTML = `<div class="spell virtual" data-item-id="${spell.id}" data-entry-id="${e.id}"></div>`;
    Hooks.callAll("renderCharacterSheetPF2e", { actor: a }, root);
    equal(root.firstElementChild.dataset.apparitionFixVirtual, "true");
    equal(spell.system.location.signature, true);
});
await test("Wandering level 8 cannot replace a feat taken at level 6, in UI and API", async () => {
    const a = actor();
    const original = add(a, {
        type: "feat",
        name: "Original",
        system: { level: { value: 6, taken: 6 }, category: "class", traits: { value: ["animist", "wandering"] } },
    });
    const replacement = doc({
        type: "feat",
        name: "Level8Homebrew",
        system: { level: { value: 8 }, category: "class", traits: { value: ["animist", "wandering"] } },
    });
    game.items.push(replacement);
    documents.set(replacement.uuid, replacement);
    const context = await wandering.getWanderingContext(a);
    assert(!context.rows[0].options.some((o) => o.uuid === replacement.uuid));
    equal(await wandering.replaceWanderingFeat(a, original.id, replacement.uuid), null);
    assert(a.items.has(original.id));
});
await test("Wandering level 8 is offered for feat taken at level 8", async () => {
    const a = actor();
    add(a, {
        type: "feat",
        name: "Original8",
        system: { level: { value: 6, taken: 8 }, category: "class", traits: { value: ["animist", "wandering"] } },
    });
    const f = doc({
        type: "feat",
        name: "ActualLevel8",
        system: { level: { value: 8 }, category: "class", traits: { value: ["animist", "wandering"] } },
    });
    game.items.push(f);
    assert((await wandering.getWanderingContext(a)).rows[0].options.some((o) => o.uuid === f.uuid));
});
await test("permanent selection does not force primary and may be unbound", async () => {
    const a = actor();
    attunement(a);
    relinquish(a);
    const { apparition } = ruleApparition();
    await core.setPermanentApparition(a, apparition.uuid);
    equal(core.getPrimaryVesselState(a).primary, []);
    await core.removeApparition(a, apparition);
    equal(core.getBondedApparitionFeats(a).length, 0);
    equal(core.getPermanentApparition(a).key, apparition.uuid);
});
await test("profile does not resurrect the fixed Relinquish Control choice", async () => {
    const a = actor();
    attunement(a);
    relinquish(a);
    const { apparition } = ruleApparition();
    await core.setPermanentApparition(a, apparition.uuid);
    const empty = { id: "empty", name: "Empty", apparitions: [], primary: [] };
    await a.setFlag(ID, "apparitionProfiles", [empty]);
    // Use the existing profile API's actual flag name.
    await core.removeApparition(a, apparition);
    const profile = await core.saveApparitionProfile(a, "Empty actual");
    await core.addApparition(a, apparition);
    await core.applyApparitionProfile(a, profile.id);
    equal(core.getBondedApparitionFeats(a).length, 0);
    equal(core.getPermanentApparition(a).key, apparition.uuid);
});
await test("ordinary owner may correct permanent choice without a GM hard lock", async () => {
    const a = actor();
    attunement(a);
    relinquish(a);
    const first = ruleApparition().apparition,
        second = ruleApparition().apparition;
    await core.setPermanentApparition(a, first.uuid);
    game.user.isGM = false;
    assert(await core.setPermanentApparition(a, second.uuid));
    equal(core.getPermanentApparition(a).key, second.uuid);
});
await test("Spirit Familiar loss suspends benefits but retains attunement", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    assert(await core.setSpiritFamiliar(a, apparition.uuid));
    await core.markSpiritFamiliarDestroyed(a);
    equal(core.getSpiritFamiliarState(a).status, "destroyed");
    equal(core.getBondedApparitionFeats(a).length, 1);
    equal(a.itemTypes.spell.length, 0);
    assert(!core.getBondedApparitionFeats(a)[0].system.rules.some((r) => r.path?.startsWith("system.skills.")));
    equal(core.getPrimaryVesselState(a).vesselKeys.length, 0);
});
await test("familiar-dead state survives re-bonding, profiles, repair and Lore migration", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    await core.setSpiritFamiliar(a, apparition.uuid);
    const profile = await core.saveApparitionProfile(a, "Familiar");
    await core.markSpiritFamiliarDestroyed(a);
    await core.addApparition(a, apparition);
    await core.applyApparitionProfile(a, profile.id);
    await core.repairApparitionActor(a);
    game.actors.push(a);
    await core.migrateApparitionLoresToRuleElements();
    equal(core.getBondedApparitionFeats(a).length, 1);
    equal(a.itemTypes.spell.length, 0);
    equal(core.getSpiritFamiliarState(a).status, "destroyed");
    assert(!core.getBondedApparitionFeats(a)[0].system.rules.some((r) => r.path?.startsWith("system.skills.")));
});
await test("remanifestation restores benefits without refilling spent slots", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    await e.update({ "system.slots.slot1.value": 0 });
    await core.setSpiritFamiliar(a, apparition.uuid);
    await core.markSpiritFamiliarDestroyed(a);
    assert(await core.remanifestSpiritFamiliar(a));
    equal(core.getSpiritFamiliarState(a).status, "active");
    assert(a.itemTypes.spell.length > 0);
    equal(e.system.slots.slot1.value, 0);
    assert(core.getBondedApparitionFeats(a)[0].system.rules.some((r) => r.path?.startsWith("system.skills.")));
});
await test("shared spells and Lore survive familiar loss through another granting apparition", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const one = ruleApparition();
    const source = one.apparition.toObject();
    delete source._id;
    source.name = "Other";
    const other = doc(source);
    documents.set(other.uuid, other);
    await core.addApparition(a, one.apparition);
    await core.addApparition(a, other);
    await core.setSpiritFamiliar(a, one.apparition.uuid);
    await core.markSpiritFamiliarDestroyed(a);
    assert(a.itemTypes.spell.length > 0);
    equal(core.getBondedApparitionFeats(a).length, 2);
    const dead = core.getBondedApparitionFeats(a).find((f) => core.getApparitionKey(f) === one.apparition.uuid);
    assert(!dead.system.rules.some((r) => r.path?.startsWith("system.skills.")));
});
await test("unbinding familiar apparition marks familiar destroyed; linked Actor is not deleted", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const familiar = doc({ type: "familiar", name: "Familiar" });
    documents.set(familiar.uuid, familiar);
    assert(await core.setSpiritFamiliar(a, apparition.uuid, familiar.uuid));
    await core.removeApparition(a, apparition);
    equal(core.getSpiritFamiliarState(a).status, "destroyed");
    assert(documents.has(familiar.uuid));
});
await test("nonowners cannot change familiar state", async () => {
    const a = actor();
    a.isOwner = false;
    game.user.isGM = false;
    equal(await core.setSpiritFamiliar(a, "Item.any"), false);
    equal(await core.markSpiritFamiliarDestroyed(a), false);
    equal(await core.remanifestSpiritFamiliar(a), false);
});
await test("disabled module rules migration is a no-op", async () => {
    const a = actor();
    dedication(a);
    game.actors.push(a);
    settings.set("enabled", false);
    await core.migrateAnimistRules();
    equal(a.spellcasting.length, 0);
});

await test("exhausted lower rank still casts using a higher rank through public picker", async () => {
    const a = actor();
    attunement(a);
    const { apparition } = ruleApparition({ spellRank: 2 });
    await core.addApparition(a, apparition);
    const e = core.getApparitionEntry(a);
    e.actor = a;
    const spell = [...e.spells.values()].find((s) => !s.isCantrip);
    await e.update({ "system.slots.slot2.value": 0, "system.slots.slot3": { max: 1, value: 1 } });
    let chosen;
    e.cast = async (s, o) => {
        chosen = o.rank;
        await e.update({ [`system.slots.slot${o.rank}.value`]: 0 });
    };
    await core.openCastDialog(e, spell);
    equal(chosen, 3);
    equal(e.system.slots.slot2.value, 0);
});
await test("cantrips are not turned into virtual signature rows", async () => {
    const a = actor();
    attunement(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const spell = [...core.getApparitionEntry(a).spells.values()].find((s) => s.isCantrip);
    assert(!spell.system.location.signature);
    game.actors.push(a);
    await core.migrateAnimistRules();
    assert(!spell.system.location.signature);
});
await test("translated archetype feats match exact compendium source IDs", () => {
    const a = actor();
    dedication(a);
    a.level = 20;
    for (const id of ["l64p70oQ6a3AtMq9", "UrFeYPLjbWNYMpYA", "WXEOriht1LBz55R0", "rmmqfzs9XYR9XDok"])
        add(a, {
            type: "feat",
            name: "Перевод",
            _stats: { compendiumSource: `Compendium.pf2e.feats-srd.Item.${id}` },
            system: { rules: [] },
        });
    equal(core.getArchetypeProgression(a), { maxRank: 8, bonusMaxRank: 6, proficiency: 3 });
});
await test("deleting the linked familiar Actor marks loss without deleting the character", async () => {
    const a = actor();
    attunement(a);
    spiritFamiliar(a);
    const { apparition } = ruleApparition();
    await core.addApparition(a, apparition);
    const familiar = doc({ type: "familiar", name: "Familiar" });
    documents.set(familiar.uuid, familiar);
    await core.setSpiritFamiliar(a, apparition.uuid, familiar.uuid);
    game.actors.push(a);
    Hooks.callAll("deleteActor", familiar, {}, game.user.id);
    await new Promise((r) => setTimeout(r, 30));
    equal(core.getSpiritFamiliarState(a).status, "destroyed");
    equal(core.getBondedApparitionFeats(a).length, 1);
    assert(game.actors.has(a.id));
});
await test("Wandering actual level allowed replacement preserves acquisition level", async () => {
    const a = actor();
    const original = add(a, {
        type: "feat",
        name: "Original",
        system: { level: { value: 6, taken: 8 }, category: "class", location: "class-8", traits: { value: ["animist", "wandering"] } },
    });
    const replacement = doc({
        type: "feat",
        name: "Level8",
        system: { level: { value: 8 }, category: "class", traits: { value: ["animist", "wandering"] } },
    });
    documents.set(replacement.uuid, replacement);
    const result = await wandering.replaceWanderingFeat(a, original.id, replacement.uuid);
    assert(result);
    equal(result.system.level.taken, 8);
    equal(result.system.location, "class-8");
    assert(!a.items.has(original.id));
});

const { runManagerTests } = await import("./manager.mjs");
await runManagerTests({ test, assert, equal, actor, feat, attunement, add, doc, documents, manager, wandering, core, App });

const output = {
    environment: "Chromium DOM; mocked Foundry/PF2e documents, not a live world",
    pass: results.filter((r) => r.pass).length,
    fail: results.filter((r) => !r.pass).length,
    tests: results,
};
document.getElementById("result").textContent = JSON.stringify(output, null, 2);
document.title = output.fail ? "FAIL" : "PASS";
