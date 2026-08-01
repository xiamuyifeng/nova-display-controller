<script setup lang="ts">
import {
  Activity, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowDown,
  ArrowUp, ChevronsDown, ChevronsUp, Circle, CirclePlay, Copy, Download, Eraser, Eye, EyeOff,
  Box, GripVertical, Image, Lock, Pencil, Plus, Redo2, RotateCcw, Save, Search, Square, Star, Trash2,
  Type, Undo2, Unlock, Upload, Video, X,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { deleteLibraryItem, listLibraryItems, removeItemFromSavedPlaylists, saveSceneLibraryItem, setLibraryItemFavorite, type LibraryItem } from "../services/library";
import { BUILTIN_SCENE_TEMPLATES, createEmptyScene, createSceneRuntimeContext, migrateScene, resolveSceneText, sceneLayerVisible, sceneSourceValue, type BuiltinSceneTemplate } from "../services/scene";
import { assessSceneExtensionDependencies, chooseScenePackage, createScenePackage, importScenePackage, isScenePackageFile, saveScenePackage, type SceneExtensionDependencyStatus } from "../services/scenePackage";
import { defaultExtensionSettings, listExtensions, type InstalledExtension } from "../services/extensions";
import { inTauri } from "../services/tauri";
import { useI18n } from "../services/i18n";
import type { DeviceInfo, DisplayConfig, SceneConfig, SceneLayer, SceneLayerType, SystemMetrics } from "../types";
import PixelLayerCanvas from "./PixelLayerCanvas.vue";
import SceneIconCanvas from "./SceneIconCanvas.vue";
import SceneThumbnail from "./SceneThumbnail.vue";

const props = defineProps<{
  config: DisplayConfig;
  metrics: SystemMetrics;
  device: DeviceInfo;
}>();

const emit = defineEmits<{ message: [value: string] }>();
const { t } = useI18n();

const selectedId = ref(props.config.scene.layers[0]?.id ?? "");
const selected = computed(() => props.config.scene.layers.find(layer => layer.id === selectedId.value));
const builtinVariables = ["{time}", "{date}", "{cpu}", "{memory}", "{headset_battery}", "{spare_battery}", "{volume}", "{track}", "{artist}", "{progress}", "{playing}"];
const extensions = ref<InstalledExtension[]>([]);
const rendererExtensions = computed(() => extensions.value.filter(item => item.enabled && item.manifest.renderer));
const extensionToAdd = ref("");
const variables = computed(() => [
  ...builtinVariables,
  ...extensions.value.filter(item => item.enabled).flatMap(item => item.manifest.variables.map(variable => `{${item.id}.${variable.key}}`)),
]);
const extensionValueSources = computed(() => extensions.value
  .filter(item => item.enabled)
  .flatMap(item => item.manifest.variables.map(variable => ({
    value: `${item.id}.${variable.key}`,
    label: `${t(item.manifest.name)} / ${t(variable.label)}`,
  }))));
const selectedExtension = computed(() => extensions.value.find(item => item.id === selected.value?.extensionId));
const imageAssets = ref<LibraryItem[]>([]);
const mediaAssets = ref<LibraryItem[]>([]);
const assetUrls = ref<Record<string, string>>({});
const scenePresets = ref<LibraryItem[]>([]);
const sceneSearch = ref("");
const favoriteOnly = ref(false);
const packageInput = ref<HTMLInputElement>();
const packageBusy = ref(false);
const sceneDependencyReport = ref<SceneExtensionDependencyStatus[]>([]);
const extensionRuntimeStatus = ref({
  variableKeys: [] as string[],
  errors: [] as Array<{ extensionId: string; message: string }>,
});
const snapEnabled = ref(true);
const guideX = ref<number>();
const guideY = ref<number>();
const canUndo = ref(false);
const canRedo = ref(false);
const filteredScenePresets = computed(() => {
  const query = sceneSearch.value.trim().toLocaleLowerCase();
  return scenePresets.value.filter(item => (!favoriteOnly.value || item.favorite) && (!query || item.name.toLocaleLowerCase().includes(query)));
});
const assetKinds = computed(() => Object.fromEntries([...imageAssets.value, ...mediaAssets.value].map(item => [item.id, item.kind])));
const selectedExtensionReference = computed(() => {
  const layer = selected.value;
  if (!layer) return undefined;
  if (layer.type === "extension") return layer.extensionId;
  if (layer.type !== "bar" || layer.source !== "extension" || !layer.valueVariable) return undefined;
  return extensions.value.find(item => layer.valueVariable?.startsWith(`${item.id}.`))?.id
    ?? layer.valueVariable.slice(0, layer.valueVariable.lastIndexOf("."));
});
const selectedExtensionStatus = computed(() => {
  const extensionId = selectedExtensionReference.value;
  if (!extensionId) return undefined;
  const installed = extensions.value.find(item => item.id === extensionId);
  if (!installed) return { tone: "error", label: t("扩展未安装：{id}", { id: extensionId }) };
  if (!installed.enabled) return { tone: "warning", label: t("扩展已停用：{name}", { name: installed.manifest.name }) };
  const runtimeError = extensionRuntimeStatus.value.errors.find(item => !item.extensionId || item.extensionId === extensionId);
  if (runtimeError) return { tone: "error", label: t("运行异常：{error}", { error: runtimeError.message }) };
  const layer = selected.value;
  if (layer?.type === "bar" && layer.source === "extension" && layer.valueVariable
    && !extensionRuntimeStatus.value.variableKeys.includes(layer.valueVariable)) {
    return { tone: "waiting", label: t("等待变量数据：{variable}", { variable: layer.valueVariable }) };
  }
  return { tone: "ready", label: t("扩展可用：{name} {version}", { name: installed.manifest.name, version: installed.manifest.version }) };
});

type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
const resizeEdges: ResizeEdge[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
type Interaction = {
  mode: "move" | "resize";
  edge?: ResizeEdge;
  layer: SceneLayer;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

let interaction: Interaction | undefined;
let draggedLayerId = "";
let historyTimer = 0;
let historyApplying = false;
let history: SceneConfig[] = [];
let historyIndex = -1;

function updateHistoryState() {
  canUndo.value = historyIndex > 0;
  canRedo.value = historyIndex >= 0 && historyIndex < history.length - 1;
}

function sceneSnapshot() {
  return migrateScene(JSON.parse(JSON.stringify(props.config.scene)));
}

function recordHistory() {
  window.clearTimeout(historyTimer);
  historyTimer = 0;
  if (historyApplying || interaction) return;
  const snapshot = sceneSnapshot();
  if (historyIndex >= 0 && JSON.stringify(history[historyIndex]) === JSON.stringify(snapshot)) return;
  history.splice(historyIndex + 1);
  history.push(snapshot);
  if (history.length > 50) history.shift();
  historyIndex = history.length - 1;
  updateHistoryState();
}

function scheduleHistory() {
  if (historyApplying || interaction) return;
  window.clearTimeout(historyTimer);
  historyTimer = window.setTimeout(recordHistory, 250);
}

function resetHistory() {
  window.clearTimeout(historyTimer);
  historyTimer = 0;
  history = [sceneSnapshot()];
  historyIndex = 0;
  updateHistoryState();
}

async function applyHistory(index: number) {
  if (index < 0 || index >= history.length) return;
  historyApplying = true;
  historyIndex = index;
  props.config.scene = structuredClone(history[index]);
  if (!props.config.scene.layers.some(layer => layer.id === selectedId.value)) {
    selectedId.value = props.config.scene.layers[0]?.id ?? "";
  }
  updateHistoryState();
  await nextTick();
  historyApplying = false;
}

function undo() {
  recordHistory();
  if (historyIndex > 0) void applyHistory(historyIndex - 1);
}

function redo() {
  if (historyIndex < history.length - 1) void applyHistory(historyIndex + 1);
}

function id() {
  return globalThis.crypto?.randomUUID?.() ?? `layer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalize(layer: SceneLayer) {
  layer.width = clamp(Math.round(layer.width || 1), 1, 128);
  layer.height = clamp(Math.round(layer.height || 1), 1, 64);
  layer.x = clamp(Math.round(layer.x || 0), 0, 128 - layer.width);
  layer.y = clamp(Math.round(layer.y || 0), 0, 64 - layer.height);
  layer.fontSize = clamp(Math.round(layer.fontSize || 8), 6, 28);
  layer.value = clamp(Math.round(layer.value || 0), 0, 100);
}

function createLayer(type: SceneLayerType): SceneLayer {
  const names: Record<SceneLayerType, string> = {
    text: "文字",
    bar: "进度条",
    rect: "矩形",
    ellipse: "椭圆",
    pixels: "像素画",
    image: "素材图片",
    media: "动画",
    icon: "状态图标",
    extension: "扩展图层",
  };
  const base: SceneLayer = {
    id: id(),
    name: t(names[type]),
    type,
    x: type === "pixels" ? 0 : 8,
    y: type === "pixels" ? 0 : 8,
    width: type === "pixels" ? 128 : type === "text" ? 112 : type === "icon" ? 16 : 72,
    height: type === "pixels" ? 64 : type === "text" ? 14 : type === "image" || type === "media" || type === "extension" ? 32 : type === "icon" ? 16 : 10,
    visible: true,
    condition: "always",
    locked: false,
    invert: false,
    content: type === "text" ? t("新文字") : "",
    fontSize: 10,
    weight: 400,
    align: "left",
    source: type === "icon" ? "battery" : "cpu",
    value: 50,
    filled: false,
    pixels: type === "pixels" ? [] : undefined,
    pixelTool: "draw",
    assetId: type === "image" ? imageAssets.value[0]?.id : type === "media" ? mediaAssets.value[0]?.id : undefined,
    icon: type === "icon" ? "playback" : undefined,
    extensionId: type === "extension" ? rendererExtensions.value[0]?.id : undefined,
    extensionSettings: type === "extension" ? defaultExtensionSettings(rendererExtensions.value[0]) : undefined,
  };
  return base;
}

function addLayer(type: SceneLayerType) {
  if (type === "image" && !imageAssets.value.length) {
    emit("message", t("请先在图片模式中保存至少一个图片素材"));
    return;
  }
  if (type === "media" && !mediaAssets.value.length) {
    emit("message", t("请先在动画 / 视频模式中保存至少一个 GIF 或视频素材"));
    return;
  }
  if (type === "extension" && !rendererExtensions.value.length) {
    emit("message", t("请先在设置中安装并启用至少一个绘图扩展"));
    return;
  }
  const layer = createLayer(type);
  props.config.scene.layers.push(layer);
  selectedId.value = layer.id;
  recordHistory();
}

function addExtensionLayer() {
  const extension = rendererExtensions.value.find(item => item.id === extensionToAdd.value);
  if (!extension) {
    emit("message", t("请先在设置中安装并启用至少一个绘图扩展"));
    return;
  }
  const layer = createLayer("extension");
  layer.extensionId = extension.id;
  layer.extensionSettings = defaultExtensionSettings(extension);
  layer.name = extension.manifest.renderer?.label ?? extension.manifest.name;
  props.config.scene.layers.push(layer);
  selectedId.value = layer.id;
  recordHistory();
}

async function refreshLibrary() {
  Object.values(assetUrls.value).forEach(url => URL.revokeObjectURL(url));
  const items = await listLibraryItems();
  imageAssets.value = items.filter(item => item.kind === "image" && item.blob);
  mediaAssets.value = items.filter(item => (item.kind === "gif" || item.kind === "video") && item.blob);
  scenePresets.value = items.filter(item => item.kind === "scene" && item.scene);
  assetUrls.value = Object.fromEntries([...imageAssets.value, ...mediaAssets.value]
    .map(item => [item.id, URL.createObjectURL(item.blob!)]));
  if (props.config.sceneLibraryId && !scenePresets.value.some(item => item.id === props.config.sceneLibraryId)) {
    props.config.sceneLibraryId = "";
  }
}

async function refreshExtensions() {
  extensions.value = await listExtensions();
  if (sceneDependencyReport.value.length) {
    sceneDependencyReport.value = assessSceneExtensionDependencies(sceneDependencyReport.value, extensions.value);
  }
}

function applyExtensionDefaults(layer: SceneLayer) {
  const extension = extensions.value.find(item => item.id === layer.extensionId);
  layer.extensionSettings = defaultExtensionSettings(extension);
  if (extension?.manifest.renderer) layer.name = extension.manifest.renderer.label;
}

function setExtensionSetting(layer: SceneLayer, key: string, value: string | number | boolean) {
  if (!layer.extensionSettings) layer.extensionSettings = {};
  layer.extensionSettings[key] = value;
}

function handleExtensionsChanged() {
  void refreshExtensions().catch(error => emit("message", t("刷新扩展失败：{error}", { error: error instanceof Error ? error.message : String(error) })));
}

function handleExtensionRuntimeStatus(event: Event) {
  const detail = (event as CustomEvent<{
    variableKeys?: unknown;
    errors?: unknown;
  }>).detail;
  extensionRuntimeStatus.value = {
    variableKeys: Array.isArray(detail?.variableKeys) ? detail.variableKeys.filter((item): item is string => typeof item === "string") : [],
    errors: Array.isArray(detail?.errors) ? detail.errors.filter((item): item is { extensionId: string; message: string } => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return typeof value.extensionId === "string" && typeof value.message === "string";
    }) : [],
  };
}

function dependencyStatusLabel(item: SceneExtensionDependencyStatus) {
  if (item.status === "missing") return t("未安装");
  if (item.status === "outdated") return t("需升级至 {version}", { version: item.minimumVersion });
  if (item.status === "disabled") return t("已停用");
  return t("可用");
}

function handleLibraryChanged() {
  void refreshLibrary().catch(error => emit("message", t("刷新场景库失败：{error}", { error: error instanceof Error ? error.message : String(error) })));
}

function assetKind(assetId?: string) {
  return mediaAssets.value.find(item => item.id === assetId)?.kind;
}

function newScene() {
  if (props.config.scene.layers.length && !window.confirm(t("新建场景会清空当前编辑画布，未保存的修改将丢失。是否继续？"))) return;
  props.config.sceneLibraryId = "";
  props.config.scene = createEmptyScene();
  selectedId.value = "";
  resetHistory();
}

async function saveScene(saveAs = false) {
  try {
    const item = await saveSceneLibraryItem(props.config.scene, saveAs ? undefined : props.config.sceneLibraryId);
    props.config.sceneLibraryId = item.id;
    props.config.scene.name = item.name;
    await refreshLibrary();
    emit("message", t(saveAs ? "已另存场景：{name}" : "场景已保存：{name}", { name: item.name }));
  } catch (error) {
    emit("message", t("保存场景失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  }
}

async function exportScene(scene = props.config.scene) {
  packageBusy.value = true;
  try {
    const output = await createScenePackage(scene);
    if (await saveScenePackage(output.blob, output.fileName)) emit("message", t("场景包已导出：{name}", { name: output.fileName }));
  } catch (error) {
    emit("message", t("导出场景包失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    packageBusy.value = false;
  }
}

async function choosePackage() {
  if (!inTauri()) {
    packageInput.value?.click();
    return;
  }
  packageBusy.value = true;
  try {
    const file = await chooseScenePackage();
    if (file) await importPackageFile(file);
  } catch (error) {
    emit("message", t("读取场景包失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    packageBusy.value = false;
  }
}

async function importPackageFile(file: File) {
  if (!isScenePackageFile(file)) {
    emit("message", t("请选择 .nova-oled 场景包"));
    return;
  }
  const result = await importScenePackage(file);
  await refreshLibrary();
  await refreshExtensions();
  useScenePreset(result.item);
  sceneDependencyReport.value = result.dependencies;
  const issues = result.dependencies.filter(item => item.status !== "ready");
  const issueText = issues.map(item => item.status === "missing"
    ? t("缺少 {name}", { name: item.name })
    : item.status === "outdated"
      ? t("{name} 需要 {required}，当前 {current}", { name: item.name, required: item.minimumVersion, current: item.installedVersion })
      : t("{name} 已停用", { name: item.name })).join(t("；"));
  emit("message", issues.length
    ? t("场景包已导入；{issues}", { issues: issueText })
    : t("场景包已导入：{name}", { name: result.item.name }));
}

async function importPackage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  packageBusy.value = true;
  try {
    await importPackageFile(file);
  } catch (error) {
    emit("message", t("导入场景包失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  } finally {
    packageBusy.value = false;
  }
}

function useScenePreset(item: LibraryItem) {
  if (item.kind !== "scene" || !item.scene) return;
  props.config.scene = migrateScene(item.scene);
  props.config.sceneLibraryId = item.id;
  selectedId.value = props.config.scene.layers[0]?.id ?? "";
  resetHistory();
}

async function duplicateScenePreset(item: LibraryItem) {
  if (item.kind !== "scene" || !item.scene) return;
  try {
    const copy = structuredClone(item.scene);
    copy.name = t("{name} 副本", { name: item.name }).slice(0, 32);
    const saved = await saveSceneLibraryItem(copy);
    await refreshLibrary();
    useScenePreset(saved);
    emit("message", t("已复制场景：{name}", { name: saved.name }));
  } catch (error) {
    emit("message", t("复制场景失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  }
}

async function toggleFavorite(item: LibraryItem) {
  try {
    await setLibraryItemFavorite(item.id, !item.favorite);
    await refreshLibrary();
  } catch (error) {
    emit("message", t("更新收藏失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  }
}

function useBuiltinTemplate(template: BuiltinSceneTemplate) {
  props.config.scene = structuredClone(template.scene);
  props.config.sceneLibraryId = "";
  selectedId.value = props.config.scene.layers[0]?.id ?? "";
  resetHistory();
  emit("message", t("已从模板创建场景：{name}", { name: t(template.name) }));
}

async function deleteScenePreset(item: LibraryItem) {
  if (item.kind !== "scene" || !window.confirm(t("确定删除场景“{name}”吗？", { name: item.name }))) return;
  try {
    await deleteLibraryItem(item.id);
    const playlistCount = await removeItemFromSavedPlaylists(item.id);
    if (props.config.sceneLibraryId === item.id) props.config.sceneLibraryId = "";
    await refreshLibrary();
    emit("message", playlistCount > 0
      ? t("已删除场景：{name}，并清理 {count} 个编排中的引用", { name: item.name, count: playlistCount })
      : t("已删除场景：{name}", { name: item.name }));
  } catch (error) {
    emit("message", t("删除场景失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
  }
}

function clearPixels() {
  if (selected.value?.type === "pixels" && !selected.value.locked) {
    selected.value.pixels = [];
    recordHistory();
  }
}

function duplicateLayer() {
  if (!selected.value) return;
  const copy = structuredClone(selected.value);
  copy.id = id();
  copy.name = t("{name} 副本", { name: copy.name });
  copy.x = clamp(copy.x + 3, 0, 128 - copy.width);
  copy.y = clamp(copy.y + 3, 0, 64 - copy.height);
  props.config.scene.layers.push(copy);
  selectedId.value = copy.id;
  recordHistory();
}

function deleteLayer() {
  const index = props.config.scene.layers.findIndex(layer => layer.id === selectedId.value);
  if (index < 0) return;
  props.config.scene.layers.splice(index, 1);
  selectedId.value = props.config.scene.layers[Math.min(index, props.config.scene.layers.length - 1)]?.id ?? "";
  recordHistory();
}

function moveLayer(direction: -1 | 1) {
  const layers = props.config.scene.layers;
  const index = layers.findIndex(layer => layer.id === selectedId.value);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= layers.length || selected.value?.locked) return;
  const [layer] = layers.splice(index, 1);
  layers.splice(target, 0, layer);
  recordHistory();
}

function moveLayerTo(position: "top" | "bottom") {
  const layers = props.config.scene.layers;
  const index = layers.findIndex(layer => layer.id === selectedId.value);
  if (index < 0 || selected.value?.locked) return;
  const [layer] = layers.splice(index, 1);
  layers.splice(position === "top" ? layers.length : 0, 0, layer);
  recordHistory();
}

function alignLayer(position: "left" | "center" | "right" | "top" | "middle" | "bottom") {
  const layer = selected.value;
  if (!layer || layer.locked || layer.type === "pixels") return;
  if (position === "left") layer.x = 0;
  if (position === "center") layer.x = Math.round((128 - layer.width) / 2);
  if (position === "right") layer.x = 128 - layer.width;
  if (position === "top") layer.y = 0;
  if (position === "middle") layer.y = Math.round((64 - layer.height) / 2);
  if (position === "bottom") layer.y = 64 - layer.height;
  recordHistory();
}

function toggleVisibility(layer: SceneLayer) {
  layer.visible = !layer.visible;
  recordHistory();
}

function toggleLock(layer: SceneLayer) {
  layer.locked = !layer.locked;
  recordHistory();
}

function startLayerReorder(event: DragEvent, layer: SceneLayer) {
  if (layer.locked) {
    event.preventDefault();
    return;
  }
  draggedLayerId = layer.id;
  event.dataTransfer?.setData("text/plain", layer.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function dropLayer(target: SceneLayer) {
  const sourceId = draggedLayerId;
  draggedLayerId = "";
  if (!sourceId || sourceId === target.id) return;
  const layers = props.config.scene.layers;
  const sourceIndex = layers.findIndex(layer => layer.id === sourceId);
  const targetIndex = layers.findIndex(layer => layer.id === target.id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [layer] = layers.splice(sourceIndex, 1);
  layers.splice(targetIndex, 0, layer);
  recordHistory();
}

function insertVariable(value: string) {
  if (!selected.value || selected.value.type !== "text") return;
  selected.value.content += value;
}

function resolveText(value: string) {
  return resolveSceneText(value, createSceneRuntimeContext(props.config, props.metrics, props.device));
}

function sourceValue(layer: SceneLayer) {
  return sceneSourceValue(layer, createSceneRuntimeContext(props.config, props.metrics, props.device));
}

function conditionActive(layer: SceneLayer) {
  return sceneLayerVisible({ ...layer, visible: true }, createSceneRuntimeContext(props.config, props.metrics, props.device));
}

function normalizeIconSource(layer: SceneLayer) {
  if (layer.icon === "battery" && layer.source !== "battery" && layer.source !== "spareBattery") layer.source = "battery";
  if (layer.icon === "volume" && layer.source !== "volume" && layer.source !== "custom") layer.source = "volume";
}

function normalizeBarSource(layer: SceneLayer) {
  if (layer.source === "extension" && !extensionValueSources.value.some(item => item.value === layer.valueVariable)) {
    layer.valueVariable = extensionValueSources.value[0]?.value;
  }
}

function hasExtensionValueSource(value?: string) {
  return Boolean(value && extensionValueSources.value.some(item => item.value === value));
}

function layerStyle(layer: SceneLayer) {
  return {
    left: `${layer.x * 4}px`,
    top: `${layer.y * 4}px`,
    width: `${layer.width * 4}px`,
    height: `${layer.height * 4}px`,
    fontSize: `${layer.fontSize * 4}px`,
    fontWeight: layer.weight,
    justifyContent: layer.align === "left" ? "flex-start" : layer.align === "right" ? "flex-end" : "center",
  };
}

function interactionScale(event: PointerEvent) {
  const stage = (event.currentTarget as HTMLElement).closest<HTMLElement>(".scene-canvas");
  return stage ? stage.getBoundingClientRect().width / 128 : 4;
}

function startDrag(event: PointerEvent, layer: SceneLayer) {
  selectedId.value = layer.id;
  (event.currentTarget as HTMLElement).closest<HTMLElement>(".scene-canvas")?.focus();
  if (layer.locked || layer.type === "pixels") return;
  recordHistory();
  interaction = {
    mode: "move",
    layer,
    startX: event.clientX,
    startY: event.clientY,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
    scale: interactionScale(event),
  };
  window.addEventListener("pointermove", updateInteraction);
  window.addEventListener("pointerup", stopInteraction, { once: true });
}

function startResize(event: PointerEvent, layer: SceneLayer, edge: ResizeEdge) {
  event.stopPropagation();
  selectedId.value = layer.id;
  if (layer.locked || layer.type === "pixels") return;
  recordHistory();
  interaction = {
    mode: "resize",
    edge,
    layer,
    startX: event.clientX,
    startY: event.clientY,
    x: layer.x,
    y: layer.y,
    width: layer.width,
    height: layer.height,
    scale: interactionScale(event),
  };
  window.addEventListener("pointermove", updateInteraction);
  window.addEventListener("pointerup", stopInteraction, { once: true });
}

function snapMove(layer: SceneLayer, x: number, y: number) {
  guideX.value = undefined;
  guideY.value = undefined;
  if (!snapEnabled.value) return { x, y };
  const others = props.config.scene.layers.filter(item => item.id !== layer.id && item.visible);
  const xTargets = [0, 64, 128, ...others.flatMap(item => [item.x, item.x + item.width / 2, item.x + item.width])];
  const yTargets = [0, 32, 64, ...others.flatMap(item => [item.y, item.y + item.height / 2, item.y + item.height])];
  const xOffsets = [0, layer.width / 2, layer.width];
  const yOffsets = [0, layer.height / 2, layer.height];
  let bestX = 1.51;
  let bestY = 1.51;
  for (const target of xTargets) for (const offset of xOffsets) {
    const delta = target - (x + offset);
    if (Math.abs(delta) < Math.abs(bestX)) {
      bestX = delta;
      guideX.value = target;
    }
  }
  for (const target of yTargets) for (const offset of yOffsets) {
    const delta = target - (y + offset);
    if (Math.abs(delta) < Math.abs(bestY)) {
      bestY = delta;
      guideY.value = target;
    }
  }
  if (Math.abs(bestX) > 1.5) guideX.value = undefined;
  else x += bestX;
  if (Math.abs(bestY) > 1.5) guideY.value = undefined;
  else y += bestY;
  return { x, y };
}

function updateInteraction(event: PointerEvent) {
  if (!interaction) return;
  const dx = Math.round((event.clientX - interaction.startX) / interaction.scale);
  const dy = Math.round((event.clientY - interaction.startY) / interaction.scale);
  const layer = interaction.layer;
  if (interaction.mode === "move") {
    const snapped = snapMove(layer, interaction.x + dx, interaction.y + dy);
    layer.x = clamp(Math.round(snapped.x), 0, 128 - layer.width);
    layer.y = clamp(Math.round(snapped.y), 0, 64 - layer.height);
    return;
  }
  const edge = interaction.edge ?? "se";
  let left = interaction.x;
  let top = interaction.y;
  let right = interaction.x + interaction.width;
  let bottom = interaction.y + interaction.height;
  if (edge.includes("w")) left = clamp(interaction.x + dx, 0, right - 1);
  if (edge.includes("e")) right = clamp(interaction.x + interaction.width + dx, left + 1, 128);
  if (edge.includes("n")) top = clamp(interaction.y + dy, 0, bottom - 1);
  if (edge.includes("s")) bottom = clamp(interaction.y + interaction.height + dy, top + 1, 64);
  layer.x = left;
  layer.y = top;
  layer.width = right - left;
  layer.height = bottom - top;
}

function stopInteraction() {
  const changed = Boolean(interaction);
  interaction = undefined;
  guideX.value = undefined;
  guideY.value = undefined;
  window.removeEventListener("pointermove", updateInteraction);
  if (changed) recordHistory();
}

function nudgeLayer(event: KeyboardEvent) {
  if (!selected.value || selected.value.locked || selected.value.type === "pixels" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  recordHistory();
  const amount = event.shiftKey ? 5 : 1;
  if (event.key === "ArrowLeft") selected.value.x = clamp(selected.value.x - amount, 0, 128 - selected.value.width);
  if (event.key === "ArrowRight") selected.value.x = clamp(selected.value.x + amount, 0, 128 - selected.value.width);
  if (event.key === "ArrowUp") selected.value.y = clamp(selected.value.y - amount, 0, 64 - selected.value.height);
  if (event.key === "ArrowDown") selected.value.y = clamp(selected.value.y + amount, 0, 64 - selected.value.height);
  scheduleHistory();
}

watch(() => props.config.scene, scheduleHistory, { deep: true });
watch(rendererExtensions, items => {
  if (!items.some(item => item.id === extensionToAdd.value)) extensionToAdd.value = items[0]?.id ?? "";
}, { immediate: true });

onMounted(() => {
  window.addEventListener("nova-library-changed", handleLibraryChanged);
  window.addEventListener("nova-extensions-changed", handleExtensionsChanged);
  window.addEventListener("nova-extension-runtime-status", handleExtensionRuntimeStatus);
  resetHistory();
  refreshLibrary().catch(error => emit("message", error instanceof Error ? error.message : String(error)));
  refreshExtensions().catch(error => emit("message", error instanceof Error ? error.message : String(error)));
});
onBeforeUnmount(() => {
  window.removeEventListener("nova-library-changed", handleLibraryChanged);
  window.removeEventListener("nova-extensions-changed", handleExtensionsChanged);
  window.removeEventListener("nova-extension-runtime-status", handleExtensionRuntimeStatus);
  stopInteraction();
  window.clearTimeout(historyTimer);
  Object.values(assetUrls.value).forEach(url => URL.revokeObjectURL(url));
});
</script>

<template>
  <div class="scene-editor">
    <div class="scene-toolbar">
      <div class="scene-title-tools">
        <label class="scene-name"><span>{{ t("场景名称") }}</span><input v-model="config.scene.name" maxlength="32" /></label>
        <div class="scene-save-actions">
          <button :title="t('创建空白场景')" @click="newScene"><Plus :size="14" />{{ t("新建") }}</button>
          <button :title="t('保存当前场景')" class="primary-save" @click="saveScene(false)"><Save :size="14" />{{ t("保存场景") }}</button>
          <button :title="t('将当前内容保存为新的场景')" @click="saveScene(true)"><Copy :size="14" />{{ t("另存为") }}</button>
          <button :disabled="packageBusy" :title="t('导出当前场景包')" @click="exportScene()"><Download :size="14" />{{ t("导出") }}</button>
          <button :disabled="packageBusy" :title="t('导入场景包')" @click="choosePackage"><Upload :size="14" />{{ t("导入") }}</button>
          <input ref="packageInput" class="package-input" type="file" accept=".nova-oled,application/zip" @change="importPackage" />
        </div>
        <div class="history-actions">
          <button :disabled="!canUndo" :title="t('撤销')" @click="undo"><Undo2 :size="14" /></button>
          <button :disabled="!canRedo" :title="t('重做')" @click="redo"><Redo2 :size="14" /></button>
          <label :title="t('移动图层时吸附到画布和其他图层')"><input v-model="snapEnabled" type="checkbox" />{{ t("吸附") }}</label>
        </div>
      </div>
      <div class="add-actions">
        <button :title="t('添加文字')" @click="addLayer('text')"><Type :size="14" /><span>{{ t("文字") }}</span></button>
        <button :title="t('添加进度条')" @click="addLayer('bar')"><Activity :size="14" /><span>{{ t("进度条") }}</span></button>
        <button :title="t('添加状态图标')" @click="addLayer('icon')"><CirclePlay :size="14" /><span>{{ t("图标") }}</span></button>
        <button :title="t('添加矩形')" @click="addLayer('rect')"><Square :size="14" /><span>{{ t("矩形") }}</span></button>
        <button :title="t('添加椭圆')" @click="addLayer('ellipse')"><Circle :size="14" /><span>{{ t("椭圆") }}</span></button>
        <button :title="t('添加像素画布')" @click="addLayer('pixels')"><Pencil :size="14" /><span>{{ t("像素画") }}</span></button>
        <button :title="t('添加素材图片')" @click="addLayer('image')"><Image :size="14" /><span>{{ t("图片") }}</span></button>
        <button :title="t('添加 GIF 或视频')" @click="addLayer('media')"><Video :size="14" /><span>{{ t("动画") }}</span></button>
        <div class="extension-add">
          <Box :size="14" />
          <select v-model="extensionToAdd" :title="t('选择要添加的绘图扩展')" :disabled="!rendererExtensions.length">
            <option v-if="!rendererExtensions.length" value="">{{ t("没有绘图扩展") }}</option>
            <option v-for="extension in rendererExtensions" :key="extension.id" :value="extension.id">{{ t(extension.manifest.renderer?.label ?? extension.manifest.name) }}</option>
          </select>
          <button :disabled="!extensionToAdd" :title="t('添加所选扩展图层')" @click="addExtensionLayer"><Plus :size="14" /></button>
        </div>
      </div>
    </div>

    <div v-if="sceneDependencyReport.length" class="dependency-report">
      <strong>{{ t("场景扩展") }}</strong>
      <span
        v-for="item in sceneDependencyReport"
        :key="item.id"
        :class="['dependency-item', item.status]"
        :title="t('{id} · 要求 {version}', { id: item.id, version: item.minimumVersion || t('任意版本') })"
      >{{ item.name }} · {{ dependencyStatusLabel(item) }}</span>
      <button :title="t('关闭依赖提示')" @click="sceneDependencyReport = []"><X :size="13" /></button>
    </div>

    <div class="scene-library">
      <div class="scene-library-heading"><strong>{{ t("内置模板") }}</strong><span>{{ t("选择后可自由修改") }}</span></div>
      <div class="builtin-template-list">
        <button v-for="template in BUILTIN_SCENE_TEMPLATES" :key="template.id" @click="useBuiltinTemplate(template)">
          <strong>{{ t(template.name) }}</strong><span>{{ t(template.description) }}</span>
        </button>
      </div>
      <div class="scene-library-heading scene-library-tools">
        <div><strong>{{ t("我的场景") }}</strong><span>{{ t("{count} 个预设", { count: scenePresets.length }) }}</span></div>
        <div v-if="scenePresets.length" class="scene-library-filters">
          <button :class="{ active: favoriteOnly }" :title="t('只看收藏')" @click="favoriteOnly = !favoriteOnly"><Star :size="13" :fill="favoriteOnly ? 'currentColor' : 'none'" /></button>
          <label class="scene-search"><Search :size="13" /><input v-model="sceneSearch" type="search" :placeholder="t('搜索场景')" /></label>
        </div>
      </div>
      <div v-if="filteredScenePresets.length" class="scene-preset-list">
        <div
          v-for="item in filteredScenePresets"
          :key="item.id"
          :class="['scene-preset', { active: config.sceneLibraryId === item.id }]"
          role="button"
          tabindex="0"
          @click="useScenePreset(item)"
          @keydown.enter="useScenePreset(item)"
        >
          <SceneThumbnail v-if="item.scene" :scene="item.scene" :config="config" :metrics="metrics" :device="device" :asset-urls="assetUrls" :asset-kinds="assetKinds" />
          <div class="preset-detail">
            <strong>{{ item.name }}</strong>
            <span>{{ t("{count} 个图层", { count: item.scene?.layers.length ?? 0 }) }}</span>
            <div class="preset-actions">
              <button :class="{ favorite: item.favorite }" :title="t(item.favorite ? '取消收藏 {name}' : '收藏 {name}', { name: item.name })" @click.stop="toggleFavorite(item)"><Star :size="13" :fill="item.favorite ? 'currentColor' : 'none'" /></button>
              <button :title="t('导出 {name}', { name: item.name })" @click.stop="item.scene && exportScene(item.scene)"><Download :size="13" /></button>
              <button :title="t('复制 {name}', { name: item.name })" @click.stop="duplicateScenePreset(item)"><Copy :size="13" /></button>
              <button class="delete" :title="t('删除 {name}', { name: item.name })" @click.stop="deleteScenePreset(item)"><Trash2 :size="13" /></button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="scenePresets.length" class="scene-library-empty">{{ t("没有匹配的场景") }}</div>
      <div v-else class="scene-library-empty">{{ t("编辑完成后点击“保存场景”，之后可在这里快速切换。") }}</div>
    </div>

    <div class="designer-grid">
      <div class="canvas-scroll">
        <div class="scene-canvas" tabindex="0" :aria-label="t('场景画布')" @keydown="nudgeLayer">
          <i v-if="guideX !== undefined" class="snap-guide vertical" :style="{ left: `${guideX * 4}px` }"></i>
          <i v-if="guideY !== undefined" class="snap-guide horizontal" :style="{ top: `${guideY * 4}px` }"></i>
          <button
            v-for="layer in config.scene.layers"
            v-show="layer.visible"
            :key="layer.id"
            :class="['scene-layer', layer.type, { selected: selectedId === layer.id, filled: layer.filled, locked: layer.locked, 'condition-inactive': !conditionActive(layer) }]"
            :style="layerStyle(layer)"
            :title="layer.name"
            @pointerdown.prevent="startDrag($event, layer)"
          >
            <span v-if="layer.type === 'text'" class="layer-text">{{ resolveText(layer.content) }}</span>
            <span v-else-if="layer.type === 'bar'" class="layer-bar"><i :style="{ width: `${sourceValue(layer)}%` }"></i></span>
            <img v-else-if="layer.type === 'image' && layer.assetId" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" alt="" />
            <img v-else-if="layer.type === 'media' && layer.assetId && assetKind(layer.assetId) === 'gif'" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" alt="" />
            <video v-else-if="layer.type === 'media' && layer.assetId && assetKind(layer.assetId) === 'video'" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" muted loop autoplay playsinline />
            <span v-else-if="layer.type === 'extension'" class="extension-placeholder"><Box :size="14" /><b>{{ t(extensions.find(item => item.id === layer.extensionId)?.manifest.renderer?.label ?? '扩展未安装') }}</b></span>
            <SceneIconCanvas
              v-else-if="layer.type === 'icon' && layer.icon"
              :icon="layer.icon"
              :value="sourceValue(layer)"
              :playing="config.playing"
              :connected="device.headsetConnected"
            />
            <PixelLayerCanvas
              v-else-if="layer.type === 'pixels'"
              :layer="layer"
              :editable="selectedId === layer.id && !layer.locked"
              @select="selectedId = layer.id"
            />
            <span
              v-for="edge in resizeEdges"
              v-if="selectedId === layer.id && !layer.locked && layer.type !== 'pixels'"
              :key="edge"
              :class="['resize-handle', edge]"
              @pointerdown.prevent="startResize($event, layer, edge)"
            ></span>
          </button>
        </div>
      </div>

      <div class="inspector">
        <div class="layer-heading">
          <strong>{{ t("图层") }} <span>{{ config.scene.layers.length }}</span></strong>
          <button :disabled="!selected" :title="t('复制图层')" @click="duplicateLayer"><Copy :size="14" /></button>
          <button :disabled="!selected || selected.locked" :title="t('删除图层')" @click="deleteLayer"><Trash2 :size="14" /></button>
        </div>

        <div v-if="config.scene.layers.length" class="layer-list">
          <div
            v-for="layer in [...config.scene.layers].reverse()"
            :key="layer.id"
            :class="['layer-row', { active: selectedId === layer.id, hidden: !layer.visible }]"
            :draggable="!layer.locked"
            :title="layer.name"
            role="button"
            tabindex="0"
            @click="selectedId = layer.id"
            @keydown.enter="selectedId = layer.id"
            @dragstart="startLayerReorder($event, layer)"
            @dragover.prevent
            @drop.prevent="dropLayer(layer)"
          >
            <GripVertical :size="13" class="grip" />
            <span>{{ layer.name }}</span>
            <button :title="t(layer.visible ? '隐藏图层' : '显示图层')" @click.stop="toggleVisibility(layer)">
              <Eye v-if="layer.visible" :size="13" /><EyeOff v-else :size="13" />
            </button>
            <button :title="t(layer.locked ? '解锁图层' : '锁定图层')" @click.stop="toggleLock(layer)">
              <Lock v-if="layer.locked" :size="13" /><Unlock v-else :size="13" />
            </button>
          </div>
        </div>

        <template v-if="selected">
          <div class="inspector-actions">
            <button :title="t(selected.visible ? '隐藏图层' : '显示图层')" @click="toggleVisibility(selected)"><Eye v-if="selected.visible" :size="14" /><EyeOff v-else :size="14" /></button>
            <button :title="t(selected.locked ? '解锁图层' : '锁定图层')" @click="toggleLock(selected)"><Lock v-if="selected.locked" :size="14" /><Unlock v-else :size="14" /></button>
            <span class="action-spacer"></span>
            <button :disabled="selected.locked" :title="t('置于底层')" @click="moveLayerTo('bottom')"><ChevronsDown :size="14" /></button>
            <button :disabled="selected.locked" :title="t('下移一层')" @click="moveLayer(-1)"><ArrowDown :size="14" /></button>
            <button :disabled="selected.locked" :title="t('上移一层')" @click="moveLayer(1)"><ArrowUp :size="14" /></button>
            <button :disabled="selected.locked" :title="t('置于顶层')" @click="moveLayerTo('top')"><ChevronsUp :size="14" /></button>
          </div>
          <div v-if="selected.type !== 'pixels'" class="alignment-actions">
            <span>{{ t("画布对齐") }}</span>
            <button :disabled="selected.locked" :title="t('左对齐')" @click="alignLayer('left')"><AlignHorizontalJustifyStart :size="14" /></button>
            <button :disabled="selected.locked" :title="t('水平居中')" @click="alignLayer('center')"><AlignHorizontalJustifyCenter :size="14" /></button>
            <button :disabled="selected.locked" :title="t('右对齐')" @click="alignLayer('right')"><AlignHorizontalJustifyEnd :size="14" /></button>
            <button :disabled="selected.locked" :title="t('顶部对齐')" @click="alignLayer('top')"><AlignVerticalJustifyStart :size="14" /></button>
            <button :disabled="selected.locked" :title="t('垂直居中')" @click="alignLayer('middle')"><AlignVerticalJustifyCenter :size="14" /></button>
            <button :disabled="selected.locked" :title="t('底部对齐')" @click="alignLayer('bottom')"><AlignVerticalJustifyEnd :size="14" /></button>
          </div>
          <fieldset class="property-editor" :disabled="selected.locked">
          <label class="property wide"><span>{{ t("名称") }}</span><input v-model="selected.name" maxlength="24" /></label>
          <label class="property wide"><span>{{ t("显示条件") }}</span><select v-model="selected.condition"><option value="always">{{ t("始终显示") }}</option><option value="playing">{{ t("播放音乐时") }}</option><option value="paused">{{ t("音乐暂停时") }}</option><option value="headsetConnected">{{ t("耳机已连接时") }}</option><option value="headsetDisconnected">{{ t("耳机未连接时") }}</option></select></label>
          <p v-if="selectedExtensionStatus" :class="['extension-health', selectedExtensionStatus.tone]">{{ selectedExtensionStatus.label }}</p>
          <div v-if="selected.type !== 'pixels'" class="property-grid">
            <label class="property"><span>X</span><input v-model.number="selected.x" type="number" min="0" max="127" @change="normalize(selected)" /></label>
            <label class="property"><span>Y</span><input v-model.number="selected.y" type="number" min="0" max="63" @change="normalize(selected)" /></label>
            <label class="property"><span>{{ t("宽") }}</span><input v-model.number="selected.width" type="number" min="1" max="128" @change="normalize(selected)" /></label>
            <label class="property"><span>{{ t("高度") }}</span><input v-model.number="selected.height" type="number" min="1" max="64" @change="normalize(selected)" /></label>
          </div>
          <p v-else class="pixel-note">{{ t("像素画布覆盖完整的 128 x 64 屏幕，可与其他图层自由叠加。") }}</p>

          <template v-if="selected.type === 'text'">
            <label class="property wide"><span>{{ t("内容") }}</span><textarea v-model="selected.content" rows="2" maxlength="120" /></label>
            <div class="variable-palette">
              <button v-for="variable in variables" :key="variable" @click="insertVariable(variable)">{{ variable }}</button>
            </div>
            <div class="property-grid text-options">
              <label class="property"><span>{{ t("字号") }}</span><input v-model.number="selected.fontSize" type="number" min="6" max="28" @change="normalize(selected)" /></label>
              <label class="property"><span>{{ t("字重") }}</span><select v-model.number="selected.weight"><option :value="400">{{ t("常规") }}</option><option :value="700">{{ t("粗体") }}</option></select></label>
              <label class="property span-two"><span>{{ t("对齐") }}</span><select v-model="selected.align"><option value="left">{{ t("左") }}</option><option value="center">{{ t("居中") }}</option><option value="right">{{ t("右") }}</option></select></label>
            </div>
          </template>

          <template v-else-if="selected.type === 'bar'">
            <label class="property wide"><span>{{ t("数据") }}</span><select v-model="selected.source" @change="normalizeBarSource(selected)"><option value="cpu">CPU</option><option value="memory">{{ t("内存") }}</option><option value="progress">{{ t("音乐进度") }}</option><option value="battery">{{ t("耳机电池") }}</option><option value="spareBattery">{{ t("备用电池") }}</option><option value="volume">{{ t("音量") }}</option><option value="extension" :disabled="extensionValueSources.length === 0">{{ t("扩展数值") }}</option><option value="custom">{{ t("固定数值") }}</option></select></label>
            <label v-if="selected.source === 'extension'" class="property wide">
              <span>{{ t("扩展变量") }}</span>
              <select v-model="selected.valueVariable">
                <option v-if="selected.valueVariable && !hasExtensionValueSource(selected.valueVariable)" :value="selected.valueVariable">{{ t("已缺失：{value}", { value: selected.valueVariable }) }}</option>
                <option v-for="item in extensionValueSources" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>
            <label v-if="selected.source === 'extension'" class="property wide"><span>{{ t("无数据时 {value}%", { value: selected.value }) }}</span><input v-model.number="selected.value" type="range" min="0" max="100" /></label>
            <label v-if="selected.source === 'custom'" class="property wide"><span>{{ t("数值 {value}%", { value: selected.value }) }}</span><input v-model.number="selected.value" type="range" min="0" max="100" /></label>
          </template>

          <template v-else-if="selected.type === 'icon'">
            <label class="property wide">
              <span>{{ t("图标") }}</span>
              <select v-model="selected.icon" @change="normalizeIconSource(selected)">
                <option value="playback">{{ t("播放 / 暂停状态") }}</option>
                <option value="battery">{{ t("电池") }}</option>
                <option value="volume">{{ t("音量") }}</option>
                <option value="headset">{{ t("耳机连接状态") }}</option>
              </select>
            </label>
            <label v-if="selected.icon === 'battery'" class="property wide">
              <span>{{ t("电量来源") }}</span>
              <select v-model="selected.source"><option value="battery">{{ t("耳机电池") }}</option><option value="spareBattery">{{ t("备用电池") }}</option></select>
            </label>
            <label v-if="selected.icon === 'volume'" class="property wide">
              <span>{{ t("音量来源") }}</span>
              <select v-model="selected.source"><option value="volume">{{ t("当前音量") }}</option><option value="custom">{{ t("固定数值") }}</option></select>
            </label>
            <label v-if="selected.icon === 'volume' && selected.source === 'custom'" class="property wide"><span>{{ t("数值 {value}%", { value: selected.value }) }}</span><input v-model.number="selected.value" type="range" min="0" max="100" /></label>
          </template>

          <template v-else-if="selected.type === 'pixels'">
            <div class="pixel-tools">
              <button :class="{ active: selected.pixelTool !== 'erase' }" :title="t('铅笔')" @click="selected.pixelTool = 'draw'"><Pencil :size="15" />{{ t("铅笔") }}</button>
              <button :class="{ active: selected.pixelTool === 'erase' }" :title="t('橡皮擦')" @click="selected.pixelTool = 'erase'"><Eraser :size="15" />{{ t("橡皮") }}</button>
              <button class="clear-pixels" :title="t('清空像素画')" @click="clearPixels"><RotateCcw :size="15" />{{ t("清空") }}</button>
            </div>
          </template>

          <template v-else-if="selected.type === 'extension'">
            <label class="property wide">
              <span>{{ t("绘图扩展") }}</span>
              <select v-model="selected.extensionId" @change="applyExtensionDefaults(selected)">
                <option v-if="!rendererExtensions.length" value="">{{ t("没有已启用的绘图扩展") }}</option>
                <option v-for="extension in rendererExtensions" :key="extension.id" :value="extension.id">{{ t(extension.manifest.renderer?.label ?? '') }} · {{ t(extension.manifest.name) }}</option>
              </select>
            </label>
            <template v-for="setting in selectedExtension?.manifest.renderer?.settings ?? []" :key="setting.key">
              <label v-if="setting.type === 'range'" class="property wide">
                <span>{{ t(setting.label) }} {{ selected.extensionSettings?.[setting.key] }}</span>
                <input :value="selected.extensionSettings?.[setting.key]" type="range" :min="setting.min" :max="setting.max" :step="setting.step" @input="setExtensionSetting(selected, setting.key, Number(($event.target as HTMLInputElement).value))" />
              </label>
              <label v-else-if="setting.type === 'number'" class="property wide">
                <span>{{ t(setting.label) }}</span>
                <input :value="selected.extensionSettings?.[setting.key]" type="number" :min="setting.min" :max="setting.max" :step="setting.step" @input="setExtensionSetting(selected, setting.key, Number(($event.target as HTMLInputElement).value))" />
              </label>
              <label v-else-if="setting.type === 'select'" class="property wide">
                <span>{{ t(setting.label) }}</span>
                <select :value="selected.extensionSettings?.[setting.key]" @change="setExtensionSetting(selected, setting.key, ($event.target as HTMLSelectElement).value)">
                  <option v-for="option in setting.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </label>
              <label v-else class="visibility rect-fill"><input :checked="selected.extensionSettings?.[setting.key] === true" type="checkbox" @change="setExtensionSetting(selected, setting.key, ($event.target as HTMLInputElement).checked)" />{{ t(setting.label) }}</label>
            </template>
            <label class="visibility rect-fill"><input v-model="selected.invert" type="checkbox" />{{ t("反色扩展图层") }}</label>
          </template>

          <template v-else-if="selected.type === 'image'">
            <label class="property wide">
              <span>{{ t("图片素材") }}</span>
              <select v-model="selected.assetId">
                <option v-if="!imageAssets.length" :value="undefined">{{ t("没有已保存的图片") }}</option>
                <option v-for="asset in imageAssets" :key="asset.id" :value="asset.id">{{ asset.name }}</option>
              </select>
            </label>
            <label class="visibility rect-fill"><input v-model="selected.invert" type="checkbox" />{{ t("反色图片") }}</label>
          </template>

          <template v-else-if="selected.type === 'media'">
            <label class="property wide">
              <span>{{ t("动画素材") }}</span>
              <select v-model="selected.assetId">
                <option v-if="!mediaAssets.length" :value="undefined">{{ t("没有已保存的 GIF 或视频") }}</option>
                <option v-for="asset in mediaAssets" :key="asset.id" :value="asset.id">{{ asset.kind === 'gif' ? 'GIF' : t('视频') }} · {{ asset.name }}</option>
              </select>
            </label>
            <label class="visibility rect-fill"><input v-model="selected.invert" type="checkbox" />{{ t("反色动画") }}</label>
          </template>

          <label v-else class="visibility rect-fill"><input v-model="selected.filled" type="checkbox" />{{ t("填充{shape}", { shape: t(selected.type === 'ellipse' ? '椭圆' : '矩形') }) }}</label>
          </fieldset>
        </template>

        <button v-else class="empty-add" @click="addLayer('text')"><Plus :size="15" />{{ t("添加第一个图层") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scene-editor { display: flex; flex-direction: column; gap: 12px; }
.scene-toolbar { min-height: 34px; display: flex; align-items: end; justify-content: space-between; gap: 12px; }
.scene-title-tools { display: flex; align-items: end; gap: 7px; }
.scene-name { width: 220px; display: flex; flex-direction: column; gap: 5px; color: var(--muted); font-size: 9px; }
.scene-name input, .property input, .property select, .property textarea, .layer-heading select { width: 100%; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: 0; }
.scene-name input { height: 30px; padding: 0 8px; }
.scene-save-actions { display: flex; gap: 5px; }
.scene-save-actions button, .history-actions button { height: 30px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 9px; white-space: nowrap; }
.scene-save-actions button:hover { color: var(--green); border-color: #4b725b; }
.scene-save-actions button:disabled { opacity: .4; cursor: default; }
.scene-save-actions .primary-save { border-color: #45634f; background: var(--accent-soft); color: var(--green); }
.package-input { display: none; }
.history-actions { display: flex; align-items: center; gap: 4px; }
.history-actions button { width: 30px; padding: 0; justify-content: center; }
.history-actions button:hover:not(:disabled) { color: var(--green); border-color: #4b725b; }
.history-actions button:disabled, .inspector-actions button:disabled { opacity: .35; cursor: default; }
.history-actions label { height: 30px; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 3px; display: flex; align-items: center; gap: 5px; color: #89918e; font-size: 9px; cursor: pointer; }
.history-actions input { accent-color: var(--green); }
.add-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.add-actions button, .layer-heading button, .inspector-actions button, .empty-add { height: 30px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); display: inline-flex; align-items: center; justify-content: center; gap: 5px; cursor: pointer; font-size: 9px; }
.add-actions button:hover, .layer-heading button:hover, .inspector-actions button:hover { color: var(--green); border-color: #4b725b; }
.extension-add { height: 30px; display: flex; align-items: center; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: #818a86; overflow: hidden; }.extension-add > svg { margin-left: 8px; flex: 0 0 auto; }.extension-add select { width: 112px; height: 28px; padding: 0 5px; border: 0; outline: 0; background: transparent; color: var(--text-soft); font-size: 9px; }.extension-add select:disabled { color: #686f6c; }.extension-add button { width: 30px; height: 28px; padding: 0; border: 0; border-left: 1px solid var(--line-strong); border-radius: 0; }.extension-add button:disabled { opacity: .35; cursor: default; }
.dependency-report { min-height: 30px; padding: 5px 7px; border: 1px solid #353b39; background: var(--surface-subtle); display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dependency-report > strong { margin-right: 2px; color: var(--text-soft); font-size: 9px; }
.dependency-item { padding: 3px 6px; border: 1px solid #3e4743; border-radius: 2px; color: var(--muted); font-size: 8px; }
.dependency-item.ready { border-color: #3d654b; color: #85c99d; }.dependency-item.missing, .dependency-item.outdated { border-color: #71443d; color: #d99587; }.dependency-item.disabled { border-color: #6a5c35; color: #d2b66c; }
.dependency-report > button { margin-left: auto; width: 24px; height: 22px; padding: 0; border: 0; background: transparent; color: #777f7c; display: grid; place-items: center; cursor: pointer; }.dependency-report > button:hover { color: var(--text-soft); }
.scene-library { padding: 10px; border: 1px solid var(--line); background: var(--surface-sidebar); }
.scene-library-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
.builtin-template-list + .scene-library-heading { margin-top: 10px; }
.scene-library-heading strong { color: var(--text-soft); font-size: 10px; font-weight: 600; }
.scene-library-heading span { color: var(--muted-soft); font: 8px/1 var(--mono); }
.scene-library-tools > div { display: flex; align-items: center; gap: 7px; }
.scene-library-filters { display: flex; align-items: center; gap: 5px; }
.scene-library-filters > button { width: 27px; height: 27px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); color: #747d79; display: grid; place-items: center; cursor: pointer; }
.scene-library-filters > button:hover, .scene-library-filters > button.active { border-color: #4b725b; color: var(--green); }
.scene-search { width: 180px; height: 27px; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); display: flex; align-items: center; gap: 6px; color: #66706c; }
.scene-search:focus-within { border-color: #4b725b; color: var(--green); }
.scene-search input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-soft); font-size: 9px; }
.scene-search input::-webkit-search-cancel-button { display: none; }
.builtin-template-list { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.builtin-template-list button { min-width: 0; height: 39px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); text-align: left; cursor: pointer; }
.builtin-template-list button:hover { border-color: #4b725b; background: var(--accent-soft); }
.builtin-template-list strong, .builtin-template-list span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.builtin-template-list strong { color: #d2d8d5; font-size: 9px; font-weight: 600; }
.builtin-template-list span { margin-top: 3px; color: var(--muted-soft); font-size: 8px; }
.scene-preset-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 7px; }
.scene-preset { min-width: 0; height: 78px; padding: 6px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); display: flex; gap: 9px; cursor: pointer; outline: 0; }
.scene-preset:hover, .scene-preset:focus-visible { border-color: #53605b; }
.scene-preset.active { border-color: var(--green); background: var(--accent-soft); }
.extension-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; gap: 4px; overflow: hidden; border: 1px dashed #8a9691; color: #c8d0cc; background: rgba(255,255,255,.04); }.extension-placeholder b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 8px; font-weight: 500; }
.preset-detail { min-width: 0; flex: 1; padding: 2px 0; display: flex; flex-direction: column; }
.preset-detail > strong, .preset-detail > span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-detail > strong { color: #d6dcda; font-size: 9px; font-weight: 600; }
.preset-detail > span { margin-top: 4px; color: #69716e; font-size: 8px; }
.preset-actions { margin-top: auto; display: flex; gap: 3px; }
.preset-actions button { width: 24px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: #6e7773; display: grid; place-items: center; cursor: pointer; }
.preset-actions button:hover, .preset-actions button.favorite { background: var(--accent-soft); color: var(--green); }
.preset-actions button.delete:hover { background: #352321; color: #e19a8c; }
.scene-library-empty { height: 34px; border: 1px dashed var(--line-strong); display: grid; place-items: center; color: #606865; font-size: 9px; }
.designer-grid { display: grid; grid-template-columns: 526px minmax(250px, 1fr); gap: 14px; align-items: start; }
.canvas-scroll { padding: 6px; overflow: auto; border: 1px solid var(--line); background: var(--bg); }
.scene-canvas { position: relative; width: 512px; height: 256px; overflow: hidden; background-color: #030404; background-image: linear-gradient(rgba(130, 150, 140, .18) 1px, transparent 1px), linear-gradient(90deg, rgba(130, 150, 140, .18) 1px, transparent 1px); background-size: 16px 16px; box-shadow: inset 0 0 0 1px rgba(130, 150, 140, .28); image-rendering: pixelated; outline: 0; }
.scene-canvas:focus-visible { box-shadow: inset 0 0 0 1px #4b725b; }
.snap-guide { position: absolute; z-index: 20; pointer-events: none; background: rgba(102, 231, 153, .7); }
.snap-guide.vertical { top: 0; bottom: 0; width: 1px; }
.snap-guide.horizontal { left: 0; right: 0; height: 1px; }
.scene-layer { position: absolute; min-width: 0; min-height: 0; padding: 0; overflow: hidden; border: 1px dashed transparent; background: transparent; color: #fff; cursor: move; user-select: none; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1; }
.scene-layer:hover { border-color: #69716e; }
.scene-layer.selected { border-color: var(--green); outline: 1px solid rgba(102, 231, 153, .25); z-index: 5; }
.scene-layer.locked { cursor: default; }
.scene-layer.condition-inactive { opacity: .3; filter: grayscale(1); }
.scene-layer.condition-inactive.selected { opacity: .58; }
.scene-layer.locked.selected { border-color: #e9b95f; outline-color: rgba(233, 185, 95, .22); }
.resize-handle { position: absolute; z-index: 8; width: 6px; height: 6px; border: 1px solid #0f1612; background: var(--green); }
.resize-handle.nw { left: 0; top: 0; cursor: nwse-resize; }.resize-handle.n { left: calc(50% - 3px); top: 0; cursor: ns-resize; }.resize-handle.ne { right: 0; top: 0; cursor: nesw-resize; }
.resize-handle.e { right: 0; top: calc(50% - 3px); cursor: ew-resize; }.resize-handle.se { right: 0; bottom: 0; cursor: nwse-resize; }.resize-handle.s { left: calc(50% - 3px); bottom: 0; cursor: ns-resize; }
.resize-handle.sw { left: 0; bottom: 0; cursor: nesw-resize; }.resize-handle.w { left: 0; top: calc(50% - 3px); cursor: ew-resize; }
.scene-layer.text { display: flex; align-items: flex-start; white-space: nowrap; }
.layer-text { display: block; max-width: 100%; overflow: hidden; text-overflow: clip; }
.scene-layer.bar { display: flex; align-items: stretch; border: 2px solid #fff; }
.layer-bar { width: 100%; display: block; padding: 4px; }
.layer-bar i { display: block; height: 100%; background: #fff; }
.scene-layer.rect { border: 2px solid #fff; }
.scene-layer.rect.filled { background: #fff; }
.scene-layer.ellipse { border: 2px solid #fff; border-radius: 50%; }
.scene-layer.ellipse.filled { background: #fff; }
.scene-layer.image img, .scene-layer.media img, .scene-layer.media video { display: block; width: 100%; height: 100%; object-fit: fill; image-rendering: pixelated; pointer-events: none; }
.scene-layer.pixels { overflow: visible; }
.inspector { min-height: 256px; display: flex; flex-direction: column; gap: 9px; }
.layer-heading { display: grid; grid-template-columns: 1fr 30px 30px; gap: 5px; }
.layer-heading strong { height: 30px; padding: 0 8px; border: 1px solid var(--line-strong); display: flex; align-items: center; justify-content: space-between; color: #c9cecc; font-size: 10px; font-weight: 600; }
.layer-heading strong span { color: var(--muted-soft); font: 8px/1 var(--mono); }
.layer-heading button, .inspector-actions button { width: 30px; padding: 0; }
.layer-heading button:disabled { opacity: .35; cursor: default; }
.layer-list { max-height: 145px; overflow: auto; border: 1px solid var(--line); background: var(--bg); }
.layer-row { min-height: 30px; padding: 3px 4px; display: grid; grid-template-columns: 18px minmax(0, 1fr) 25px 25px; align-items: center; gap: 3px; border-bottom: 1px solid var(--line); color: #7c8581; cursor: pointer; }
.layer-row:last-child { border-bottom: 0; }
.layer-row:hover { background: var(--control-hover); }
.layer-row.active { background: var(--accent-soft); box-shadow: inset 2px 0 var(--green); color: var(--green); }
.layer-row.hidden { opacity: .56; }
.layer-row .grip { color: #565f5b; cursor: grab; }
.layer-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c4cac7; font-size: 9px; }
.layer-row > button { width: 25px; height: 24px; padding: 0; border: 0; border-radius: 2px; display: grid; place-items: center; background: transparent; color: #747d79; cursor: pointer; }
.layer-row > button:hover { background: var(--accent-soft); color: var(--green); }
.inspector-actions { display: flex; align-items: center; justify-content: flex-end; gap: 5px; }
.inspector-actions .action-spacer { flex: 1; }
.alignment-actions { min-height: 29px; display: grid; grid-template-columns: 1fr repeat(6, 28px); align-items: center; gap: 4px; }
.alignment-actions > span { color: var(--muted); font-size: 9px; }
.alignment-actions button { width: 28px; height: 28px; padding: 0; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: #8a928f; display: grid; place-items: center; cursor: pointer; }
.alignment-actions button:hover:not(:disabled) { border-color: #4b725b; color: var(--green); }
.alignment-actions button:disabled { opacity: .35; cursor: default; }
.visibility { margin-right: auto; display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 9px; }
.visibility input { accent-color: var(--green); }
.property-editor { min-width: 0; margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 9px; }
.property-editor:disabled { opacity: .58; }
.property-editor input:disabled, .property-editor select:disabled, .property-editor textarea:disabled, .property-editor button:disabled { cursor: not-allowed; }
.extension-health { margin: 0; padding: 6px 7px; border-left: 2px solid #48504d; background: var(--surface-subtle); color: #939b98; font-size: 9px; line-height: 1.35; overflow-wrap: anywhere; }.extension-health.ready { border-color: #4d7659; color: #88b997; }.extension-health.warning, .extension-health.waiting { border-color: #806d39; color: #c8af68; }.extension-health.error { border-color: #844940; color: #d18b80; }
.property-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.property { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 9px; }
.property input, .property select { height: 28px; padding: 0 7px; font-size: 10px; }
.property textarea { padding: 7px; resize: none; font: 10px/1.35 "Segoe UI", sans-serif; }
.property.wide, .span-two { grid-column: 1 / -1; }
.variable-palette { display: flex; flex-wrap: wrap; gap: 4px; }
.variable-palette button { height: 21px; padding: 0 5px; border: 1px solid var(--line-strong); border-radius: 2px; background: var(--surface-subtle); color: #829087; cursor: pointer; font: 8px/1 var(--mono); }
.variable-palette button:hover { color: var(--green); border-color: #4b725b; }
.text-options { grid-template-columns: 1fr 1fr; }
.rect-fill { margin-top: 4px; }
.pixel-note { margin: 0; color: #747c79; font-size: 9px; line-height: 1.45; }
.pixel-tools { display: flex; gap: 5px; }
.pixel-tools button { height: 29px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--muted); display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 9px; }
.pixel-tools button.active { color: var(--green); border-color: #4b725b; background: var(--accent-soft); }
.pixel-tools .clear-pixels { margin-left: auto; color: #b98f87; }
.empty-add { align-self: center; margin: auto; }
@media (max-width: 1250px) { .scene-toolbar { align-items: flex-start; flex-direction: column; } .scene-name { flex: 0 0 180px; } .add-actions { justify-content: flex-start; } }
@media (max-width: 1050px) { .scene-title-tools { width: 100%; flex-wrap: wrap; } .scene-save-actions { flex-wrap: wrap; } }
@media (max-width: 720px) { .scene-title-tools { width: 100%; align-items: stretch; flex-direction: column; } .scene-name { width: 100%; } .scene-save-actions { flex-wrap: wrap; } }
@media (max-width: 980px) { .designer-grid { grid-template-columns: 1fr; } .canvas-scroll { width: fit-content; max-width: 100%; } }
</style>
