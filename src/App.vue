<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import DeviceStatus from "./components/DeviceStatus.vue";
import OledPreview from "./components/OledPreview.vue";
import Sidebar from "./components/Sidebar.vue";
import TitleBar from "./components/TitleBar.vue";
import { getLibraryItem } from "./services/library";
import { chooseLibraryBackup, createLibraryBackup, restoreLibraryBackup, saveLibraryBackup } from "./services/libraryBackup";
import { DisplayProtectionController } from "./services/displayProtection";
import { useI18n } from "./services/i18n";
import { migrateScene } from "./services/scene";
import { api, inTauri } from "./services/tauri";
import { defaultConfig, defaultScene, type AutomationEntry, type AutomationPlan, type AutomationTrigger, type AutomationTriggerType, type DetectedDevice, type DeviceInfo, type GameSenseStatus, type SceneConfig, type StartupStatus, type SystemMetrics } from "./types";
import AutomationView from "./views/AutomationView.vue";
import DisplayEditor from "./views/DisplayEditor.vue";
import SettingsView from "./views/SettingsView.vue";
import StatusView from "./views/StatusView.vue";

const currentView = ref<"editor" | "automation" | "status" | "settings">("editor");
const { t } = useI18n();

function loadScene(): SceneConfig {
  try {
    const saved = JSON.parse(localStorage.getItem("nova-oled-scene") || "null") as unknown;
    if (saved) return migrateScene(saved);
  } catch { /* Invalid local data falls back to the built-in scene. */ }
  return structuredClone(defaultScene);
}

const initialConfig = structuredClone(defaultConfig);
initialConfig.scene = loadScene();
initialConfig.sceneLibraryId = localStorage.getItem("nova-oled-scene-id") || "";
const config = reactive(initialConfig);
const preview = ref<InstanceType<typeof OledPreview>>();
const device = reactive<DeviceInfo>({
  connected: false, deviceId: "", product: "未连接", productId: 0, interfaceNumber: 0,
  oledReportId: 0, width: 128, height: 64, battery: 0, batteryAvailable: false,
  spareBattery: 0, spareBatteryAvailable: false, headsetConnected: false,
  volume: 0, gameVolume: 100, chatVolume: 100, charging: false,
});
const metrics = reactive<SystemMetrics>({ cpu: 0, memory: 0, usedMemoryGb: 0, totalMemoryGb: 0 });
const brightness = ref(6);
const autoConnect = ref(localStorage.getItem("nova-auto-connect") !== "false");
const deviceSelection = ref(localStorage.getItem("nova-device-selection") || "auto");
const detectedDevices = ref<DetectedDevice[]>([]);
const devicesBusy = ref(false);
const allowedFps = [5, 10, 15, 20, 30];
const savedFps = Number(localStorage.getItem("nova-oled-fps"));
const fps = ref(allowedFps.includes(savedFps) ? savedFps : 10);
const allowedSleepMinutes = [5, 10, 30, 60];
const savedSleepMinutes = Number(localStorage.getItem("nova-oled-sleep-minutes"));
const pixelShiftEnabled = ref(localStorage.getItem("nova-oled-pixel-shift") === "true");
const staticSleepEnabled = ref(localStorage.getItem("nova-oled-static-sleep") === "true");
const staticSleepMinutes = ref(allowedSleepMinutes.includes(savedSleepMinutes) ? savedSleepMinutes : 10);
const displaySleeping = ref(false);
const gameSense = ref<GameSenseStatus>();
const gameSenseBusy = ref(false);
const startup = ref<StartupStatus>({ supported: false, enabled: false, target: "" });
const startupBusy = ref(false);
const backupBusy = ref(false);
const live = ref(false);
const LIVE_DISPLAY_STORAGE_KEY = "nova-live-display-enabled";
const liveResumeRequested = ref(localStorage.getItem(LIVE_DISPLAY_STORAGE_KEY) === "true");
const busy = ref(false);
const automationRunning = ref(false);
const activeAutomationPlanId = ref("");
const automationPlan = ref<AutomationPlan>();
const automationIndex = ref(0);
const automationEndsAt = ref(0);
const activeAutomationTrigger = ref<AutomationTriggerType | "">("");
const toast = ref("");
const toastError = ref(false);
let toastTimer = 0;
let statusTimer = 0;
let dynamicDataTimer = 0;
let dynamicDataPollToken = 0;
let appMounted = false;
let automationTimer = 0;
let automationApplyToken = 0;
let reconnectTimer = 0;
let scenePersistenceTimer = 0;
let reconnecting = false;
let reconnectResume: { live: boolean; plan?: AutomationPlan; planId: string } | undefined;
let frameBusy = false;
const displayProtection = new DisplayProtectionController();

