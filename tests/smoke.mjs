import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const files = [
  "netlify/functions/bible.js",
  "netlify/functions/generate-sermon.js",
  "netlify/functions/pedia-research.js",
  "netlify/functions/text-to-speech.js",
  "netlify/functions/health.js",
  "netlify/functions/versiah.js",
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
}

const html = await readFile(join(root, "public/index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join("\n");
const temp = "/tmp/the-pulpit-frontend-smoke.js";
await import("node:fs/promises").then(fs => fs.writeFile(temp, scripts));
const frontend = spawnSync(process.execPath, ["--check", temp], { encoding: "utf8" });
if (frontend.status !== 0) {
  console.error(frontend.stderr || frontend.stdout);
  process.exit(1);
}

if (/gsk-[A-Za-z0-9_-]{10,}|sk-or-v1-[A-Za-z0-9_-]{10,}/.test(html)) {
  throw new Error("Possible API key found in frontend source.");
}

const widget = await readFile(join(root, "public/versiah-widget.js"), "utf8");
const widgetTemp = "/tmp/the-pulpit-versiah-widget-smoke.js";
await import("node:fs/promises").then(fs => fs.writeFile(widgetTemp, widget));
const widgetCheck = spawnSync(process.execPath, ["--check", widgetTemp], { encoding: "utf8" });
if (widgetCheck.status !== 0) {
  console.error(widgetCheck.stderr || widgetCheck.stdout);
  process.exit(1);
}

console.log(`Smoke test passed: ${files.length} Netlify functions + frontend JavaScript + Versiah widget syntax checked.`);
