/** Read-only, client-session caches for the manager. No Actor writes here. */
import {
    MODULE_ID,
    getApparitionKey,
    parseApparitionSpellUuids,
    parseApparitionVesselUuid,
    parseApparitionLores,
    ordinalString,
} from "./apparition-fix.mjs";

const REQUEST_TIMEOUT = 12000;
let generation = 0;
let locale = null;
let catalogPromise = null;
let catalogErrors = [];
const detailPromises = new Map();
const documentPromises = new Map();
const queue = [];
let running = 0;

/** Limit actual UUID requests, including requests whose UI deadline has expired. */
function schedule(read) {
    return new Promise((resolve, reject) => {
        queue.push({ read, resolve, reject });
        pump();
    });
}
function pump() {
    while (running < 6 && queue.length) {
        const task = queue.shift();
        running++;
        Promise.resolve()
            .then(task.read)
            .then(task.resolve, task.reject)
            .finally(() => {
                running--;
                pump();
            });
    }
}
export function withTimeout(promise, ms = REQUEST_TIMEOUT) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => {
                const error = new Error("Manager request deadline exceeded");
                error.code = "BMO_TIMEOUT";
                reject(error);
            }, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}
function checkLocale() {
    if (locale !== game.i18n.lang) {
        invalidateManagerData();
        locale = game.i18n.lang;
    }
}
export function invalidateManagerData() {
    generation++;
    catalogPromise = null;
    catalogErrors = [];
    detailPromises.clear();
    documentPromises.clear();
}
export function getCatalogErrors() {
    return [...catalogErrors];
}
export function summarizeApparition(source) {
    return {
        uuid: getApparitionKey(source) ?? source.uuid,
        name: source.name,
        img: source.img,
        lores: parseApparitionLores(source),
        spellUuids: parseApparitionSpellUuids(source),
        vesselUuid: parseApparitionVesselUuid(source),
    };
}
export function loadAvailableApparitions({ force = false } = {}) {
    checkLocale();
    if (force) {
        catalogPromise = null;
        catalogErrors = [];
    }
    if (catalogPromise) return catalogPromise;
    const epoch = generation;
    const errors = [];
    const request = (async () => {
        const lists = await Promise.all(
            ["pf2e.classfeatures", "pf2e-anachronism.class-features"].map(async (id) => {
                const pack = game.packs.get(id);
                if (!pack) return [];
                try {
                    // Description is needed for Lore/UUID references, NOT full spell documents.
                    const index = await withTimeout(pack.getIndex({ fields: ["system.traits.otherTags", "system.description.value"] }));
                    return index
                        .filter((entry) => entry.type === "feat" && entry.system?.traits?.otherTags?.includes("animist-apparition"))
                        .map(summarizeApparition);
                } catch (error) {
                    errors.push(id);
                    console.error(`${MODULE_ID} | Failed to index apparition pack ${id}`, error);
                    return [];
                }
            }),
        );
        const custom = game.items
            .filter((item) => item.type === "feat" && item.getFlag(MODULE_ID, "customApparition"))
            .map(summarizeApparition);
        const entries = [...new Map([...lists.flat(), ...custom].map((entry) => [entry.uuid, entry])).values()].sort((a, b) =>
            a.name.localeCompare(b.name, game.i18n.lang),
        );
        if (epoch === generation && catalogPromise === request) {
            catalogErrors = errors;
            if (errors.length) catalogPromise = null;
        }
        return entries;
    })();
    catalogPromise = request;
    return request;
}
export function resolveManagerDocument(uuid, { force = false } = {}) {
    checkLocale();
    if (force) documentPromises.delete(uuid);
    if (documentPromises.has(uuid)) return documentPromises.get(uuid);
    const promise = withTimeout(schedule(() => fromUuid(uuid)));
    documentPromises.set(uuid, promise);
    promise.then(
        (doc) => {
            if (!doc && documentPromises.get(uuid) === promise) documentPromises.delete(uuid);
        },
        () => {
            if (documentPromises.get(uuid) === promise) documentPromises.delete(uuid);
        },
    );
    return promise;
}
export function getApparitionDetails(summary, { force = false } = {}) {
    checkLocale();
    const key = JSON.stringify([game.i18n.lang, summary.uuid, summary.spellUuids, summary.vesselUuid, summary.lores]);
    if (force) detailPromises.delete(key);
    if (detailPromises.has(key)) return detailPromises.get(key);
    const promise = (async () => {
        const uuids = [...new Set([...summary.spellUuids, summary.vesselUuid].filter(Boolean))];
        const resolved = await Promise.all(
            uuids.map(async (uuid) => {
                try {
                    const doc = await resolveManagerDocument(uuid, { force });
                    return { uuid, doc, failed: !doc?.isOfType?.("spell") };
                } catch {
                    return { uuid, doc: null, failed: true };
                }
            }),
        );
        const byUuid = new Map(resolved.map((result) => [result.uuid, result.doc]));
        const spells = summary.spellUuids
            .map((uuid) => byUuid.get(uuid))
            .filter((doc) => doc?.isOfType?.("spell"))
            .map((doc) => {
                const rank = doc.isCantrip ? 0 : (doc.baseRank ?? doc.system?.level?.value ?? 1);
                return {
                    uuid: doc.uuid,
                    name: doc.name,
                    img: doc.img,
                    rank,
                    rankLabel: doc.isCantrip ? game.i18n.localize(`${MODULE_ID}.CustomApparition.Cantrip`) : ordinalString(rank),
                };
            })
            .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, game.i18n.lang));
        const vessel = byUuid.get(summary.vesselUuid);
        return {
            spells,
            vessel: vessel?.isOfType?.("spell") ? { uuid: vessel.uuid, name: vessel.name, img: vessel.img } : null,
            lores: summary.lores,
            errors: resolved.filter((result) => result.failed).map((result) => result.uuid),
        };
    })();
    detailPromises.set(key, promise);
    promise.then(
        (result) => {
            if (result.errors.length && detailPromises.get(key) === promise) detailPromises.delete(key);
        },
        () => {
            if (detailPromises.get(key) === promise) detailPromises.delete(key);
        },
    );
    return promise;
}