function assignDevice(value: DeviceInfo) { Object.assign(device, value); }
function clearDevice() {
  Object.assign(device, {
    connected: false, deviceId: "", product: "未连接", productId: 0, interfaceNumber: 0,
    oledReportId: 0, width: 128, height: 64, battery: 0, batteryAvailable: false,
    spareBattery: 0, spareBatteryAvailable: false, headsetConnected: false,
    volume: 0, gameVolume: 100, chatVolume: 100, charging: false,
  });
}
function notify(message: string, error = false) {
  toast.value = message;
  toastError.value = error;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.value = "", 3200);
}
function persistCurrentScene() {
  window.clearTimeout(scenePersistenceTimer);
  scenePersistenceTimer = 0;
  localStorage.setItem("nova-oled-scene", JSON.stringify(config.scene));
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function setLiveResumeRequested(value: boolean) {
  liveResumeRequested.value = value;
  localStorage.setItem(LIVE_DISPLAY_STORAGE_KEY, String(value));
}
async function activateLiveDisplay(showMessage: boolean) {
  await api.setBrightness(brightness.value);
  displayProtection.reset();
  displaySleeping.value = false;
  live.value = true;
  if (showMessage) notify(t("实时显示已启动"));
}
async function resumeLiveDisplay() {
  if (!liveResumeRequested.value || !device.connected || live.value) return;
  try { await activateLiveDisplay(false); }
  catch (error) { notify(t("恢复实时显示失败：{error}", { error: errorText(error) }), true); }
}

function cancelReconnect(clearResume = true) {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  reconnecting = false;
  if (clearResume) reconnectResume = undefined;
}

function scheduleReconnect() {
  if (!inTauri() || !autoConnect.value || device.connected || reconnectTimer || reconnecting) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = 0;
    void attemptReconnect();
  }, 4000);
}

async function attemptReconnect() {
  if (!autoConnect.value || device.connected || reconnecting) return;
  reconnecting = true;
  try {
    await api.disconnect().catch(() => undefined);
    const selected = deviceSelection.value === "auto" ? undefined : deviceSelection.value;
    assignDevice(await api.connect(selected));
    const resume = reconnectResume;
    reconnectResume = undefined;
    if (resume?.plan) await startAutomation(resume.plan, resume.planId);
    else if (resume?.live) {
      await activateLiveDisplay(false);
    }
    await resumeLiveDisplay();
    notify(t("设备已重新连接：{name}", { name: device.product }));
  } catch {
    clearDevice();
  } finally {
    reconnecting = false;
    if (!device.connected) scheduleReconnect();
  }
}

function handleConnectionLoss(reason: string) {
  if (!reconnectResume) {
    reconnectResume = {
      live: live.value,
      plan: automationRunning.value && automationPlan.value ? structuredClone(automationPlan.value) : undefined,
      planId: activeAutomationPlanId.value,
    };
  }
  stopAutomationState();
  live.value = false;
  displaySleeping.value = false;
  clearDevice();
  notify(t("设备通信中断，正在等待自动重连：{reason}", { reason }), true);
  scheduleReconnect();
}

