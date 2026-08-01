import JSZip, { type JSZipObject } from "jszip";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { api, inTauri } from "./tauri";

const DATABASE_NAME = "nova-display-extensions";
const STORE_NAME = "extensions";
const PACKAGE_FORMAT = "nova-display-extension";
const MAX_QUICKJS_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_PIXELS = 128 * 64;

export type ExtensionCapability = "variables" | "renderer" | "events";
export type ExtensionRuntime = "quickjs" | "provider";
export type ExtensionSettingValue = string | number | boolean;

export interface ExtensionVariableDefinition {
  key: string;
  label: string;
}

export interface ExtensionEventDefinition {
  key: string;
  label: string;
}

export interface ExtensionSettingDefinition {
  key: string;
  label: string;
  type: "range" | "number" | "toggle" | "select";
  default: ExtensionSettingValue;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ label: string; value: string }>;
}

export interface ExtensionManifest {
  format: typeof PACKAGE_FORMAT;
  apiVersion: 1 | 2;
  runtime: ExtensionRuntime;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  entry: string | { windows?: string; linux?: string; macos?: string };
  protocol?: "nova-jsonl-v1";
  capabilities: ExtensionCapability[];
  variables: ExtensionVariableDefinition[];
  events: ExtensionEventDefinition[];
  renderer?: {
    label: string;
    settings: ExtensionSettingDefinition[];
  };
  permissions: string[];
}

export interface InstalledExtension {
  id: string;
  manifest: ExtensionManifest;
  source: string;
  enabled: boolean;
  installedAt: number;
}

export interface ExtensionBackupRecord {
  manifest: ExtensionManifest;
  source: string;
  enabled: boolean;
}

export interface ExtensionRuntimeInput {
  timeMs: number;
  cpu: number;
  memory: number;
  battery: number | null;
  spareBattery: number | null;
  volume: number;
  track: string;
  artist: string;
  progress: number;
  playing: boolean;
  headsetConnected: boolean;
}

export interface ExtensionRenderRequest {
  layerId: string;
  extensionId: string;
  width: number;
  height: number;
  settings: Record<string, ExtensionSettingValue>;
}

export interface ExtensionRuntimeResult {
  variables: Record<string, string>;
  pixels: Record<string, number[]>;
  errors: string[];
  errorDetails: Array<{ extensionId: string; message: string }>;
}

interface RawRuntimeResult {
  variables?: unknown;
  renders?: unknown;
  events?: unknown;
}

interface WorkerResponse {
  id: number;
  result?: RawRuntimeResult;
  error?: string;
}

interface ParsedExtensionPackage {
  zip: JSZip;
  manifest: ExtensionManifest;
  rawManifest: unknown;
}

let worker: Worker | undefined;
let requestId = 0;
let runtimeExtensionsCache: InstalledExtension[] | undefined;
const pending = new Map<number, { resolve: (value: RawRuntimeResult) => void; reject: (reason: Error) => void; timer: number }>();
const providerInFlight = new Map<string, Promise<RawRuntimeResult>>();
const providerLastResult = new Map<string, RawRuntimeResult>();
const providerRetryAfter = new Map<string, number>();
const activeProviderIds = new Set<string>();

function notifyExtensionsChanged() {
  globalThis.dispatchEvent?.(new Event("nova-extensions-changed"));
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("扩展库操作失败"));
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开扩展库"));
  });
}

async function runStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDatabase();
  try {
    return await requestResult(action(database.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
  } finally {
    database.close();
  }
}

function zipEntrySize(entry: JSZipObject) {
  return Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
}

function string(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`扩展清单缺少 ${field}`);
  return value.trim().slice(0, maxLength);
}

function extensionKey(value: unknown, field = "key") {
  const key = string(value, field, 48);
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`${field} 只能使用小写字母、数字和下划线`);
  return key;
}

