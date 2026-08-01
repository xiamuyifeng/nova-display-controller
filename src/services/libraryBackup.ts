import JSZip, { type JSZipObject } from "jszip";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import type { AutomationEntry, AutomationPlan, DisplayMode, MediaDisplaySettings, SceneConfig } from "../types";
import {
  deleteLibraryItem,
  listLibraryItems,
  saveAutomationLibraryItem,
  saveMediaLibraryItem,
  saveSceneLibraryItem,
  saveTextLibraryItem,
  setLibraryItemFavorite,
  type LibraryItem,
  type LibraryItemKind,
} from "./library";
import { migrateScene } from "./scene";
import { inTauri } from "./tauri";
import { deleteExtension, exportExtensionRecords, restoreExtensionRecords, type ExtensionBackupRecord } from "./extensions";

const BACKUP_FORMAT = "nova-display-library-backup";
const BACKUP_VERSION = 1;
const MAX_BACKUP_BYTES = 640 * 1024 * 1024;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 12 * 1024 * 1024;
const MAX_ITEM_COUNT = 512;
const MODES: DisplayMode[] = ["scene", "image", "media", "text", "clock", "system", "music"];
const MEDIA_KINDS: LibraryItemKind[] = ["image", "gif", "video"];

export interface BackupPreferences {
  autoConnect: boolean;
  fps: number;
  pixelShiftEnabled: boolean;
  staticSleepEnabled: boolean;
  staticSleepMinutes: number;
  currentScene: SceneConfig;
  currentSceneLibraryId: string;
  currentAutomationPlanId: string;
}

interface BackupItemV1 {
  id: string;
  kind: LibraryItemKind;
  name: string;
  favorite: boolean;
  mimeType: string;
  text?: string;
  fontSize?: number;
  align?: "left" | "center";
  mediaSettings?: MediaDisplaySettings;
  scene?: SceneConfig;
  playlist?: AutomationPlan;
  assetPath?: string;
  assetSize?: number;
}

interface BackupManifestV1 {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  preferences: BackupPreferences;
  items: BackupItemV1[];
  extensions?: ExtensionBackupRecord[];
}

export interface RestoreResult {
  itemCount: number;
  extensionCount: number;
  skippedExtensionCount: number;
  preferences: BackupPreferences;
}

const DEFAULT_MEDIA_SETTINGS: MediaDisplaySettings = {
  fit: "contain",
  threshold: 128,
  dither: true,
  invert: false,
};

function safeFileName(value: string) {
  const name = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  return (name || "asset").slice(0, 80);
}

function zipEntrySize(entry: JSZipObject) {
  return Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
}

function isKind(value: unknown): value is LibraryItemKind {
  return value === "image" || value === "gif" || value === "video" || value === "text" || value === "scene" || value === "playlist";
}

function mediaSettings(value: unknown): MediaDisplaySettings {
  const source = value && typeof value === "object" ? value as Partial<MediaDisplaySettings> : {};
  return {
    fit: source.fit === "cover" || source.fit === "stretch" ? source.fit : "contain",
    threshold: Math.max(0, Math.min(255, Math.round(Number(source.threshold) || 128))),
    dither: source.dither !== false,
    invert: source.invert === true,
  };
}

function automationEntry(value: unknown): AutomationEntry {
  if (!value || typeof value !== "object") throw new Error("备份中的场景编排项目无效");
  const source = value as Partial<AutomationEntry>;
  if (!MODES.includes(source.mode as DisplayMode) || typeof source.name !== "string") throw new Error("备份中的场景编排项目不完整");
  return {
    id: typeof source.id === "string" && source.id ? source.id : crypto.randomUUID(),
    mode: source.mode as DisplayMode,
    libraryId: typeof source.libraryId === "string" ? source.libraryId : undefined,
    name: source.name.slice(0, 180),
    duration: Math.max(2, Math.min(3600, Math.round(Number(source.duration) || 10))),
  };
}