async function connect() {
  if (!inTauri()) { notify(t("浏览器模式仅用于预览，请在 Tauri 桌面窗口中连接设备"), true); return; }
  busy.value = true;
  try {
    cancelReconnect(false);
    const selected = deviceSelection.value === "auto" ? undefined : deviceSelection.value;
    assignDevice(await api.connect(selected));
    reconnectResume = undefined;
    notify(t("已连接 {name}", { name: device.product }));
    await refreshStatus();
    await scanDevices(false);
    await resumeLiveDisplay();
  }
  catch (error) { clearDevice(); notify(errorText(error), true); scheduleReconnect(); }
  finally { busy.value = false; }
}
async function disconnect() {
  cancelReconnect();
  stopAutomationState();
  setLiveResumeRequested(false);
  live.value = false;
  displaySleeping.value = false;
  busy.value = true;
  try { await api.disconnect(); clearDevice(); await scanDevices(false); notify(t("设备已断开")); }
  catch (error) { notify(errorText(error), true); }
  finally { busy.value = false; }
}
async function scanDevices(showMessage = true) {
  if (!inTauri()) return;
  devicesBusy.value = true;
  try {
    detectedDevices.value = await api.devices();
    if (showMessage) {
      notify(detectedDevices.value.length > 0
        ? t("检测到 {count} 个耳机基座", { count: detectedDevices.value.length })
        : t("未检测到 SteelSeries 耳机基座"), detectedDevices.value.length === 0);
    }
  } catch (error) { notify(errorText(error), true); }
  finally { devicesBusy.value = false; }
}
async function updateDeviceSelection(value: string) {
  deviceSelection.value = value;
  localStorage.setItem("nova-device-selection", value);
  if (!device.connected || value === "auto" || value === device.deviceId) return;

  cancelReconnect();
  stopAutomationState();
  live.value = false;
  busy.value = true;
  try {
    await api.disconnect();
    clearDevice();
    assignDevice(await api.connect(value));
    await resumeLiveDisplay();
    await scanDevices(false);
    notify(t("已切换到 {name}", { name: device.product }));
  } catch (error) { notify(errorText(error), true); }
  finally { busy.value = false; }
}
async function refreshStatus() {
  if (!device.connected || !inTauri()) return;
  try { assignDevice(await api.status()); void evaluateAutomationTrigger(); }
  catch (error) { handleConnectionLoss(errorText(error)); }
}
const sceneNeedsMetrics = computed(() => config.mode === "scene" && config.scene.layers.some(layer =>
  layer.visible && (layer.source === "cpu" || layer.source === "memory" || /\{(?:cpu|memory)\}/.test(layer.content)),
));
const sceneNeedsExtensionInput = computed(() => config.mode === "scene" && config.scene.layers.some(layer =>
  layer.visible && (layer.type === "extension" || layer.source === "extension" || Boolean(layer.valueVariable)),
));
const sceneNeedsMedia = computed(() => config.mode === "scene" && config.scene.layers.some(layer =>
  layer.visible && (layer.source === "progress"
    || layer.icon === "playback"
    || layer.condition === "playing"
    || layer.condition === "paused"
    || /\{(?:track|artist|progress|playing)\}/.test(layer.content)),
));
const systemMetricsNeeded = computed(() => currentView.value === "status" || config.mode === "system"
  || sceneNeedsMetrics.value || sceneNeedsExtensionInput.value);
const mediaInfoNeeded = computed(() => config.autoMedia && (
  config.mode === "music"
  || sceneNeedsMedia.value
  || sceneNeedsExtensionInput.value
  || Boolean(automationRunning.value && automationPlan.value?.triggers?.some(trigger => trigger.type === "playing"))
));
const activeExtensionEventIds = computed(() => automationRunning.value && automationPlan.value
  ? [...new Set(automationPlan.value.triggers
    ?.filter(trigger => trigger.type === "extensionEvent" && trigger.extensionId)
    .map(trigger => trigger.extensionId as string) ?? [])]
  : []);

async function refreshDynamicData() {
  if (!inTauri()) return;
  const tasks: Promise<void>[] = [];
  if (systemMetricsNeeded.value) {
    tasks.push(api.metrics().then(value => { Object.assign(metrics, value); }).catch(() => undefined));
  }
  if (mediaInfoNeeded.value) {
    tasks.push(api.media().then(media => {
      if (media.title) config.track = media.title;
      if (media.artist) config.artist = media.artist;
      config.progress = media.progress;
      config.playing = media.playing;
      void evaluateAutomationTrigger();
    }).catch(() => undefined));
  }
  await Promise.all(tasks);
}

function dynamicDataPollingAllowed() {
  return (systemMetricsNeeded.value || mediaInfoNeeded.value)
    && (!document.hidden || live.value || automationRunning.value);
}

function restartDynamicDataPolling() {
  window.clearTimeout(dynamicDataTimer);
  dynamicDataTimer = 0;
  const token = ++dynamicDataPollToken;
  if (!appMounted || !dynamicDataPollingAllowed()) return;
  const poll = async () => {
    await refreshDynamicData();
    if (token !== dynamicDataPollToken || !dynamicDataPollingAllowed()) return;
    dynamicDataTimer = window.setTimeout(() => void poll(), 1000);
  };
  void poll();
}

function scheduleStatusPolling() {
  window.clearTimeout(statusTimer);
  statusTimer = 0;
  if (!appMounted || !inTauri() || !device.connected) return;
  statusTimer = window.setTimeout(async () => {
    await refreshStatus();
    scheduleStatusPolling();
  }, document.hidden ? 10_000 : 5_000);
}