function settingDefinition(value: unknown): ExtensionSettingDefinition {
  if (!value || typeof value !== "object") throw new Error("扩展设置定义无效");
  const source = value as Partial<ExtensionSettingDefinition>;
  const type = source.type;
  if (type !== "range" && type !== "number" && type !== "toggle" && type !== "select") throw new Error("扩展设置类型无效");
  const result: ExtensionSettingDefinition = {
    key: extensionKey(source.key, "设置 key"),
    label: string(source.label, "设置名称", 32),
    type,
    default: type === "toggle" ? source.default === true : type === "select" ? String(source.default ?? "") : Number(source.default) || 0,
  };
  if (type === "range" || type === "number") {
    result.min = Number.isFinite(Number(source.min)) ? Number(source.min) : 0;
    result.max = Number.isFinite(Number(source.max)) ? Number(source.max) : 100;
    result.step = Math.max(0.01, Number(source.step) || 1);
    if (result.min > result.max) [result.min, result.max] = [result.max, result.min];
    result.default = Math.max(result.min, Math.min(result.max, Number(result.default)));
  }
  if (type === "select") {
    result.options = Array.isArray(source.options) ? source.options.slice(0, 32).map(option => ({
      label: string(option?.label, "选项名称", 32),
      value: string(option?.value, "选项值", 48),
    })) : [];
    if (!result.options.length) throw new Error(`设置“${result.label}”缺少选项`);
    if (!result.options.some(option => option.value === result.default)) result.default = result.options[0].value;
  }
  return result;
}

export type ExtensionPlatform = "windows" | "linux" | "macos";

export function detectExtensionPlatform(
  platformHint = `${globalThis.navigator?.userAgent ?? ""} ${globalThis.navigator?.platform ?? ""}`,
  processPlatform = (globalThis as typeof globalThis & { process?: { platform?: string } }).process?.platform ?? "",
): ExtensionPlatform {
  if (/Windows|Win32|Win64/i.test(platformHint) || processPlatform === "win32") return "windows";
  if (/Linux/i.test(platformHint) || processPlatform === "linux") return "linux";
  if (/Macintosh|MacIntel|Mac OS/i.test(platformHint) || processPlatform === "darwin") return "macos";
  throw new Error("无法识别当前平台");
}

function parseManifest(value: unknown): ExtensionManifest {
  if (!value || typeof value !== "object") throw new Error("扩展清单格式无效");
  const source = value as Partial<ExtensionManifest>;
  if (source.format !== PACKAGE_FORMAT) throw new Error("这不是 Nova Display 扩展包");
  if (source.apiVersion !== 1 && source.apiVersion !== 2) throw new Error(`暂不支持扩展 API ${String(source.apiVersion)}`);
  const runtime: ExtensionRuntime = source.apiVersion === 1 ? "quickjs" : source.runtime === "provider" ? "provider" : source.runtime === "quickjs" ? "quickjs" : (() => { throw new Error("扩展 API v2 必须声明 runtime"); })();
  if (source.apiVersion === 1 && source.runtime && source.runtime !== "quickjs") throw new Error("扩展 API v1 只支持 QuickJS 沙箱");
  if (source.apiVersion === 2 && runtime !== "provider") throw new Error("扩展 API v2 当前用于原生 Provider 扩展");
  const id = string(source.id, "扩展 ID", 80);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(id)) throw new Error("扩展 ID 应使用反向域名格式，例如 com.example.clock");
  const capabilities = Array.isArray(source.capabilities)
    ? [...new Set(source.capabilities.filter((item): item is ExtensionCapability => item === "variables" || item === "renderer" || (runtime === "provider" && item === "events")))]
    : [];
  if (!capabilities.length) throw new Error("扩展至少需要 variables 或 renderer 能力");
  const variables = Array.isArray(source.variables) ? source.variables.slice(0, 32).map(item => ({
    key: extensionKey(item?.key, "变量 key"),
    label: string(item?.label, "变量名称", 32),
  })) : [];
  const events = Array.isArray(source.events) ? source.events.slice(0, 32).map(item => ({
    key: extensionKey(item?.key, "事件 key"),
    label: string(item?.label, "事件名称", 32),
  })) : [];
  const settings = source.renderer && Array.isArray(source.renderer.settings)
    ? source.renderer.settings.slice(0, 24).map(settingDefinition)
    : [];
  const permissions = Array.isArray(source.permissions) ? source.permissions.filter((item): item is string => typeof item === "string") : [];
  if (runtime === "quickjs" && permissions.length) throw new Error("QuickJS 扩展不开放系统权限，请移除 permissions");
  if (runtime === "provider" && (permissions.length !== 1 || permissions[0] !== "native.process")) {
    throw new Error("Provider 扩展必须且只能声明 native.process 权限");
  }
  let entry: ExtensionManifest["entry"];
  if (runtime === "quickjs") {
    entry = string(source.entry, "入口文件", 120);
  } else {
    if (!source.entry || typeof source.entry !== "object" || Array.isArray(source.entry)) throw new Error("Provider 扩展缺少平台入口");
    const entries = source.entry as Record<string, unknown>;
    entry = Object.fromEntries(["windows", "linux", "macos"]
      .filter(platform => entries[platform] !== undefined)
      .map(platform => [platform, string(entries[platform], `${platform} 入口`, 160)]));
    const platform = detectExtensionPlatform();
    if (!entry[platform as keyof typeof entry]) throw new Error(`此 Provider 扩展不支持当前平台：${platform}`);
  }
  const protocol = runtime === "provider" ? source.protocol : undefined;
  if (runtime === "provider" && protocol !== "nova-jsonl-v1") throw new Error(`暂不支持 Provider 协议 ${String(protocol)}`);
  return {
    format: PACKAGE_FORMAT,
    apiVersion: source.apiVersion,
    runtime,
    id,
    name: string(source.name, "扩展名称", 64),
    version: string(source.version, "扩展版本", 24),
    author: typeof source.author === "string" ? source.author.trim().slice(0, 64) : "未知作者",
    description: typeof source.description === "string" ? source.description.trim().slice(0, 240) : "",
    entry,
    protocol,
    capabilities,
    variables,
    events,
    renderer: capabilities.includes("renderer") ? {
      label: source.renderer?.label ? string(source.renderer.label, "绘图器名称", 32) : "扩展图层",
      settings,
    } : undefined,
    permissions,
  };
}

