import JSZip, { type JSZipObject } from "jszip";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import type { MediaDisplaySettings, SceneConfig } from "../types";
import { listExtensions, type ExtensionRuntime, type InstalledExtension } from "./extensions";
import {
  deleteLibraryItem,
  getLibraryItem,
  saveMediaLibraryItem,
  saveSceneLibraryItem,
} from "./library";
import { migrateScene } from "./scene";
import { inTauri } from "./tauri";

const PACKAGE_FORMAT = "nova-display-scene-package";
const PACKAGE_VERSION = 2;
const SUPPORTED_PACKAGE_VERSIONS = new Set([1, PACKAGE_VERSION]);
const MAX_PACKAGE_FILE_BYTES = 96 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_COUNT = 64;

interface ScenePackageAssetV1 {
  originalId: string;
  path: string;
  name: string;
  kind: "image" | "gif" | "video";
  mimeType: string;
  size: number;
  mediaSettings: MediaDisplaySettings;
}

export interface SceneExtensionDependency {
  id: string;
  name: string;
  minimumVersion: string;
  runtime: ExtensionRuntime | "unknown";
}

export interface SceneExtensionDependencyStatus extends SceneExtensionDependency {
  status: "ready" | "missing" | "outdated" | "disabled";
  installedVersion?: string;
}

interface ScenePackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: 1 | typeof PACKAGE_VERSION;
  exportedAt: string;
  scene: SceneConfig;
  assets: ScenePackageAssetV1[];
  extensions: SceneExtensionDependency[];
}

const DEFAULT_MEDIA_SETTINGS: MediaDisplaySettings = {
  fit: "contain",
  threshold: 128,
  dither: false,
  invert: false,
};

function safeFileName(value: string) {
  const name = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  return (name || "scene").slice(0, 64);
}

function zipEntrySize(entry: JSZipObject) {
  return Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
}

function isAssetKind(value: unknown): value is ScenePackageAssetV1["kind"] {
  return value === "image" || value === "gif" || value === "video";
}

function extensionIdsFromScene(scene: SceneConfig) {
  return [...new Set(scene.layers.flatMap(layer => {
    const ids: string[] = [];
    if (layer.type === "extension" && layer.extensionId) ids.push(layer.extensionId);
    if (layer.source === "extension" && layer.valueVariable?.includes(".")) ids.push(layer.valueVariable.slice(0, layer.valueVariable.lastIndexOf(".")));
    return ids;
  }))];
}

function dependency(value: unknown): SceneExtensionDependency {
  if (!value || typeof value !== "object") throw new Error("场景包扩展依赖信息无效");
  const source = value as Partial<SceneExtensionDependency>;
  if (typeof source.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(source.id)) throw new Error("场景包扩展依赖 ID 无效");
  return {
    id: source.id.slice(0, 80),
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 64) : source.id,
    minimumVersion: typeof source.minimumVersion === "string" ? source.minimumVersion.trim().slice(0, 24) : "",
    runtime: source.runtime === "quickjs" || source.runtime === "provider" ? source.runtime : "unknown",
  };
}

function parseManifest(value: unknown): ScenePackageManifest {
  if (!value || typeof value !== "object") throw new Error("场景包清单格式无效");
  const manifest = value as Partial<ScenePackageManifest>;
  if (manifest.format !== PACKAGE_FORMAT) throw new Error("这不是 Nova Display 场景包");
  if (!SUPPORTED_PACKAGE_VERSIONS.has(Number(manifest.version))) throw new Error(`暂不支持场景包版本 ${String(manifest.version)}`);
  if (!Array.isArray(manifest.assets) || manifest.assets.length > MAX_ASSET_COUNT) throw new Error("场景包素材数量无效");
  const assets = manifest.assets.map((asset, index) => {
    if (!asset || typeof asset !== "object") throw new Error(`第 ${index + 1} 个素材信息无效`);
    const item = asset as Partial<ScenePackageAssetV1>;
    if (!item.originalId || !item.path?.startsWith("assets/") || !item.name || !isAssetKind(item.kind)) {
      throw new Error(`第 ${index + 1} 个素材信息不完整`);
    }
    const size = Math.round(Number(item.size));
    if (!Number.isFinite(size) || size < 0 || size > MAX_TOTAL_ASSET_BYTES) throw new Error(`素材“${item.name}”大小无效`);
    return {
      originalId: item.originalId,
      path: item.path,
      name: item.name.slice(0, 180),
      kind: item.kind,
      mimeType: item.mimeType || "application/octet-stream",
      size,
      mediaSettings: { ...DEFAULT_MEDIA_SETTINGS, ...item.mediaSettings },
    };
  });
  if (assets.reduce((sum, asset) => sum + asset.size, 0) > MAX_TOTAL_ASSET_BYTES) throw new Error("场景包素材总大小不能超过 64 MB");
  const scene = migrateScene(manifest.scene);
  if (Number(manifest.version) >= 2 && !Array.isArray(manifest.extensions)) throw new Error("场景包缺少扩展依赖清单");
  const dependencies = Number(manifest.version) >= 2
    ? manifest.extensions!.slice(0, 64).map(dependency)
    : extensionIdsFromScene(scene).map(id => ({ id, name: id, minimumVersion: "", runtime: "unknown" as const }));
  if (new Set(dependencies.map(item => item.id)).size !== dependencies.length) throw new Error("场景包包含重复的扩展依赖");
  return {
    format: PACKAGE_FORMAT,
    version: Number(manifest.version) as 1 | typeof PACKAGE_VERSION,
    exportedAt: typeof manifest.exportedAt === "string" ? manifest.exportedAt : "",
    scene,
    assets,
    extensions: dependencies,
  };
}