function handleVisibilityChange() {
  scheduleStatusPolling();
  restartDynamicDataPolling();
}
async function updateBrightness(value: number) {
  brightness.value = value;
  if (!device.connected) return;
  try { await api.setBrightness(value); } catch (error) { notify(errorText(error), true); }
}
async function sendCurrent() {
  if (!device.connected) { notify(t("请先连接基座"), true); return; }
  const frame = preview.value?.getFrame();
  if (!frame) return;
  busy.value = true;
  try { await api.setBrightness(brightness.value); await api.sendFrame(frame); notify(t("当前画面已发送")); }
  catch (error) { notify(errorText(error), true); }
  finally { busy.value = false; }
}
async function startLive() {
  if (!device.connected) { notify(t("请先连接基座"), true); return; }
  stopAutomationState();
  try {
    await activateLiveDisplay(true);
    setLiveResumeRequested(true);
  }
  catch (error) { notify(errorText(error), true); }
}
async function sendLiveFrame(frame: number[]) {
  if (!live.value || frameBusy || !device.connected) return;
  frameBusy = true;
  try {
    if (pixelShiftEnabled.value || staticSleepEnabled.value) {
      const protectedFrame = displayProtection.process(frame, {
        pixelShift: pixelShiftEnabled.value,
        staticSleep: staticSleepEnabled.value,
        sleepAfterMs: staticSleepMinutes.value * 60_000,
      });
      displaySleeping.value = protectedFrame.sleeping;
      await api.sendFrame(protectedFrame.frame);
    } else {
      displaySleeping.value = false;
      await api.sendFrame(frame);
    }
  }
  catch (error) {
    handleConnectionLoss(errorText(error));
  }
  finally { frameBusy = false; }
}
async function stopLive() {
  stopAutomationState();
  setLiveResumeRequested(false);
  live.value = false;
  displaySleeping.value = false;
  busy.value = true;
  try { await api.stopDisplay(); notify(t("已恢复基座默认界面")); }
  catch (error) { notify(errorText(error), true); }
  finally { busy.value = false; }
}
function updateAutoConnect(value: boolean) {
  autoConnect.value = value;
  localStorage.setItem("nova-auto-connect", String(value));
  if (value) scheduleReconnect();
  else cancelReconnect();
  notify(t(value ? "启动时自动连接已开启" : "启动时自动连接已关闭"));
}
async function refreshStartupStatus() {
  if (!inTauri()) return;
  try { startup.value = await api.startupStatus(); } catch { startup.value = { supported: false, enabled: false, target: "" }; }
}
function handleWindowFocus() {
  scheduleReconnect();
  void refreshStartupStatus();
}
async function updateLaunchOnStartup(value: boolean) {
  if (!inTauri()) return;
  startupBusy.value = true;
  try {
    startup.value = await api.setStartup(value);
    notify(t(startup.value.enabled ? "已开启开机自启动" : "已关闭开机自启动"));
  } catch (error) { notify(errorText(error), true); }
  finally { startupBusy.value = false; }
}
function updateFps(value: number) {
  if (!allowedFps.includes(value)) return;
  fps.value = value;
  localStorage.setItem("nova-oled-fps", String(value));
  notify(t("OLED 最高帧率已设为 {value} FPS", { value }));
}

function resetDisplayProtection() {
  displayProtection.reset();
  displaySleeping.value = false;
}

function updatePixelShift(value: boolean) {
  pixelShiftEnabled.value = value;
  localStorage.setItem("nova-oled-pixel-shift", String(value));
  resetDisplayProtection();
  notify(t(value ? "OLED 防烧屏微移已开启" : "OLED 防烧屏微移已关闭"));
}

function updateStaticSleep(value: boolean) {
  staticSleepEnabled.value = value;
  localStorage.setItem("nova-oled-static-sleep", String(value));
  resetDisplayProtection();
  notify(t(value ? "OLED 静态画面休眠已开启" : "OLED 静态画面休眠已关闭"));
}

function updateStaticSleepMinutes(value: number) {
  if (!allowedSleepMinutes.includes(value)) return;
  staticSleepMinutes.value = value;
  localStorage.setItem("nova-oled-sleep-minutes", String(value));
  resetDisplayProtection();
  notify(t("静态画面将在 {value} 分钟后休眠", { value }));
}

async function exportBackup() {
  backupBusy.value = true;
  try {
    const output = await createLibraryBackup({
      autoConnect: autoConnect.value,
      fps: fps.value,
      pixelShiftEnabled: pixelShiftEnabled.value,
      staticSleepEnabled: staticSleepEnabled.value,
      staticSleepMinutes: staticSleepMinutes.value,
      currentScene: config.scene,
      currentSceneLibraryId: config.sceneLibraryId,
      currentAutomationPlanId: localStorage.getItem("nova-automation-plan-id") || "",
    });
    if (await saveLibraryBackup(output.blob, output.fileName)) {
      notify(t("完整备份已导出：{items} 个主题，{extensions} 个扩展", { items: output.itemCount, extensions: output.extensionCount }));
    }
  } catch (error) {
    notify(t("导出备份失败：{error}", { error: errorText(error) }), true);
  } finally {
    backupBusy.value = false;
  }
}

