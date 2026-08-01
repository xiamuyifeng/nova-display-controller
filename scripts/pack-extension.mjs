import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";

const sourceArgument = process.argv[2];
if (!sourceArgument) throw new Error("Usage: npm run pack:extension -- <extension-directory>");

const sourceDirectory = path.resolve(sourceArgument);
const manifestPath = path.join(sourceDirectory, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
if (manifest.format !== "nova-display-extension" || ![1, 2].includes(manifest.apiVersion)) throw new Error("Invalid extension manifest format or API version");
if (typeof manifest.id !== "string" || typeof manifest.version !== "string") throw new Error("Manifest must include id and version");

const entries = manifest.apiVersion === 1
  ? [manifest.entry]
  : Object.values(manifest.entry ?? {});
if (!entries.length || entries.some(entry => typeof entry !== "string" || entry.includes("..") || path.isAbsolute(entry))) {
  throw new Error("Extension entries must stay inside the extension directory");
}
for (const entry of entries) {
  const entryPath = path.resolve(sourceDirectory, entry);
  if (!entryPath.startsWith(`${sourceDirectory}${path.sep}`)) throw new Error("Extension entry resolves outside the extension directory");
  await fs.access(entryPath);
}

const zip = new JSZip();
zip.file("manifest.json", JSON.stringify(manifest, null, 2));
if (manifest.apiVersion === 1) {
  const source = await fs.readFile(path.resolve(sourceDirectory, manifest.entry));
  if (source.byteLength > 256 * 1024) throw new Error("Extension entry exceeds 256 KB");
  zip.file(manifest.entry.replaceAll("\\", "/"), source);
} else {
  async function addDirectory(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (absolute === manifestPath) continue;
      if (item.isDirectory()) await addDirectory(absolute);
      else if (item.isFile()) zip.file(path.relative(sourceDirectory, absolute).replaceAll("\\", "/"), await fs.readFile(absolute));
    }
  }
  if (Array.isArray(manifest.files) && manifest.files.length) {
    for (const file of manifest.files) {
      if (typeof file !== "string" || file.includes("..") || path.isAbsolute(file)) throw new Error("Manifest files must stay inside the extension directory");
      zip.file(file.replaceAll("\\", "/"), await fs.readFile(path.resolve(sourceDirectory, file)));
    }
  } else {
    await addDirectory(sourceDirectory);
  }
}
const outputDirectory = path.resolve("dist-extensions");
await fs.mkdir(outputDirectory, { recursive: true });
const safeId = manifest.id.replace(/[^a-z0-9.-]/gi, "_");
const safeVersion = manifest.version.replace(/[^a-z0-9.-]/gi, "_");
const outputPath = path.join(outputDirectory, `${safeId}-${safeVersion}.nova-extension`);
const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
if (output.byteLength > 64 * 1024 * 1024) throw new Error("Extension package exceeds 64 MB");
await fs.writeFile(outputPath, output);
console.log(outputPath);
