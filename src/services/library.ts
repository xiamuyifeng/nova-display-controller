import type { AutomationPlan, MediaDisplaySettings, SceneConfig } from "../types";
import { migrateScene } from "./scene";

export type LibraryItemKind = "image" | "gif" | "video" | "text" | "scene" | "playlist";

export interface LibraryItem {
  id: string;
  kind: LibraryItemKind;
  name: string;
  createdAt: number;
  mimeType: string;
  favorite?: boolean;
  blob?: Blob;
  text?: string;
  fontSize?: number;
  align?: "left" | "center";
  mediaSettings?: MediaDisplaySettings;
  scene?: SceneConfig;
  playlist?: AutomationPlan;
}

const DATABASE_NAME = "steelseries-oled-library";
const STORE_NAME = "items";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地主题库操作失败"));
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地主题库"));
  });
}

async function runStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    return await requestResult(action(transaction.objectStore(STORE_NAME)));
  } finally {
    database.close();
  }
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `library-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function listLibraryItems() {
  const items = await runStore<LibraryItem[]>("readonly", store => store.getAll());
  return items.map(normalizeLibraryItem).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getLibraryItem(id: string) {
  const item = await runStore<LibraryItem | undefined>("readonly", store => store.get(id));
  return item ? normalizeLibraryItem(item) : undefined;
}

function normalizeLibraryItem(item: LibraryItem) {
  if (item.kind === "scene" && item.scene) item.scene = migrateScene(item.scene, item.name);
  return item;
}

export async function saveMediaLibraryItem(file: File, mediaSettings: MediaDisplaySettings) {
  if (file.size > MAX_ASSET_BYTES) throw new Error("单个素材不能超过 64 MB");
  const lowerName = file.name.toLowerCase();
  const kind: LibraryItemKind = file.type.startsWith("video/")
    ? "video"
    : file.type === "image/gif" || lowerName.endsWith(".gif") ? "gif" : "image";
  const item: LibraryItem = {
    id: createId(),
    kind,
    name: file.name,
    createdAt: Date.now(),
    mimeType: file.type || "application/octet-stream",
    blob: file,
    mediaSettings: structuredClone(mediaSettings),
  };
  await runStore("readwrite", store => store.put(item));
  return item;
}

export async function saveTextLibraryItem(text: string, fontSize: number, align: "left" | "center") {
  const cleanText = text.trim();
  if (!cleanText) throw new Error("请输入文字后再保存");
  const item: LibraryItem = {
    id: createId(),
    kind: "text",
    name: cleanText.replace(/\s+/g, " ").slice(0, 24),
    createdAt: Date.now(),
    mimeType: "text/plain",
    text,
    fontSize,
    align,
  };
  await runStore("readwrite", store => store.put(item));
  return item;
}

export async function updateMediaLibrarySettings(id: string, mediaSettings: MediaDisplaySettings) {
  const item = await getLibraryItem(id);
  if (!item || !["image", "gif", "video"].includes(item.kind)) return;
  item.mediaSettings = structuredClone(mediaSettings);
  await runStore("readwrite", store => store.put(item));
}

export async function setLibraryItemFavorite(id: string, favorite: boolean) {
  const item = await getLibraryItem(id);
  if (!item) throw new Error("主题不存在或已被删除");
  item.favorite = favorite;
  await runStore("readwrite", store => store.put(item));
  return item;
}

export async function duplicateLibraryItem(id: string) {
  const item = await getLibraryItem(id);
  if (!item || !["image", "gif", "video", "text"].includes(item.kind)) throw new Error("这个主题不能复制");
  const copy: LibraryItem = {
    ...item,
    id: createId(),
    name: `${item.name} 副本`.slice(0, 180),
    createdAt: Date.now(),
    favorite: false,
    mediaSettings: item.mediaSettings ? structuredClone(item.mediaSettings) : undefined,
  };
  await runStore("readwrite", store => store.put(copy));
  return copy;
}

export async function saveSceneLibraryItem(scene: SceneConfig, existingId?: string) {
  const cleanName = scene.name.trim();
  if (!cleanName) throw new Error("请输入场景名称后再保存");
  const previous = existingId ? await getLibraryItem(existingId) : undefined;
  const sceneSnapshot = migrateScene(JSON.parse(JSON.stringify(scene)));
  sceneSnapshot.name = cleanName;
  const item: LibraryItem = {
    id: previous?.kind === "scene" ? previous.id : createId(),
    kind: "scene",
    name: cleanName,
    createdAt: previous?.kind === "scene" ? previous.createdAt : Date.now(),
    mimeType: "application/json",
    favorite: previous?.kind === "scene" ? previous.favorite : false,
    scene: sceneSnapshot,
  };
  await runStore("readwrite", store => store.put(item));
  return item;
}

export async function removeAssetFromSavedScenes(assetId: string) {
  const items = await listLibraryItems();
  const scenes = items.filter(item => item.kind === "scene" && item.scene?.layers.some(layer => layer.assetId === assetId));
  await Promise.all(scenes.map(item => {
    item.scene!.layers.forEach(layer => {
      if (layer.assetId === assetId) layer.assetId = undefined;
    });
    return runStore("readwrite", store => store.put(item));
  }));
  return scenes.length;
}

export async function saveAutomationLibraryItem(plan: AutomationPlan, existingId?: string) {
  const cleanName = plan.name.trim();
  if (!cleanName) throw new Error("请输入编排名称后再保存");
  if (!plan.entries.length) throw new Error("请至少添加一个编排项目");
  const previous = existingId ? await getLibraryItem(existingId) : undefined;
  const snapshot = JSON.parse(JSON.stringify(plan)) as AutomationPlan;
  snapshot.name = cleanName;
  snapshot.entries = snapshot.entries.map(entry => ({
    ...entry,
    duration: Math.max(2, Math.min(3600, Math.round(entry.duration || 10))),
  }));
  snapshot.triggers = (snapshot.triggers ?? []).filter(trigger => trigger?.entry).map(trigger => ({
    ...trigger,
    threshold: trigger.type === "batteryLow"
      ? Math.max(5, Math.min(50, Math.round(trigger.threshold ?? 20)))
      : undefined,
    entry: {
      ...trigger.entry,
      duration: Math.max(2, Math.min(3600, Math.round(trigger.entry.duration || 10))),
    },
  }));
  const item: LibraryItem = {
    id: previous?.kind === "playlist" ? previous.id : createId(),
    kind: "playlist",
    name: cleanName,
    createdAt: previous?.kind === "playlist" ? previous.createdAt : Date.now(),
    mimeType: "application/json",
    playlist: snapshot,
  };
  await runStore("readwrite", store => store.put(item));
  return item;
}

export async function removeItemFromSavedPlaylists(libraryId: string) {
  const items = await listLibraryItems();
  const playlists = items.filter(item => item.kind === "playlist" && (
    item.playlist?.entries.some(entry => entry.libraryId === libraryId)
    || item.playlist?.triggers?.some(trigger => trigger.entry.libraryId === libraryId)
  ));
  await Promise.all(playlists.map(item => {
    item.playlist!.entries = item.playlist!.entries.filter(entry => entry.libraryId !== libraryId);
    item.playlist!.triggers = item.playlist!.triggers?.filter(trigger => trigger.entry.libraryId !== libraryId);
    return runStore("readwrite", store => store.put(item));
  }));
  return playlists.length;
}

export async function deleteLibraryItem(id: string) {
  await runStore("readwrite", store => store.delete(id));
}