async function restoreBackup() {
  backupBusy.value = true;
  try {
    const file = await chooseLibraryBackup();
    if (!file) return;
    const result = await restoreLibraryBackup(file);
    autoConnect.value = result.preferences.autoConnect;
    fps.value = result.preferences.fps;
    pixelShiftEnabled.value = result.preferences.pixelShiftEnabled;
    staticSleepEnabled.value = result.preferences.staticSleepEnabled;
    staticSleepMinutes.value = result.preferences.staticSleepMinutes;
    config.scene = migrateScene(result.preferences.currentScene);
    config.sceneLibraryId = result.preferences.currentSceneLibraryId;
    localStorage.setItem("nova-auto-connect", String(autoConnect.value));
    localStorage.setItem("nova-oled-fps", String(fps.value));
    localStorage.setItem("nova-oled-pixel-shift", String(pixelShiftEnabled.value));
    localStorage.setItem("nova-oled-static-sleep", String(staticSleepEnabled.value));
    localStorage.setItem("nova-oled-sleep-minutes", String(staticSleepMinutes.value));
    resetDisplayProtection();
    localStorage.setItem("nova-oled-scene", JSON.stringify(config.scene));
    localStorage.setItem("nova-oled-scene-id", config.sceneLibraryId);
    if (result.preferences.currentAutomationPlanId) {
      localStorage.setItem("nova-automation-plan-id", result.preferences.currentAutomationPlanId);
    }
    window.dispatchEvent(new Event("nova-library-changed"));
    notify(t("备份已合并恢复：{items} 个主题，{extensions} 个扩展", { items: result.itemCount, extensions: result.extensionCount }));
  } catch (error) {
    notify(t("恢复备份失败：{error}", { error: errorText(error) }), true);
  } finally {
    backupBusy.value = false;
  }
}

function releaseMediaUrl() {
  if (config.mediaUrl) URL.revokeObjectURL(config.mediaUrl);
  config.mediaUrl = "";
  config.mediaLibraryId = "";
  config.mediaKind = "";
  config.mediaName = "";
}

function stopAutomationState() {
  window.clearTimeout(automationTimer);
  automationTimer = 0;
  automationApplyToken += 1;
  automationRunning.value = false;
  automationEndsAt.value = 0;
  activeAutomationTrigger.value = "";
}

async function applyAutomationEntry(entry: AutomationEntry, token: number) {
  if (!entry.libraryId) {
    if (token !== automationApplyToken) return false;
    releaseMediaUrl();
    config.mode = entry.mode;
    return true;
  }

  const item = await getLibraryItem(entry.libraryId);
  if (token !== automationApplyToken) return false;
  if (!item) throw new Error(t("编排项目“{name}”引用的主题已不存在", { name: entry.name }));

  if (item.kind === "scene" && item.scene) {
    releaseMediaUrl();
    config.scene = migrateScene(item.scene);
    config.sceneLibraryId = item.id;
    config.mode = "scene";
    return true;
  }
  if (item.kind === "text") {
    releaseMediaUrl();
    config.text = item.text ?? "";
    config.fontSize = item.fontSize ?? 20;
    config.align = item.align ?? "center";
    config.mode = "text";
    return true;
  }
  if ((item.kind === "image" || item.kind === "gif" || item.kind === "video") && item.blob) {
    releaseMediaUrl();
    config.mediaUrl = URL.createObjectURL(item.blob);
    config.mediaLibraryId = item.id;
    config.mediaKind = item.kind;
    config.mediaName = item.name;
    if (item.mediaSettings) Object.assign(config, item.mediaSettings);
    config.mode = item.kind === "image" ? "image" : "media";
    return true;
  }
  throw new Error(t("编排项目“{name}”无法加载", { name: entry.name }));
}

async function playAutomationIndex(index: number) {
  const plan = automationPlan.value;
  if (!automationRunning.value || activeAutomationTrigger.value || !plan?.entries.length) return;
  window.clearTimeout(automationTimer);
  const normalized = (index % plan.entries.length + plan.entries.length) % plan.entries.length;
  const entry = plan.entries[normalized];
  const token = ++automationApplyToken;
  try {
    if (!await applyAutomationEntry(entry, token) || token !== automationApplyToken) return;
    automationIndex.value = normalized;
    const duration = Math.max(2, Math.min(3600, Math.round(entry.duration || 10)));
    automationEndsAt.value = Date.now() + duration * 1000;
    automationTimer = window.setTimeout(() => void playAutomationIndex(normalized + 1), duration * 1000);
  } catch (error) {
    const shouldRestore = device.connected && inTauri();
    stopAutomationState();
    live.value = false;
    if (shouldRestore) await api.stopDisplay().catch(() => undefined);
    notify(errorText(error), true);
  }
}

function matchingAutomationTrigger(plan?: AutomationPlan): AutomationTrigger | undefined {
  if (!plan?.triggers?.length) return undefined;
  return plan.triggers.find(trigger => trigger.type === "batteryLow" && device.batteryAvailable && device.battery <= (trigger.threshold ?? 20))
    ?? plan.triggers.find(trigger => trigger.type === "playing" && config.playing);
}

