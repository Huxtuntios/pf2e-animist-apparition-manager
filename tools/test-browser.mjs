/** Run isolated DOM regression tests; requires a local Chromium/Chrome, not Foundry. */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = http.createServer(async (req, res) => {
    try {
        const file = path.resolve(root, `.${decodeURIComponent(new URL(req.url, "http://localhost").pathname)}`);
        if (!file.startsWith(`${root}${path.sep}`)) {
            res.writeHead(403).end();
            return;
        }
        const content = await fs.readFile(file);
        res.setHeader(
            "Content-Type",
            /\.(mjs|js)$/.test(file)
                ? "text/javascript"
                : file.endsWith(".html")
                  ? "text/html"
                  : file.endsWith(".css")
                    ? "text/css"
                    : "text/plain",
        );
        res.end(content);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
    const args = ["--headless", "--disable-gpu", "--virtual-time-budget=15000", "--dump-dom"];
    // Containers may lack the OS support for Chromium's sandbox. Opt-in only; do not disable it on normal desktops.
    if (process.env.BROWSER_TEST_NO_SANDBOX === "1") args.push("--no-sandbox");
    args.push(`http://127.0.0.1:${server.address().port}/tests/audit.html`);
    const binaries = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : ["chromium", "chromium-browser", "google-chrome", "chrome"];
    let dom;
    for (const binary of binaries) {
        try {
            dom = await new Promise((resolve, reject) => {
                const child = spawn(binary, args);
                let stdout = "";
                let stderr = "";
                const timeout = setTimeout(() => child.kill(), 90000);
                child.stdout.on("data", (chunk) => (stdout += chunk));
                child.stderr.on("data", (chunk) => (stderr += chunk));
                child.on("error", (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                child.on("close", (code) => {
                    clearTimeout(timeout);
                    if (code !== 0) reject(new Error(`Chromium exited ${code}: ${stderr.slice(-2000)}`));
                    else resolve(stdout);
                });
            });
            break;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    if (!dom) throw new Error("Chrome/Chromium not found. Set CHROME_BIN to the browser executable path.");
    const text = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
    if (!text || text === "RUNNING") throw new Error("Browser tests did not finish. Open tests/audit.html and check the browser console.");
    const decoded = text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    const results = JSON.parse(decoded);
    console.log(results.environment);
    console.log(`${results.pass} passed; ${results.fail} failed`);
    for (const test of results.tests.filter((entry) => !entry.pass)) console.error(`${test.name}\n${test.error}`);
    if (results.fail) process.exitCode = 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}