export function compareExtensionVersions(first: string, second: string) {
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
  const left = first.match(semver);
  const right = second.match(semver);
  if (left && right) {
    for (let index = 1; index <= 3; index += 1) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference) return Math.sign(difference);
    }
    if (!left[4] && right[4]) return 1;
    if (left[4] && !right[4]) return -1;
    if (left[4] !== right[4]) return left[4]!.localeCompare(right[4]!, undefined, { numeric: true, sensitivity: "base" });
    return 0;
  }
  return first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" });
}

export function assessSceneExtensionDependencies(dependencies: SceneExtensionDependency[], installed: InstalledExtension[]): SceneExtensionDependencyStatus[] {
  return dependencies.map(requirement => {
    const item = installed.find(extension => extension.id === requirement.id);
    if (!item) return { ...requirement, status: "missing" };
    const installedVersion = item.manifest.version;
    if (requirement.minimumVersion && compareExtensionVersions(installedVersion, requirement.minimumVersion) < 0) {
      return { ...requirement, status: "outdated", installedVersion };
    }
    if (!item.enabled) return { ...requirement, status: "disabled", installedVersion };
    return { ...requirement, status: "ready", installedVersion };
  });
}

export async function createScenePackage(scene: SceneConfig) {
  const snapshot = migrateScene(scene);
  const installedExtensions = await listExtensions();
  const extensions = extensionIdsFromScene(snapshot).map(id => {
    const installed = installedExtensions.find(item => item.id === id);
    return {
      id,
      name: installed?.manifest.name ?? id,
      minimumVersion: installed?.manifest.version ?? "",
      runtime: installed?.manifest.runtime ?? "unknown",
    } satisfies SceneExtensionDependency;
  });
  const assetIds = [...new Set(snapshot.layers.map(layer => layer.assetId).filter((id): id is string => Boolean(id)))];
  const zip = new JSZip();
  const assets: ScenePackageAssetV1[] = [];
  let totalBytes = 0;

  for (const [index, assetId] of assetIds.entries()) {
    const item = await getLibraryItem(assetId);
    if (!item?.blob || !isAssetKind(item.kind)) throw new Error(`场景引用的素材“${assetId}”已不存在`);
    totalBytes += item.blob.size;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error("场景引用的素材总大小不能超过 64 MB");
    const path = `assets/${String(index + 1).padStart(2, "0")}-${safeFileName(item.name)}`;
    zip.file(path, await item.blob.arrayBuffer());
    assets.push({
      originalId: item.id,
      path,
      name: item.name,
      kind: item.kind,
      mimeType: item.mimeType,
      size: item.blob.size,
      mediaSettings: { ...DEFAULT_MEDIA_SETTINGS, ...item.mediaSettings },
    });
  }

  const manifest: ScenePackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    scene: snapshot,
    assets,
    extensions,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  return { blob, fileName: `${safeFileName(snapshot.name)}.nova-oled` };
}

function downloadScenePackage(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function saveScenePackage(blob: Blob, fileName: string) {
  if (!inTauri()) {
    downloadScenePackage(blob, fileName);
    return true;
  }
  const path = await save({
    defaultPath: fileName,
    filters: [{ name: "Nova Display 场景包", extensions: ["nova-oled"] }],
  });
  if (!path) return false;
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

export async function chooseScenePackage() {
  if (!inTauri()) return undefined;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Nova Display 场景包", extensions: ["nova-oled"] }],
  });
  if (!path) return undefined;
  const data = await readFile(path);
  const name = path.split(/[\\/]/).pop() || "scene.nova-oled";
  return new File([data], name, { type: "application/zip" });
}

export async function importScenePackage(file: File) {
  if (file.size > MAX_PACKAGE_FILE_BYTES) throw new Error("场景包不能超过 96 MB");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry || zipEntrySize(manifestEntry) > MAX_MANIFEST_BYTES) throw new Error("场景包缺少有效的 manifest.json");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new Error("场景包清单无法解析");
  }
  const manifest = parseManifest(manifestValue);
  const importedAssetIds: string[] = [];
  const assetIdMap = new Map<string, string>();

  try {
    for (const asset of manifest.assets) {
      const entry = zip.file(asset.path);
      if (!entry || zipEntrySize(entry) !== asset.size) throw new Error(`素材“${asset.name}”缺失或大小不一致`);
      const bytes = await entry.async("uint8array");
      const imported = await saveMediaLibraryItem(new File([bytes], asset.name, { type: asset.mimeType }), asset.mediaSettings);
      importedAssetIds.push(imported.id);
      assetIdMap.set(asset.originalId, imported.id);
    }
    manifest.scene.layers.forEach(layer => {
      if (layer.assetId) layer.assetId = assetIdMap.get(layer.assetId);
    });
    const item = await saveSceneLibraryItem(manifest.scene);
    const dependencies = assessSceneExtensionDependencies(manifest.extensions, await listExtensions());
    return { item, dependencies };
  } catch (error) {
    await Promise.all(importedAssetIds.map(id => deleteLibraryItem(id).catch(() => undefined)));
    throw error;
  }
}

export function isScenePackageFile(file: File) {
  return file.name.toLowerCase().endsWith(".nova-oled");
}