async function evaluateAutomationTrigger() {
  if (!automationRunning.value || !automationPlan.value) return false;
  if (activeAutomationTrigger.value === "extensionEvent") return true;
  const trigger = matchingAutomationTrigger(automationPlan.value);
  const nextType = trigger?.type ?? "";
  if (nextType === activeAutomationTrigger.value) return Boolean(trigger);
  const previousType = activeAutomationTrigger.value;
  window.clearTimeout(automationTimer);
  automationTimer = 0;
  activeAutomationTrigger.value = nextType;
  automationEndsAt.value = 0;
  if (!trigger) {
    if (previousType) void playAutomationIndex(automationIndex.value);
    return false;
  }
  const token = ++automationApplyToken;
  try {
    await applyAutomationEntry(trigger.entry, token);
  } catch (error) {
    const shouldRestore = device.connected && inTauri();
    stopAutomationState();
    live.value = false;
    if (shouldRestore) await api.stopDisplay().catch(() => undefined);
    notify(errorText(error), true);
    return false;
  }
  return true;
}

async function handleExtensionEvent(event: Event) {
  if (!automationRunning.value || !automationPlan.value) return;
  const detail = (event as CustomEvent<{ extensionId?: string; name?: string }>).detail;
  if (!detail?.extensionId || !detail.name || activeAutomationTrigger.value === "batteryLow") return;
  const trigger = automationPlan.value.triggers?.find(item => item.type === "extensionEvent"
    && item.extensionId === detail.extensionId
    && item.eventKey === detail.name);
  if (!trigger) return;
  window.clearTimeout(automationTimer);
  automationTimer = 0;
  activeAutomationTrigger.value = "extensionEvent";
  const token = ++automationApplyToken;
  try {
    if (!await applyAutomationEntry(trigger.entry, token) || token !== automationApplyToken) return;
    const duration = Math.max(2, Math.min(3600, Math.round(trigger.entry.duration || 10)));
    automationEndsAt.value = Date.now() + duration * 1000;
    automationTimer = window.setTimeout(() => {
      if (!automationRunning.value || activeAutomationTrigger.value !== "extensionEvent") return;
      activeAutomationTrigger.value = "";
      automationEndsAt.value = 0;
      void evaluateAutomationTrigger().then(active => {
        if (!active) void playAutomationIndex(automationIndex.value);
      });
    }, duration * 1000);
  } catch (error) {
    stopAutomationState();
    live.value = false;
    notify(t("扩展事件场景加载失败：{error}", { error: errorText(error) }), true);
  }
}

async function startAutomation(plan: AutomationPlan, planId: string) {
  if (!plan.entries.length) return;
  if (inTauri() && !device.connected) {
    notify(t("请先连接基座后再启动编排"), true);
    return;
  }
  try {
    setLiveResumeRequested(false);
    if (device.connected) await api.setBrightness(brightness.value);
    automationPlan.value = structuredClone(plan);
    activeAutomationPlanId.value = planId;
    automationRunning.value = true;
    resetDisplayProtection();
    live.value = device.connected;
    if (!await evaluateAutomationTrigger()) await playAutomationIndex(0);
    if (!automationRunning.value) return;
    notify(t(device.connected ? "编排已启动：{name}" : "预览编排已启动：{name}", { name: plan.name }));
  } catch (error) {
    stopAutomationState();
    notify(errorText(error), true);
  }
}

async function stopAutomation(restoreDisplay = true) {
  const wasRunning = automationRunning.value;
  stopAutomationState();
  live.value = false;
  displaySleeping.value = false;
  if (restoreDisplay && wasRunning && device.connected && inTauri()) {
    try { await api.stopDisplay(); } catch (error) { notify(errorText(error), true); return; }
  }
  if (wasRunning) notify(t("场景编排已停止"));
}

function skipAutomation(direction: -1 | 1) {
  if (!automationRunning.value) return;
  void playAutomationIndex(automationIndex.value + direction);
}