export async function listExtensions() {
  const items = await runStore<InstalledExtension[]>("readonly", store => store.getAll());
  if (items.some(item => item.id === "dev.nova.pulse")) {
    await runStore("readwrite", store => store.delete("dev.nova.pulse"));
    runtimeExtensionsCache = undefined;
  }
  return items.filter(item => item.id !== "dev.nova.pulse").map(normalizeInstalledExtension).sort((a, b) => b.installedAt - a.installedAt);
}

export async function getExtension(id: string) {
  if (id === "dev.nova.pulse") return undefined;
  const item = await runStore<InstalledExtension | undefined>("readonly", store => store.get(id));
  return item ? normalizeInstalledExtension(item) : undefined;
}

function normalizeInstalledExtension(item: InstalledExtension) {
  // API v1 records created before runtime was explicit are always QuickJS extensions.
  if (!item.manifest.runtime) item.manifest.runtime = "quickjs";
  if (!Array.isArray(item.manifest.events)) item.manifest.events = [];
  return item;
}

export async function setExtensionEnabled(id: string, enabled: boolean) {
  const item = await getExtension(id);
  if (!item) throw new Error("扩展不存在或已被删除");
  if (!enabled && item.manifest.runtime === "provider" && inTauri()) {
    await api.stopProvider(id);
    activeProviderIds.delete(id);
  }
  item.enabled = enabled;
  await runStore("readwrite", store => store.put(item));
  runtimeExtensionsCache = undefined;
  notifyExtensionsChanged();
  return item;
}

export async function deleteExtension(id: string) {
  const item = await getExtension(id);
  if (item?.manifest.runtime === "provider" && inTauri()) await api.removeProvider(id);
  await runStore("readwrite", store => store.delete(id));
  providerInFlight.delete(id);
  providerLastResult.delete(id);
  providerRetryAfter.delete(id);
  activeProviderIds.delete(id);
  runtimeExtensionsCache = undefined;
  notifyExtensionsChanged();
}

async function storeExtension(manifest: ExtensionManifest, source: string) {
  const previous = await getExtension(manifest.id);
  const item: InstalledExtension = {
    id: manifest.id,
    manifest,
    source,
    enabled: previous?.enabled ?? manifest.runtime === "quickjs",
    installedAt: Date.now(),
  };
  await runStore("readwrite", store => store.put(item));
  runtimeExtensionsCache = undefined;
  notifyExtensionsChanged();
  return { item, updated: Boolean(previous) };
}

