import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const target = process.argv[2];
if (!target) throw new Error("Usage: npm run check:extension -- <directory-or-package>");
const absolute = path.resolve(target);
const stat = await fs.stat(absolute);
let manifest;
let files;
if (stat.isDirectory()) {
  manifest = JSON.parse(await fs.readFile(path.join(absolute, "manifest.json"), "utf8"));
  files = new Set();
  async function collect(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const itemPath = path.join(directory, item.name);
      if (item.isDirectory()) await collect(itemPath);
      else files.add(path.relative(absolute, itemPath).replaceAll("\\", "/"));
    }
  }
  await collect(absolute);
} else {
  const zip = await JSZip.loadAsync(await fs.readFile(absolute));
  const entry = zip.file("manifest.json");
  if (!entry) throw new Error("Package is missing manifest.json");
  manifest = JSON.parse(await entry.async("text"));
  files = new Set(Object.values(zip.files).filter(item => !item.dir).map(item => item.name));
}

const fail = message => { throw new Error(message); };
if (manifest.format !== "nova-display-extension") fail("Invalid extension format");
if (![1, 2].includes(manifest.apiVersion)) fail("Unsupported API version");
if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id ?? "")) fail("Invalid reverse-domain extension ID");
if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.length) fail("At least one capability is required");
const definitions = [...(manifest.variables ?? []), ...(manifest.events ?? [])];
for (const definition of definitions) {
  if (!/^[a-z][a-z0-9_]*$/.test(definition.key ?? "")) fail(`Invalid definition key: ${definition.key}`);
}
if (new Set(definitions.map(item => item.key)).size !== definitions.length) fail("Variable and event keys must be unique");
const entries = typeof manifest.entry === "string" ? [manifest.entry] : Object.values(manifest.entry ?? {});
for (const entry of entries) {
  if (typeof entry !== "string" || entry.includes("..") || !files.has(entry.replaceAll("\\", "/"))) fail(`Missing or unsafe entry: ${entry}`);
}
if (manifest.apiVersion === 2) {
  if (manifest.runtime !== "provider" || manifest.protocol !== "nova-jsonl-v1") fail("API v2 requires provider runtime and nova-jsonl-v1");
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(["native.process"])) fail("Provider must declare only native.process");
}
console.log(JSON.stringify({ id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion, runtime: manifest.runtime ?? "quickjs", files: files.size }, null, 2));