watch(
  () => config.scene,
  () => {
    window.clearTimeout(scenePersistenceTimer);
    scenePersistenceTimer = window.setTimeout(() => {
      persistCurrentScene();
    }, 250);
  },
  { deep: true },
);
watch(
  () => config.sceneLibraryId,
  id => localStorage.setItem("nova-oled-scene-id", id),
);
watch([systemMetricsNeeded, mediaInfoNeeded, live, automationRunning], restartDynamicDataPolling);
watch(() => device.connected, scheduleStatusPolling);
async function probeGameSense(showMessage = true) {
  if (!inTauri()) return;
  gameSenseBusy.value = true;
  try {
    gameSense.value = await api.gameSenseStatus();
    if (showMessage) notify(t(gameSense.value.running ? "GameSense 本地 API 已就绪" : "GameSense 本地 API 不可用"), !gameSense.value.running);
  } catch (error) { notify(errorText(error), true); }
  finally { gameSenseBusy.value = false; }
}
async function testGameSense() {
  gameSenseBusy.value = true;
  try {
    stopAutomationState();
    setLiveResumeRequested(false);
    live.value = false;
    if (device.connected) {
      await api.stopDisplay().catch(() => undefined);
      await api.disconnect();
      clearDevice();
    }
    const result = await api.gameSenseProbe();
    notify(t(result.message));
  } catch (error) { notify(errorText(error), true); }
  finally { gameSenseBusy.value = false; }
}
async function removeGameSenseProbe() {
  gameSenseBusy.value = true;
  try { await api.removeGameSenseProbe(); notify(t("已从 GG 清理临时 GameSense 测试应用")); }
  catch (error) { notify(errorText(error), true); }
  finally { gameSenseBusy.value = false; }
}

onMounted(async () => {
  appMounted = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  scheduleStatusPolling();
  restartDynamicDataPolling();
  probeGameSense(false);
  refreshStartupStatus();
  if (inTauri()) {
    await scanDevices(false);
    if (autoConnect.value) {
      try {
        assignDevice(await api.status());
        await resumeLiveDisplay();
      } catch {
        await connect();
      }
    }
  }
  window.addEventListener("focus", handleWindowFocus);
  window.addEventListener("nova-extension-event", handleExtensionEvent);
  window.addEventListener("beforeunload", persistCurrentScene);
});
onBeforeUnmount(() => {
  appMounted = false;
  dynamicDataPollToken += 1;
  window.clearTimeout(statusTimer); window.clearTimeout(dynamicDataTimer); window.clearTimeout(toastTimer); window.clearTimeout(automationTimer); window.clearTimeout(reconnectTimer); window.clearTimeout(scenePersistenceTimer);
  persistCurrentScene();
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  window.removeEventListener("focus", handleWindowFocus);
  window.removeEventListener("nova-extension-event", handleExtensionEvent);
  window.removeEventListener("beforeunload", persistCurrentScene);
  if (config.mediaUrl) URL.revokeObjectURL(config.mediaUrl);
});
</script>