async function parseExtensionPackage(file: File): Promise<ParsedExtensionPackage> {
  if (file.size > MAX_PROVIDER_PACKAGE_BYTES) throw new Error("扩展包不能超过 64 MB");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry || zipEntrySize(manifestEntry) > MAX_MANIFEST_BYTES) throw new Error("扩展包缺少有效的 manifest.json");
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(await manifestEntry.async("text"));
  } catch {
    throw new Error("扩展清单无法解析");
  }
  return { zip, manifest: parseManifest(manifestValue), rawManifest: manifestValue };
}

function safePackagePath(path: string) {
  return Boolean(path) && !path.includes("..") && !path.startsWith("/") && !path.startsWith("\\") && !/^[a-z]:/i.test(path);
}

export async function inspectExtensionPackage(file: File) {
  return (await parseExtensionPackage(file)).manifest;
}

export async function installExtensionPackage(file: File, approveNativeProvider = false) {
  const parsed = await parseExtensionPackage(file);
  const { manifest, zip } = parsed;
  if (manifest.runtime === "quickjs") {
    if (file.size > MAX_QUICKJS_PACKAGE_BYTES) throw new Error("QuickJS 扩展包不能超过 2 MB");
    const entry = manifest.entry as string;
    if (!safePackagePath(entry)) throw new Error("扩展入口路径无效");
    const sourceEntry = zip.file(entry);
    if (!sourceEntry || zipEntrySize(sourceEntry) > MAX_SOURCE_BYTES) throw new Error("扩展入口文件缺失或超过 256 KB");
    const source = await sourceEntry.async("text");
    if (!source.trim()) throw new Error("扩展入口文件为空");
    return storeExtension(manifest, source);
  }
  if (!approveNativeProvider) throw new Error("安装原生 Provider 前必须确认完全系统访问权限");
  if (!inTauri()) throw new Error("原生 Provider 只能安装在桌面应用中");
  const entries = Object.values(manifest.entry).filter((entry): entry is string => typeof entry === "string");
  if (entries.some(entry => !safePackagePath(entry) || !zip.file(entry))) throw new Error("Provider 入口路径无效或文件缺失");
  const files = [];
  let totalBytes = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!safePackagePath(path)) throw new Error(`扩展包包含无效路径：${path}`);
    const bytes = await entry.async("uint8array");
    totalBytes += bytes.byteLength;
    if (totalBytes > 128 * 1024 * 1024) throw new Error("Provider 解压后不能超过 128 MB");
    files.push({ path, bytes: Array.from(bytes) });
    if (files.length > 512) throw new Error("Provider 文件数量不能超过 512 个");
  }
  await api.installProvider(parsed.rawManifest, files);
  return storeExtension(manifest, "");
}

export async function chooseExtensionPackage() {
  if (!inTauri()) return undefined;
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Nova Display 扩展", extensions: ["nova-extension"] }],
  });
  if (!path) return undefined;
  const data = await readFile(path);
  return new File([data], path.split(/[\\/]/).pop() || "extension.nova-extension", { type: "application/zip" });
}

export async function loadBundledAudioProviderPackage() {
  const response = await fetch("/extensions/dev.nova.system-audio-1.1.0.nova-extension");
  if (!response.ok) throw new Error("内置音频频谱扩展文件缺失");
  const bytes = await response.arrayBuffer();
  return new File([bytes], "dev.nova.system-audio-1.1.0.nova-extension", { type: "application/zip" });
}

export async function loadBundledNetworkProviderPackage() {
  const response = await fetch("/extensions/dev.nova.system-network-1.0.0.nova-extension");
  if (!response.ok) throw new Error("内置网络吞吐扩展文件缺失");
  const bytes = await response.arrayBuffer();
  return new File([bytes], "dev.nova.system-network-1.0.0.nova-extension", { type: "application/zip" });
}

export async function exportExtensionRecords(): Promise<ExtensionBackupRecord[]> {
  return (await listExtensions()).filter(item => item.manifest.runtime === "quickjs").map(item => ({
    manifest: structuredClone(item.manifest),
    source: item.source,
    enabled: item.enabled,
  }));
}