function automationPlan(value: unknown): AutomationPlan {
  if (!value || typeof value !== "object") throw new Error("备份中的场景编排无效");
  const source = value as Partial<AutomationPlan>;
  if (typeof source.name !== "string" || !Array.isArray(source.entries)) throw new Error("备份中的场景编排不完整");
  const triggers = Array.isArray(source.triggers) ? source.triggers.map(trigger => {
    if (!trigger || (trigger.type !== "playing" && trigger.type !== "batteryLow" && trigger.type !== "extensionEvent")) throw new Error("备份中的触发条件无效");
    if (trigger.type === "extensionEvent" && (typeof trigger.extensionId !== "string" || typeof trigger.eventKey !== "string")) {
      throw new Error("备份中的扩展事件触发条件不完整");
    }
    return {
      id: typeof trigger.id === "string" && trigger.id ? trigger.id : crypto.randomUUID(),
      type: trigger.type,
      entry: automationEntry(trigger.entry),
      threshold: trigger.type === "batteryLow" ? Math.max(5, Math.min(50, Math.round(Number(trigger.threshold) || 20))) : undefined,
      extensionId: trigger.type === "extensionEvent" && typeof trigger.extensionId === "string" ? trigger.extensionId.slice(0, 80) : undefined,
      eventKey: trigger.type === "extensionEvent" && typeof trigger.eventKey === "string" ? trigger.eventKey.slice(0, 48) : undefined,
    };
  }) : [];
  return { name: source.name.slice(0, 180), entries: source.entries.map(automationEntry), triggers };
}

function parseManifest(value: unknown): BackupManifestV1 {
  if (!value || typeof value !== "object") throw new Error("备份清单格式无效");
  const source = value as Partial<BackupManifestV1>;
  if (source.format !== BACKUP_FORMAT) throw new Error("这不是 Nova Display 完整备份");
  if (source.version !== BACKUP_VERSION) throw new Error(`暂不支持备份版本 ${String(source.version)}`);
  if (!Array.isArray(source.items) || source.items.length > MAX_ITEM_COUNT) throw new Error("备份项目数量无效");
  if (!source.preferences || typeof source.preferences !== "object") throw new Error("备份缺少应用偏好");

  const ids = new Set<string>();
  const items = source.items.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`第 ${index + 1} 个备份项目无效`);
    const item = value as Partial<BackupItemV1>;
    if (!item.id || ids.has(item.id) || !isKind(item.kind) || typeof item.name !== "string") throw new Error(`第 ${index + 1} 个备份项目不完整`);
    ids.add(item.id);
    const parsed: BackupItemV1 = {
      id: item.id,
      kind: item.kind,
      name: item.name.slice(0, 180),
      favorite: item.favorite === true,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
    };
    if (MEDIA_KINDS.includes(item.kind)) {
      const size = Math.round(Number(item.assetSize));
      if (!item.assetPath?.startsWith("assets/") || !Number.isFinite(size) || size < 0 || size > MAX_ASSET_BYTES) {
        throw new Error(`素材“${parsed.name}”的信息无效`);
      }
      parsed.assetPath = item.assetPath;
      parsed.assetSize = size;
      parsed.mediaSettings = mediaSettings(item.mediaSettings);
    } else if (item.kind === "text") {
      parsed.text = typeof item.text === "string" ? item.text : "";
      parsed.fontSize = Math.max(6, Math.min(64, Math.round(Number(item.fontSize) || 20)));
      parsed.align = item.align === "left" ? "left" : "center";
    } else if (item.kind === "scene") {
      parsed.scene = migrateScene(item.scene, parsed.name);
    } else {
      parsed.playlist = automationPlan(item.playlist);
    }
    return parsed;
  });

  const totalSize = items.reduce((sum, item) => sum + (item.assetSize ?? 0), 0);
  if (totalSize > MAX_ASSET_BYTES) throw new Error("备份中的素材总大小不能超过 512 MB");
  const preferences = source.preferences as Partial<BackupPreferences>;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: typeof source.exportedAt === "string" ? source.exportedAt : "",
    preferences: {
      autoConnect: preferences.autoConnect !== false,
      fps: [5, 10, 15, 20, 30].includes(Number(preferences.fps)) ? Number(preferences.fps) : 10,
      pixelShiftEnabled: preferences.pixelShiftEnabled === true,
      staticSleepEnabled: preferences.staticSleepEnabled === true,
      staticSleepMinutes: [5, 10, 30, 60].includes(Number(preferences.staticSleepMinutes)) ? Number(preferences.staticSleepMinutes) : 10,
      currentScene: migrateScene(preferences.currentScene),
      currentSceneLibraryId: typeof preferences.currentSceneLibraryId === "string" ? preferences.currentSceneLibraryId : "",
      currentAutomationPlanId: typeof preferences.currentAutomationPlanId === "string" ? preferences.currentAutomationPlanId : "",
    },
    items,
    extensions: Array.isArray(source.extensions) ? source.extensions : [],
  };
}

