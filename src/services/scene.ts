import {
  SCENE_SCHEMA_VERSION,
  type DeviceInfo,
  type DisplayConfig,
  type SceneConfig,
  type SceneDataSource,
  type SceneIconName,
  type SceneLayer,
  type SceneLayerType,
  type SceneVisibilityCondition,
  type SystemMetrics,
} from "../types";

const WIDTH = 128;
const HEIGHT = 64;
const LAYER_TYPES = new Set<SceneLayerType>(["text", "bar", "rect", "ellipse", "pixels", "image", "media", "icon", "extension"]);
const DATA_SOURCES = new Set<SceneDataSource>(["cpu", "memory", "progress", "battery", "spareBattery", "volume", "extension", "custom"]);
const ICON_NAMES = new Set<SceneIconName>(["playback", "battery", "volume", "headset"]);
const VISIBILITY_CONDITIONS = new Set<SceneVisibilityCondition>(["always", "playing", "paused", "headsetConnected", "headsetDisconnected"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function number(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function layerId() {
  return globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function migrateSceneLayer(value: unknown): SceneLayer | undefined {
  const source = record(value);
  const type = LAYER_TYPES.has(source.type as SceneLayerType) ? source.type as SceneLayerType : undefined;
  if (!type) return undefined;
  if (type === "extension" && source.extensionId === "dev.nova.pulse") return undefined;
  const defaultWidth = type === "pixels" ? WIDTH : type === "text" ? 112 : type === "image" || type === "media" || type === "extension" ? 72 : type === "icon" ? 16 : 48;
  const defaultHeight = type === "pixels" ? HEIGHT : type === "text" ? 14 : type === "image" || type === "media" || type === "extension" ? 32 : type === "icon" ? 16 : 10;
  const width = clamp(Math.round(number(source.width, defaultWidth)), 1, WIDTH);
  const height = clamp(Math.round(number(source.height, defaultHeight)), 1, HEIGHT);
  const pixels = Array.isArray(source.pixels)
    ? [...new Set(source.pixels.map(item => Math.round(number(item, -1))).filter(item => item >= 0 && item < WIDTH * HEIGHT))].sort((a, b) => a - b)
    : undefined;
  const dataSource = DATA_SOURCES.has(source.source as SceneDataSource) ? source.source as SceneDataSource : "custom";
  return {
    id: typeof source.id === "string" && source.id ? source.id : layerId(),
    name: typeof source.name === "string" && source.name ? source.name.slice(0, 24) : "未命名图层",
    type,
    x: clamp(Math.round(number(source.x, 0)), 0, WIDTH - width),
    y: clamp(Math.round(number(source.y, 0)), 0, HEIGHT - height),
    width,
    height,
    visible: source.visible !== false,
    condition: VISIBILITY_CONDITIONS.has(source.condition as SceneVisibilityCondition)
      ? source.condition as SceneVisibilityCondition
      : "always",
    locked: source.locked === true,
    invert: source.invert === true,
    content: typeof source.content === "string" ? source.content.slice(0, 120) : "",
    fontSize: clamp(Math.round(number(source.fontSize, 10)), 6, 28),
    weight: source.weight === 700 ? 700 : 400,
    align: source.align === "center" || source.align === "right" ? source.align : "left",
    source: dataSource,
    value: clamp(Math.round(number(source.value, 50)), 0, 100),
    valueVariable: typeof source.valueVariable === "string" && /^[a-z0-9.-]+\.[a-z][a-z0-9_]*$/.test(source.valueVariable)
      ? source.valueVariable.slice(0, 130)
      : undefined,
    filled: source.filled === true,
    pixels: type === "pixels" ? pixels ?? [] : undefined,
    pixelTool: source.pixelTool === "erase" ? "erase" : "draw",
    assetId: typeof source.assetId === "string" && source.assetId ? source.assetId : undefined,
    icon: ICON_NAMES.has(source.icon as SceneIconName) ? source.icon as SceneIconName : type === "icon" ? "playback" : undefined,
    extensionId: typeof source.extensionId === "string" && source.extensionId ? source.extensionId : undefined,
    extensionSettings: source.extensionSettings && typeof source.extensionSettings === "object" && !Array.isArray(source.extensionSettings)
      ? Object.fromEntries(Object.entries(source.extensionSettings as Record<string, unknown>)
        .filter(([, item]) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
        .slice(0, 24)) as Record<string, string | number | boolean>
      : type === "extension" ? {} : undefined,
  };
}

export function migrateScene(value: unknown, fallbackName = "我的场景"): SceneConfig {
  const source = record(value);
  const layers = Array.isArray(source.layers)
    ? source.layers.map(migrateSceneLayer).filter((layer): layer is SceneLayer => Boolean(layer))
    : [];
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 32) : fallbackName,
    canvas: { width: WIDTH, height: HEIGHT },
    layers,
  };
}

export function createEmptyScene(name = "新场景"): SceneConfig {
  return { schemaVersion: SCENE_SCHEMA_VERSION, name, canvas: { width: WIDTH, height: HEIGHT }, layers: [] };
}

export interface BuiltinSceneTemplate {
  id: string;
  name: string;
  description: string;
  scene: SceneConfig;
}

export const BUILTIN_SCENE_TEMPLATES: BuiltinSceneTemplate[] = [
  {
    id: "clock",
    name: "大字时钟",
    description: "时间 + 日期",
    scene: migrateScene({
      name: "大字时钟",
      layers: [
        { id: "template-clock-time", name: "时间", type: "text", x: 4, y: 5, width: 120, height: 24, visible: true, content: "{time}", fontSize: 21, weight: 700, align: "center", source: "custom", value: 0 },
        { id: "template-clock-date", name: "日期", type: "text", x: 4, y: 42, width: 120, height: 12, visible: true, content: "{date}", fontSize: 10, weight: 400, align: "center", source: "custom", value: 0 },
      ],
    }),
  },
  {
    id: "system",
    name: "系统仪表",
    description: "CPU + RAM",
    scene: migrateScene({
      name: "系统仪表",
      layers: [
        { id: "template-system-title", name: "系统数据", type: "text", x: 4, y: 4, width: 120, height: 12, visible: true, content: "CPU {cpu}%   RAM {memory}%", fontSize: 9, weight: 700, align: "center", source: "custom", value: 0 },
        { id: "template-system-cpu", name: "CPU 进度", type: "bar", x: 8, y: 25, width: 112, height: 9, visible: true, content: "", source: "cpu", value: 0 },
        { id: "template-system-memory", name: "内存进度", type: "bar", x: 8, y: 43, width: 112, height: 9, visible: true, content: "", source: "memory", value: 0 },
      ],
    }),
  },
  {
    id: "music",
    name: "音乐信息",
    description: "歌曲 + 歌手 + 进度",
    scene: migrateScene({
      name: "音乐信息",
      layers: [
        { id: "template-music-track", name: "歌曲名", type: "text", x: 4, y: 4, width: 120, height: 14, visible: true, content: "{track}", fontSize: 11, weight: 700, align: "center", source: "custom", value: 0 },
        { id: "template-music-artist", name: "歌手", type: "text", x: 4, y: 24, width: 120, height: 12, visible: true, content: "{artist}", fontSize: 9, weight: 400, align: "center", source: "custom", value: 0 },
        { id: "template-music-state", name: "播放状态", type: "icon", icon: "playback", x: 4, y: 45, width: 11, height: 11, visible: true, content: "", source: "custom", value: 0 },
        { id: "template-music-progress", name: "播放进度", type: "bar", x: 20, y: 47, width: 102, height: 8, visible: true, content: "", source: "progress", value: 0 },
      ],
    }),
  },
];

export interface SceneRuntimeContext {
  text: Record<string, string>;
  values: Record<Exclude<SceneDataSource, "extension">, number>;
  flags: {
    playing: boolean;
    headsetConnected: boolean;
  };
}

export function createSceneRuntimeContext(
  config: Pick<DisplayConfig, "track" | "artist" | "progress" | "playing">,
  metrics: SystemMetrics,
  device: DeviceInfo,
  now = new Date(),
  extensionText: Record<string, string> = {},
): SceneRuntimeContext {
  const battery = device.batteryAvailable ? device.battery : 0;
  const spareBattery = device.spareBatteryAvailable ? device.spareBattery : 0;
  return {
    text: {
      time: now.toLocaleTimeString("zh-CN", { hour12: false }),
      date: `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`,
      cpu: String(Math.round(metrics.cpu)),
      memory: String(Math.round(metrics.memory)),
      battery: device.batteryAvailable ? String(device.battery) : "--",
      headset_battery: device.batteryAvailable ? String(device.battery) : "--",
      spare_battery: device.spareBatteryAvailable ? String(device.spareBattery) : "--",
      volume: String(Math.round(device.volume)),
      track: config.track || "No media",
      artist: config.artist || "Unknown artist",
      progress: String(Math.round(config.progress)),
      playing: config.playing ? "PLAYING" : "PAUSED",
      ...extensionText,
    },
    values: {
      cpu: metrics.cpu,
      memory: metrics.memory,
      progress: config.progress,
      battery,
      spareBattery,
      volume: device.volume,
      custom: 0,
    },
    flags: {
      playing: config.playing,
      headsetConnected: device.headsetConnected,
    },
  };
}

export function resolveSceneText(value: string, context: SceneRuntimeContext) {
  return value.replace(/\{([a-z0-9_.-]+)\}/gi, (token, key: string) => context.text[key] ?? token);
}

export function sceneLayerVisible(layer: SceneLayer, context: SceneRuntimeContext) {
  if (!layer.visible) return false;
  if (layer.condition === "playing") return context.flags.playing;
  if (layer.condition === "paused") return !context.flags.playing;
  if (layer.condition === "headsetConnected") return context.flags.headsetConnected;
  if (layer.condition === "headsetDisconnected") return !context.flags.headsetConnected;
  return true;
}

export function sceneSourceValue(layer: SceneLayer, context: SceneRuntimeContext) {
  const extensionValue = layer.source === "extension" && layer.valueVariable
    ? Number(context.text[layer.valueVariable])
    : Number.NaN;
  const value = layer.source === "custom"
    ? layer.value
    : layer.source === "extension"
      ? Number.isFinite(extensionValue) ? extensionValue : layer.value
      : context.values[layer.source];
  return clamp(value, 0, 100);
}