export async function restoreExtensionRecords(value: unknown) {
  if (!Array.isArray(value) || value.length > 128) throw new Error("备份中的扩展数量无效");
  const importedIds: string[] = [];
  let skipped = 0;
  let totalSourceBytes = 0;
  try {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") throw new Error("备份中的扩展记录无效");
      const source = entry as Partial<ExtensionBackupRecord>;
      const manifest = parseManifest(source.manifest);
      if (manifest.id === "dev.nova.pulse") {
        skipped += 1;
        continue;
      }
      if (manifest.runtime !== "quickjs") throw new Error(`原生扩展“${manifest.name}”必须从原始安装包单独安装`);
      if (typeof source.source !== "string" || !source.source.trim() || new TextEncoder().encode(source.source).byteLength > MAX_SOURCE_BYTES) {
        throw new Error(`扩展“${manifest.name}”源码无效或超过 256 KB`);
      }
      totalSourceBytes += new TextEncoder().encode(source.source).byteLength;
      if (totalSourceBytes > 8 * 1024 * 1024) throw new Error("备份中的扩展源码总大小不能超过 8 MB");
      if (await getExtension(manifest.id)) {
        skipped += 1;
        continue;
      }
      const stored = await storeExtension(manifest, source.source);
      importedIds.push(stored.item.id);
      if (source.enabled === false) await setExtensionEnabled(stored.item.id, false);
    }
    return { imported: importedIds.length, skipped, importedIds };
  } catch (error) {
    await Promise.all(importedIds.map(id => runStore("readwrite", store => store.delete(id)).catch(() => undefined)));
    runtimeExtensionsCache = undefined;
    notifyExtensionsChanged();
    throw error;
  }
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./extensionWorker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    window.clearTimeout(request.timer);
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.result ?? {});
  };
  worker.onerror = event => resetWorker(new Error(event.message || "扩展运行环境异常"));
  return worker;
}

function resetWorker(error: Error) {
  worker?.terminate();
  worker = undefined;
  for (const request of pending.values()) {
    window.clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function releaseQuickJsWorkerIfIdle() {
  if (!worker || pending.size) return;
  worker.terminate();
  worker = undefined;
}

async function stopInactiveProviders(requiredIds: Set<string>) {
  const inactive = [...activeProviderIds].filter(id => !requiredIds.has(id));
  if (!inactive.length) return;
  inactive.forEach(id => activeProviderIds.delete(id));
  if (inTauri()) await Promise.all(inactive.map(id => api.stopProvider(id).catch(() => undefined)));
}

export async function releaseExtensionRuntimes() {
  releaseQuickJsWorkerIfIdle();
  await stopInactiveProviders(new Set());
}

function executeExtension(extension: InstalledExtension, input: ExtensionRuntimeInput, renderRequests: ExtensionRenderRequest[]) {
  return new Promise<RawRuntimeResult>((resolve, reject) => {
    const id = ++requestId;
    // The first request also initializes QuickJS WASM; extension code gets a separate 50 ms VM budget.
    const timer = window.setTimeout(() => resetWorker(new Error(`扩展“${extension.manifest.name}”运行环境响应超时`)), 2000);
    pending.set(id, { resolve, reject, timer });
    ensureWorker().postMessage({
      id,
      source: extension.source,
      input,
      renderRequests: renderRequests.map(request => ({
        id: request.layerId,
        width: Math.max(1, Math.min(128, Math.round(request.width))),
        height: Math.max(1, Math.min(64, Math.round(request.height))),
        settings: plainExtensionSettings(request.settings),
      })),
    });
  });
}

function executeProviderExtension(extension: InstalledExtension, input: ExtensionRuntimeInput, renderRequests: ExtensionRenderRequest[]) {
  if (!inTauri()) return Promise.reject(new Error("Provider 只能在桌面应用中运行"));
  const retryAfter = providerRetryAfter.get(extension.id) ?? 0;
  if (retryAfter > Date.now()) return Promise.resolve(providerLastResult.get(extension.id) ?? {});
  const running = providerInFlight.get(extension.id);
  if (running) return Promise.resolve(providerLastResult.get(extension.id) ?? {});
  const promise = api.tickProvider(extension.id, structuredClone(input), renderRequests.map(request => ({
    id: request.layerId,
    width: Math.max(1, Math.min(128, Math.round(request.width))),
    height: Math.max(1, Math.min(64, Math.round(request.height))),
    settings: plainExtensionSettings(request.settings),
  }))).then(result => {
    providerRetryAfter.delete(extension.id);
    providerLastResult.set(extension.id, { ...result, events: [] });
    return result;
  }).catch(error => {
    providerRetryAfter.set(extension.id, Date.now() + 5000);
    throw error;
  }).finally(() => providerInFlight.delete(extension.id));
  providerInFlight.set(extension.id, promise);
  return promise;
}

export function plainExtensionSettings(value: Record<string, ExtensionSettingValue>) {
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    .slice(0, 24)) as Record<string, ExtensionSettingValue>;
}

function runtimeVariables(value: unknown, extension: InstalledExtension) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowed = new Set(extension.manifest.variables.map(variable => variable.key));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, item]) => allowed.has(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"))
    .slice(0, 32)
    .map(([key, item]) => [`${extension.id}.${key}`, String(item).slice(0, 120)]));
}