function remapScene(scene: SceneConfig, ids: Map<string, string>) {
  const result = migrateScene(scene);
  result.layers.forEach(layer => {
    if (layer.assetId) layer.assetId = ids.get(layer.assetId);
  });
  return result;
}

function remapEntry(entry: AutomationEntry, ids: Map<string, string>) {
  const copy = structuredClone(entry);
  if (copy.libraryId) {
    const mapped = ids.get(copy.libraryId);
    if (!mapped) throw new Error(`场景编排引用的主题“${copy.name}”不在备份中`);
    copy.libraryId = mapped;
  }
  return copy;
}

function remapPlan(plan: AutomationPlan, ids: Map<string, string>) {
  const copy = structuredClone(plan);
  copy.entries = copy.entries.map(entry => remapEntry(entry, ids));
  copy.triggers = copy.triggers?.map(trigger => ({ ...trigger, entry: remapEntry(trigger.entry, ids) }));
  return copy;
}

export async function createLibraryBackup(preferences: BackupPreferences) {
  const items = await listLibraryItems();
  const extensions = await exportExtensionRecords();
  if (items.length > MAX_ITEM_COUNT) throw new Error(`主题库项目不能超过 ${MAX_ITEM_COUNT} 个`);
  if (extensions.length > 128) throw new Error("扩展数量不能超过 128 个");
  if (extensions.reduce((sum, item) => sum + new TextEncoder().encode(item.source).byteLength, 0) > 8 * 1024 * 1024) {
    throw new Error("扩展源码总大小不能超过 8 MB");
  }
  const zip = new JSZip();
  const records: BackupItemV1[] = [];
  let totalBytes = 0;
  let assetIndex = 0;

  for (const item of items) {
    const record: BackupItemV1 = {
      id: item.id,
      kind: item.kind,
      name: item.name,
      favorite: item.favorite === true,
      mimeType: item.mimeType,
      text: item.text,
      fontSize: item.fontSize,
      align: item.align,
      mediaSettings: item.mediaSettings,
      scene: item.scene,
      playlist: item.playlist,
    };
    if (MEDIA_KINDS.includes(item.kind)) {
      if (!item.blob) throw new Error(`素材“${item.name}”缺少文件内容`);
      totalBytes += item.blob.size;
      if (totalBytes > MAX_ASSET_BYTES) throw new Error("主题库素材总大小不能超过 512 MB");
      assetIndex += 1;
      record.assetPath = `assets/${String(assetIndex).padStart(3, "0")}-${safeFileName(item.name)}`;
      record.assetSize = item.blob.size;
      zip.file(record.assetPath, await item.blob.arrayBuffer());
    }
    records.push(record);
  }

  const manifest: BackupManifestV1 = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    preferences: { ...preferences, currentScene: migrateScene(preferences.currentScene) },
    items: records,
    extensions,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const date = new Date().toISOString().slice(0, 10);
  return { blob, fileName: `nova-display-backup-${date}.nova-backup`, itemCount: items.length, extensionCount: extensions.length };
}

