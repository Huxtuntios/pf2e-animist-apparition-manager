/**
 * Checks the language files: both languages define the same keys with the
 * same {placeholders}, and every localization key used by the scripts and
 * templates is defined.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_ID = JSON.parse(fs.readFileSync(path.join(root, "module.json"), "utf8")).id;

const flatten = (object, prefix = "") =>
    Object.entries(object).flatMap(([key, value]) =>
        typeof value === "object" && value !== null ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]],
    );
const load = (lang) => new Map(flatten(JSON.parse(fs.readFileSync(path.join(root, "lang", `${lang}.json`), "utf8"))));
const placeholders = (text) =>
    [...String(text).matchAll(/\{(\w+)\}/g)]
        .map((match) => match[1])
        .sort()
        .join(",");

const errors = [];
const en = load("en");
const ru = load("ru");

for (const key of en.keys()) if (!ru.has(key)) errors.push(`missing in ru.json: ${key}`);
for (const key of ru.keys()) if (!en.has(key)) errors.push(`missing in en.json: ${key}`);
for (const [key, text] of en) {
    if (ru.has(key) && placeholders(text) !== placeholders(ru.get(key))) errors.push(`placeholders differ: ${key}`);
}

const sources = [];
const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(mjs|hbs)$/.test(entry.name)) sources.push(fs.readFileSync(file, "utf8"));
    }
};
walk(path.join(root, "scripts"));
walk(path.join(root, "templates"));

const used = new Set();
for (const source of sources) {
    for (const match of source.matchAll(new RegExp(`(?:${MODULE_ID}|\\$\\{MODULE_ID\\})\\.([A-Za-z0-9_.]+)`, "g"))) {
        used.add(match[1].replace(/\.$/, ""));
    }
}
// Keys built at run time (`${MODULE_ID}.Group.${name}`) are matched by their prefix.
const hasKey = (key) => [...en.keys()].some((defined) => defined === `${MODULE_ID}.${key}` || defined.startsWith(`${MODULE_ID}.${key}.`));
// Flag paths such as `${MODULE_ID}.origin` are not localization keys.
const FLAG_PATHS = new Set(["apparitions", "identifier", "origin", "temporary", "customApparitionSource"]);
for (const key of used) if (!FLAG_PATHS.has(key) && !hasKey(key)) errors.push(`used but not defined: ${key}`);

if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
}
console.log(`Language files OK (${en.size} keys in each language).`);