function runtimePixels(value: unknown, width: number, height: number) {
  const pixels = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { pixels?: unknown }).pixels)
      ? (value as { pixels: unknown[] }).pixels
      : [];
  const limit = Math.min(MAX_PIXELS, Math.max(1, width * height));
  return [...new Set(pixels.slice(0, MAX_PIXELS * 2)
    .map(item => Math.round(Number(item)))
    .filter(item => Number.isFinite(item) && item >= 0 && item < limit))];
}

function runtimeEvents(value: unknown, extension: InstalledExtension) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(extension.manifest.events.map(event => event.key));
  return value.slice(0, 32).flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const source = item as { name?: unknown; data?: unknown };
    if (typeof source.name !== "string" || !allowed.has(source.name)) return [];
    const data = source.data && typeof source.data === "object" ? structuredClone(source.data) : source.data;
    return [{ extensionId: extension.id, name: source.name, data }];
  });
}

export async function runExtensions(
  input: ExtensionRuntimeInput,
  requests: ExtensionRenderRequest[],
  references: string[] = [],
): Promise<ExtensionRuntimeResult> {
  const enabled = runtimeExtensionsCache ??= (await listExtensions()).filter(extension => extension.enabled);
  const required = enabled.filter(extension => requests.some(request => request.extensionId === extension.id)
    || references.some(reference => reference === extension.id || reference.startsWith(`${extension.id}.`)));
  const requiredProviderIds = new Set(required
    .filter(extension => extension.manifest.runtime === "provider")
    .map(extension => extension.id));
  await stopInactiveProviders(requiredProviderIds);
  if (!required.some(extension => extension.manifest.runtime === "quickjs")) releaseQuickJsWorkerIfIdle();
  const variables: Record<string, string> = {};
  const pixels: Record<string, number[]> = {};
  const errors: string[] = [];
  const errorDetails: ExtensionRuntimeResult["errorDetails"] = [];
  for (const extension of required) {
    const matching = requests.filter(request => request.extensionId === extension.id);
    try {
      const output = extension.manifest.runtime === "provider"
        ? await executeProviderExtension(extension, input, matching)
        : await executeExtension(extension, input, matching);
      if (extension.manifest.runtime === "provider") activeProviderIds.add(extension.id);
      Object.assign(variables, runtimeVariables(output.variables, extension));
      if (Array.isArray(output.renders)) {
        for (const render of output.renders) {
          if (!render || typeof render !== "object" || typeof render.id !== "string") continue;
          const request = matching.find(item => item.layerId === render.id);
          if (request) pixels[render.id] = runtimePixels(render.pixels, request.width, request.height);
        }
      }
      for (const event of runtimeEvents(output.events, extension)) {
        globalThis.dispatchEvent?.(new CustomEvent("nova-extension-event", { detail: event }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${extension.manifest.name}：${message}`);
      errorDetails.push({ extensionId: extension.id, message });
    }
  }
  return { variables, pixels, errors, errorDetails };
}

export function defaultExtensionSettings(extension?: InstalledExtension) {
  return Object.fromEntries(extension?.manifest.renderer?.settings.map(setting => [setting.key, setting.default]) ?? []);
}
