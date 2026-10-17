/**
 * Release packaging.
 *
 *   node tools/build-release.mjs --check
 *       Validates the module without writing anything.
 *   node tools/build-release.mjs --repo OWNER/NAME [--tag v1.2.3]
 *       Writes dist/module.json (manifest with the URLs filled in) and
 *       dist/module.zip (the package Foundry downloads).
 *
 * The same script runs locally and in .github/workflows/release.yml, so a
 * release built by hand is identical to the one GitHub builds.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

/** Files and folders that go into module.zip (module.json is added separately). */
const PACKAGE_ENTRIES = ["scripts", "styles", "templates", "lang", "LICENSE"];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
};

const errors = [];
const fail = (message) => errors.push(message);
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/* -------------------------------------------- */
/*  Validation                                   */
/* -------------------------------------------- */

const manifestText = read("module.json");
const manifest = JSON.parse(manifestText);
const packageJson = JSON.parse(read("package.json"));

if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) fail(`module.json: version "${manifest.version}" is not MAJOR.MINOR.PATCH`);
if (packageJson.version !== manifest.version)
    fail(`package.json version ${packageJson.version} differs from module.json version ${manifest.version}`);

const tag = option("tag");
if (tag && tag.replace(/^v/, "") !== manifest.version) fail(`tag ${tag} does not match the module.json version ${manifest.version}`);

for (const file of [
    ...(manifest.esmodules ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map((lang) => lang.path),
    "LICENSE",
]) {
    if (!fs.existsSync(path.join(root, file))) fail(`missing file: ${file}`);
}

// Every relative import and every template path used by the scripts must exist.
const scriptsDir = path.join(root, "scripts");
for (const name of fs.readdirSync(scriptsDir).filter((file) => file.endsWith(".mjs"))) {
    const source = fs.readFileSync(path.join(scriptsDir, name), "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        if (!fs.existsSync(path.resolve(scriptsDir, match[1]))) fail(`scripts/${name}: missing import ${match[1]}`);
    }
    for (const match of source.matchAll(/templates\/[\w./-]+\.hbs/g)) {
        if (!fs.existsSync(path.join(root, match[0]))) fail(`scripts/${name}: missing template ${match[0]}`);
    }
}

if (errors.length) {
    console.error(errors.map((message) => `error: ${message}`).join("\n"));
    process.exit(1);
}
if (flag("check")) {
    console.log(`Release check OK (${manifest.id} ${manifest.version}).`);
    process.exit(0);
}

/* -------------------------------------------- */
/*  Packaging                                    */
/* -------------------------------------------- */

const repo = option("repo");
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    console.error("error: pass --repo OWNER/NAME");
    process.exit(1);
}
const [owner] = repo.split("/");
const url = `https://github.com/${repo}`;
const releaseTag = tag ?? `v${manifest.version}`;
const replacements = {
    "#{OWNER}#": owner,
    "#{URL}#": url,
    "#{MANIFEST}#": `${url}/releases/latest/download/module.json`,
    "#{DOWNLOAD}#": `${url}/releases/download/${releaseTag}/module.zip`,
};

let releaseManifest = manifestText;
for (const [placeholder, value] of Object.entries(replacements)) releaseManifest = releaseManifest.split(placeholder).join(value);
if (releaseManifest.includes("#{")) {
    console.error(`error: unresolved placeholder in module.json: ${releaseManifest.match(/#\{\w+\}#/)?.[0]}`);
    process.exit(1);
}

const entries = [{ name: "module.json", data: Buffer.from(releaseManifest, "utf8") }];
const collect = (relative) => {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) {
        for (const child of fs.readdirSync(absolute).sort()) collect(`${relative}/${child}`);
    } else {
        entries.push({ name: relative, data: fs.readFileSync(absolute) });
    }
};
PACKAGE_ENTRIES.forEach(collect);

fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, "module.json"), releaseManifest);
fs.writeFileSync(path.join(dist, "module.zip"), createZip(entries));
console.log(`Built dist/module.json and dist/module.zip (${entries.length} files) for ${repo} ${releaseTag}.`);

/* -------------------------------------------- */
/*  Minimal ZIP writer (deflate, UTF-8 names)    */
/* -------------------------------------------- */

/**
 * @param {{ name: string, data: Buffer }[]} files
 * @returns {Buffer}
 */
function createZip(files) {
    // A fixed timestamp keeps the archive reproducible: 2026-01-01 00:00:00.
    const dosTime = 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const { name, data } of files) {
        const nameBuffer = Buffer.from(name, "utf8");
        const compressed = zlib.deflateRawSync(data, { level: 9 });
        const crc = zlib.crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(8, 8); // deflate
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuffer.length, 26);
        locals.push(local, nameBuffer, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuffer);

        offset += local.length + nameBuffer.length + compressed.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}