<template>
  <div class="app-frame">
    <TitleBar />
    <div class="app-layout">
      <Sidebar v-model:current="currentView" :automation-running="automationRunning" />
      <div class="main-shell">
      <DeviceStatus :device="device" :busy="busy" @connect="connect" @disconnect="disconnect" @refresh="refreshStatus" />
      <main v-show="currentView === 'editor' || currentView === 'automation'" class="workspace editor-workspace">
        <section :class="['preview-band', { 'scene-preview': currentView === 'editor' && config.mode === 'scene' }]">
          <div class="preview-copy"><span>OLED OUTPUT</span><h1>{{ t("实时画面") }}</h1><p>{{ t("画面使用与基座一致的 128 x 64 单色像素和列优先数据布局。") }}</p></div>
          <OledPreview ref="preview" :config="config" :metrics="metrics" :device="device" :live="live" :fps="fps" :active="currentView === 'editor' || currentView === 'automation'" :extension-event-ids="activeExtensionEventIds" :compact="currentView === 'editor' && config.mode === 'scene'" @frame="sendLiveFrame" @message="notify" />
        </section>
        <DisplayEditor
          v-if="currentView === 'editor'"
          :config="config" :metrics="metrics" :device="device" :brightness="brightness" :live="live" :connected="device.connected" :busy="busy"
          @update:brightness="updateBrightness" @send="sendCurrent" @start="startLive" @stop="stopLive" @message="notify"
        />
        <AutomationView
          v-else-if="currentView === 'automation'"
          :running="automationRunning"
          :active-plan-id="activeAutomationPlanId"
          :current-index="automationIndex"
          :ends-at="automationEndsAt"
          :active-trigger="activeAutomationTrigger"
          :connected="device.connected"
          @start="startAutomation"
          @stop="stopAutomation"
          @skip="skipAutomation"
          @message="notify"
        />
      </main>
      <main v-show="currentView === 'status' || currentView === 'settings'" class="workspace standalone">
        <StatusView v-if="currentView === 'status'" :device="device" :metrics="metrics" />
        <SettingsView
          v-else-if="currentView === 'settings'"
          :auto-connect="autoConnect"
          :fps="fps"
          :pixel-shift-enabled="pixelShiftEnabled"
          :static-sleep-enabled="staticSleepEnabled"
          :static-sleep-minutes="staticSleepMinutes"
          :display-sleeping="displaySleeping"
          :devices="detectedDevices"
          :device-selection="deviceSelection"
          :devices-busy="devicesBusy"
          :game-sense="gameSense"
          :game-sense-busy="gameSenseBusy"
          :startup="startup"
          :startup-busy="startupBusy"
          :backup-busy="backupBusy"
          @update:auto-connect="updateAutoConnect"
          @update:launch-on-startup="updateLaunchOnStartup"
          @update:fps="updateFps"
          @update:pixel-shift-enabled="updatePixelShift"
          @update:static-sleep-enabled="updateStaticSleep"
          @update:static-sleep-minutes="updateStaticSleepMinutes"
          @update:device-selection="updateDeviceSelection"
          @scan-devices="scanDevices"
          @probe-game-sense="probeGameSense"
          @test-game-sense="testGameSense"
          @remove-game-sense-probe="removeGameSenseProbe"
          @export-backup="exportBackup"
          @restore-backup="restoreBackup"
          @message="notify"
        />
      </main>
      </div>
    </div>
    <transition name="toast"><div v-if="toast" :class="['toast', { error: toastError }]">{{ toast }}</div></transition>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #111415; --surface-sidebar: #151819; --surface: #191d1e; --surface-raised: #1a1e1f; --surface-subtle: #121516;
  --control: #1b1f20; --control-hover: #222726; --accent-soft: #1b2820;
  --line: #2d3231; --line-strong: #3a403e; --text: #e6eae8; --text-strong: #edf0ef; --text-soft: #c3c9c7;
  --muted: #767d7b; --muted-soft: #666e6b; --green: #66e799; --amber: #e9b95f;
  --shadow: rgba(0, 0, 0, .32); --mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--bg); font-synthesis: none;
}
html[data-theme="light"] {
  color-scheme: light;
  --bg: #f4f6f5; --surface-sidebar: #edf1ef; --surface: #ffffff; --surface-raised: #ffffff; --surface-subtle: #f7f9f8;
  --control: #eef2f0; --control-hover: #e4eae7; --accent-soft: #dff3e6;
  --line: #d5dcd8; --line-strong: #b9c5bf; --text: #17211c; --text-strong: #0d1711; --text-soft: #34453b;
  --muted: #65716a; --muted-soft: #7b8680; --green: #16874a; --amber: #986100; --shadow: rgba(25, 42, 33, .15);
}
* { box-sizing: border-box; margin: 0; padding: 0; letter-spacing: 0; }
html, body, #app { width: 100%; height: 100%; min-width: 720px; min-height: 540px; overflow: hidden; }
button, input, select, textarea { font: inherit; }
.app-frame { width: 100%; height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.app-layout { flex: 1; min-height: 0; display: flex; background: var(--bg); }
.main-shell { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.workspace { flex: 1; overflow: auto; }
.editor-workspace { padding: 18px 22px 24px; }
.preview-band { max-width: 1120px; margin: 0 auto 20px; display: grid; grid-template-columns: minmax(180px, .54fr) minmax(380px, 1.46fr); align-items: center; gap: 28px; }
.preview-band.scene-preview { position: sticky; top: 0; z-index: 12; grid-template-columns: 1fr; max-width: 1040px; margin-bottom: 12px; padding: 8px 0 9px; border-bottom: 1px solid var(--line); background: var(--bg); }
.preview-band.scene-preview .preview-copy { display: none; }
.preview-copy > span { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }.preview-copy h1 { margin-top: 7px; color: var(--text-strong); font-size: 24px; font-weight: 620; }.preview-copy p { max-width: 270px; margin-top: 8px; color: var(--muted); font-size: 10px; line-height: 1.6; }
.editor { max-width: 1120px; margin: 0 auto; }.standalone { padding: 26px 30px 36px; }
.toast { position: fixed; right: 20px; bottom: 18px; max-width: 430px; padding: 10px 13px; border: 1px solid #4a765b; border-radius: 4px; background: #1e3025; color: #b9f5cf; box-shadow: 0 12px 30px rgba(0,0,0,.35); font-size: 11px; z-index: 20; }.toast.error { border-color: #75483f; background: #35231f; color: #f0aea0; }
.toast-enter-active,.toast-leave-active { transition: .18s; }.toast-enter-from,.toast-leave-to { opacity: 0; transform: translateY(6px); }
::-webkit-scrollbar { width: 8px; }::-webkit-scrollbar-track { background: transparent; }::-webkit-scrollbar-thumb { background: var(--line-strong); border-radius: 4px; }
@media(max-width:1050px){.preview-band{grid-template-columns:1fr}.preview-copy{display:none}.editor-workspace{padding:16px}.standalone{padding:24px 20px}}
</style>
