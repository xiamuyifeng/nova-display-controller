export type DisplayMode = "scene" | "image" | "media" | "text" | "clock" | "system" | "music";

export const SCENE_SCHEMA_VERSION = 5;
export type SceneLayerType = "text" | "bar" | "rect" | "ellipse" | "pixels" | "image" | "media" | "icon" | "extension";
export type SceneDataSource = "cpu" | "memory" | "progress" | "battery" | "spareBattery" | "volume" | "extension" | "custom";
export type SceneIconName = "playback" | "battery" | "volume" | "headset";
export type SceneVisibilityCondition = "always" | "playing" | "paused" | "headsetConnected" | "headsetDisconnected";

export interface SceneCanvasConfig {
  width: number;
  height: number;
}

export interface SceneLayer {
  id: string;
  name: string;
  type: SceneLayerType;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  condition: SceneVisibilityCondition;
  locked: boolean;
  invert: boolean;
  content: string;
  fontSize: number;
  weight: 400 | 700;
  align: "left" | "center" | "right";
  source: SceneDataSource;
  value: number;
  valueVariable?: string;
  filled: boolean;
  pixels?: number[];
  pixelTool?: "draw" | "erase";
  assetId?: string;
  icon?: SceneIconName;
  extensionId?: string;
  extensionSettings?: Record<string, string | number | boolean>;
}

export interface SceneConfig {
  schemaVersion: number;
  name: string;
  canvas: SceneCanvasConfig;
  layers: SceneLayer[];
}

export interface MediaDisplaySettings {
  fit: "contain" | "cover" | "stretch";
  threshold: number;
  dither: boolean;
  invert: boolean;
}

export interface AutomationEntry {
  id: string;
  mode: DisplayMode;
  libraryId?: string;
  name: string;
  duration: number;
}

export type AutomationTriggerType = "playing" | "batteryLow" | "extensionEvent";

export interface AutomationTrigger {
  id: string;
  type: AutomationTriggerType;
  entry: AutomationEntry;
  threshold?: number;
  extensionId?: string;
  eventKey?: string;
}

export interface AutomationPlan {
  name: string;
  entries: AutomationEntry[];
  triggers?: AutomationTrigger[];
}

export interface DisplayConfig {
  mode: DisplayMode;
  mediaUrl: string;
  mediaLibraryId: string;
  mediaKind: "image" | "gif" | "video" | "";
  mediaName: string;
  fit: "contain" | "cover" | "stretch";
  threshold: number;
  dither: boolean;
  invert: boolean;
  text: string;
  fontSize: number;
  align: "left" | "center";
  clockFormat: "24h-seconds" | "24h" | "12h";
  showDate: boolean;
  showCpu: boolean;
  showMemory: boolean;
  track: string;
  artist: string;
  progress: number;
  playing: boolean;
  autoMedia: boolean;
  sceneLibraryId: string;
  scene: SceneConfig;
}

export const defaultScene: SceneConfig = {
  schemaVersion: SCENE_SCHEMA_VERSION,
  name: "我的场景",
  canvas: { width: 128, height: 64 },
  layers: [
    {
      id: "scene-time",
      name: "时间",
      type: "text",
      x: 4,
      y: 3,
      width: 120,
      height: 20,
      visible: true,
      condition: "always",
      locked: false,
      invert: false,
      content: "{time}",
      fontSize: 17,
      weight: 700,
      align: "center",
      source: "custom",
      value: 50,
      filled: false,
    },
    {
      id: "scene-stats",
      name: "系统数据",
      type: "text",
      x: 4,
      y: 28,
      width: 120,
      height: 11,
      visible: true,
      condition: "always",
      locked: false,
      invert: false,
      content: "CPU {cpu}%   RAM {memory}%",
      fontSize: 9,
      weight: 700,
      align: "center",
      source: "custom",
      value: 50,
      filled: false,
    },
    {
      id: "scene-cpu-bar",
      name: "CPU 进度条",
      type: "bar",
      x: 4,
      y: 47,
      width: 120,
      height: 9,
      visible: true,
      condition: "always",
      locked: false,
      invert: false,
      content: "",
      fontSize: 9,
      weight: 400,
      align: "left",
      source: "cpu",
      value: 50,
      filled: false,
    },
  ],
};

export interface DeviceInfo {
  connected: boolean;
  deviceId: string;
  product: string;
  productId: number;
  interfaceNumber: number;
  oledReportId: number;
  width: number;
  height: number;
  battery: number;
  batteryAvailable: boolean;
  spareBattery: number;
  spareBatteryAvailable: boolean;
  headsetConnected: boolean;
  volume: number;
  gameVolume: number;
  chatVolume: number;
  charging: boolean;
}

export interface DetectedDevice {
  id: string;
  product: string;
  productId: number;
  productIdHex: string;
  serialNumber: string;
  supported: boolean;
  support: "supported" | "planned" | "experimental" | "research" | "gamesense" | "unknown";
  protocol: string;
  interfaceNumber?: number;
  oledReportId?: number;
  width: number;
  height: number;
  connected: boolean;
}

export interface SystemMetrics {
  cpu: number;
  memory: number;
  usedMemoryGb: number;
  totalMemoryGb: number;
}

export const defaultConfig: DisplayConfig = {
  mode: "clock",
  mediaUrl: "",
  mediaLibraryId: "",
  mediaKind: "",
  mediaName: "",
  fit: "contain",
  threshold: 128,
  dither: true,
  invert: false,
  text: "NOVA PRO",
  fontSize: 20,
  align: "center",
  clockFormat: "24h-seconds",
  showDate: true,
  showCpu: true,
  showMemory: true,
  track: "No media playing",
  artist: "SteelSeries OLED",
  progress: 36,
  playing: false,
  autoMedia: true,
  sceneLibraryId: "",
  scene: structuredClone(defaultScene),
};

export interface MediaInfo {
  title: string;
  artist: string;
  progress: number;
  playing: boolean;
}

export interface GameSenseStatus {
  installed: boolean;
  running: boolean;
  address: string;
  source: string;
}

export interface GameSenseTestResult {
  accepted: boolean;
  message: string;
}

export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
  target: string;
}

export interface DiagnosticSettings {
  enabled: boolean;
  directory: string;
  defaultDirectory: string;
  isDefault: boolean;
}