function downloadBackup(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function saveLibraryBackup(blob: Blob, fileName: string) {
  if (!inTauri()) {
    downloadBackup(blob, fileName);
    return true;
  }
  const path = await save({
    defaultPath: fileName,
    filters: [{ name: "Nova Display 完整备份", extensions: ["nova-backup"] }],
  });
  if (!path) return false;
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return true;
}

export async function chooseLibraryBackup() {
  if (!inTauri()) return undefined;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Nova Display 完整备份", extensions: ["nova-backup"] }],
  });
  if (!path) return undefined;
  const data = await readFile(path);
  const name = path.split(/[\\/]/).pop() || "nova-display.nova-backup";
  return new File([data], name, { type: "application/zip" });
}

export async function restoreLibraryBackup(file: File): Promise<RestoreResult> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error("备份文件不能超过 640 MB");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry || zipEntrySize(manifestEntry) > MAX_MANIFEST_BYTES) throw new Error("备份缺少有效的 manifest.json");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new Error("备份清单无法解析");
  }
  const manifest = parseManifest(manifestValue);
  const importedIds: string[] = [];
  const idMap = new Map<string, string>();
  let restoredExtensions: Awaited<ReturnType<typeof restoreExtensionRecords>> = { imported: 0, skipped: 0, importedIds: [] };

  try {
    restoredExtensions = await restoreExtensionRecords(manifest.extensions ?? []);
    for (const record of manifest.items.filter(item => MEDIA_KINDS.includes(item.kind))) {
      const entry = zip.file(record.assetPath!);
      if (!entry || zipEntrySize(entry) !== record.assetSize) throw new Error(`素材“${record.name}”缺失或大小不一致`);
      const bytes = await entry.async("uint8array");
      const item = await saveMediaLibraryItem(new File([bytes], record.name, { type: record.mimeType }), record.mediaSettings ?? DEFAULT_MEDIA_SETTINGS);
      importedIds.push(item.id);
      idMap.set(record.id, item.id);
      if (record.favorite) await setLibraryItemFavorite(item.id, true);
    }
    for (const record of manifest.items.filter(item => item.kind === "text")) {
      const item = await saveTextLibraryItem(record.text ?? "", record.fontSize ?? 20, record.align ?? "center");
      importedIds.push(item.id);
      idMap.set(record.id, item.id);
      if (record.favorite) await setLibraryItemFavorite(item.id, true);
    }
    for (const record of manifest.items.filter(item => item.kind === "scene")) {
      const item = await saveSceneLibraryItem(remapScene(record.scene!, idMap));
      importedIds.push(item.id);
      idMap.set(record.id, item.id);
      if (record.favorite) await setLibraryItemFavorite(item.id, true);
    }
    for (const record of manifest.items.filter(item => item.kind === "playlist")) {
      const item = await saveAutomationLibraryItem(remapPlan(record.playlist!, idMap));
      importedIds.push(item.id);
      idMap.set(record.id, item.id);
    }

    return {
      itemCount: importedIds.length,
      extensionCount: restoredExtensions.imported,
      skippedExtensionCount: restoredExtensions.skipped,
      preferences: {
        ...manifest.preferences,
        currentScene: remapScene(manifest.preferences.currentScene, idMap),
        currentSceneLibraryId: idMap.get(manifest.preferences.currentSceneLibraryId) ?? "",
        currentAutomationPlanId: idMap.get(manifest.preferences.currentAutomationPlanId) ?? "",
      },
    };
  } catch (error) {
    await Promise.all(importedIds.map(id => deleteLibraryItem(id).catch(() => undefined)));
    await Promise.all(restoredExtensions.importedIds.map(id => deleteExtension(id).catch(() => undefined)));
    throw error;
  }
}

export function isLibraryBackupFile(file: File) {
  return file.name.toLowerCase().endsWith(".nova-backup");
}
