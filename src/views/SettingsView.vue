<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, FlaskConical, FolderOpen, Moon, RefreshCw, Sun, Trash2, Upload } from "@lucide/vue";
import ExtensionManager from "../components/ExtensionManager.vue";
import { appTheme, setTheme, type AppTheme } from "../services/appearance";
import { developerMode, setDeveloperMode } from "../services/developerMode";
import { appLocale, setLocale, useI18n, type AppLocale } from "../services/i18n";
import { closeBehavior, setCloseBehavior, type CloseBehavior } from "../services/windowBehavior";
import { api, inTauri } from "../services/tauri";
import type { DetectedDevice, DiagnosticSettings, GameSenseStatus, StartupStatus } from "../types";

const props = defineProps<{
  autoConnect: boolean;
  fps: number;
  pixelShiftEnabled: boolean;
  staticSleepEnabled: boolean;
  staticSleepMinutes: number;
  displaySleeping: boolean;
  devices: DetectedDevice[];
  deviceSelection: string;
  devicesBusy: boolean;
  gameSense?: GameSenseStatus;
  gameSenseBusy: boolean;
  startup: StartupStatus;
  startupBusy: boolean;
  backupBusy: boolean;
}>();
const emit = defineEmits<{
  "update:autoConnect": [value: boolean];
  "update:launchOnStartup": [value: boolean];
  "update:fps": [value: number];
  "update:pixelShiftEnabled": [value: boolean];
  "update:staticSleepEnabled": [value: boolean];
  "update:staticSleepMinutes": [value: number];
  "update:deviceSelection": [value: string];
  scanDevices: [];
  probeGameSense: [];
  testGameSense: [];
  removeGameSenseProbe: [];
  exportBackup: [];
  restoreBackup: [];
  message: [value: string, error?: boolean];
}>();

const selectedDevice = computed(() => props.devices.find((device) => device.id === props.deviceSelection));
const missingSelection = computed(() => props.deviceSelection !== "auto" && !selectedDevice.value);
const { t } = useI18n();
const appVersion = ref("");
const logsBusy = ref(false);
const diagnostic = ref<DiagnosticSettings>({ enabled: true, directory: "", defaultDirectory: "", isDefault: true });
let developerRequestPending = false;
let diagnosticRequestPending = false;

function supportLabel(device: DetectedDevice) {
  if (device.supported) return t("已支持");
  if (device.support === "planned") return t("已识别 / 待支持");
  if (device.support === "experimental") return t("已识别 / 实验协议");
  if (device.support === "gamesense") return t("已识别 / 需 GameSense");
  return t("已识别 / 暂不支持");
}

function updateLocale(event: Event) {
  setLocale((event.target as HTMLSelectElement).value as AppLocale);
}

function updateTheme(value: AppTheme) {
  setTheme(value);
}

function updateCloseBehavior(event: Event) {
  setCloseBehavior((event.target as HTMLSelectElement).value as CloseBehavior);
}

async function openLogs() {
  if (!inTauri() || logsBusy.value) return;
  logsBusy.value = true;
  try {
    await api.openLogDirectory();
  } catch (error) {
    emit("message", t("打开日志目录失败：{error}", { error: String(error) }), true);
  } finally {
    logsBusy.value = false;
  }
}

async function updateDeveloperMode(enabled: boolean) {
  if (developerRequestPending) return;
  developerRequestPending = true;
  try {
    await setDeveloperMode(enabled);
    emit("message", t(enabled ? "WebView 开发者模式已开启" : "WebView 开发者模式已关闭"));
  } catch (error) {
    emit("message", t("切换开发者模式失败：{error}", { error: String(error) }), true);
  } finally {
    developerRequestPending = false;
  }
}

async function updateDiagnosticEnabled(enabled: boolean) {
  if (!inTauri() || diagnosticRequestPending) return;
  const previous = diagnostic.value;
  diagnostic.value = { ...previous, enabled };
  diagnosticRequestPending = true;
  try {
    diagnostic.value = await api.setDiagnosticEnabled(enabled);
    emit("message", t(diagnostic.value.enabled ? "诊断日志已开启" : "诊断日志已关闭"));
  } catch (error) {
    diagnostic.value = previous;
    emit("message", t("修改诊断日志设置失败：{error}", { error: String(error) }), true);
  } finally {
    diagnosticRequestPending = false;
  }
}

async function chooseLogDirectory() {
  if (!inTauri() || logsBusy.value) return;
  const selected = await open({
    directory: true,
    multiple: false,
    defaultPath: diagnostic.value.directory || diagnostic.value.defaultDirectory,
    title: t("选择诊断日志目录"),
  }).catch(error => {
    emit("message", t("选择日志目录失败：{error}", { error: String(error) }), true);
    return null;
  });
  if (typeof selected !== "string") return;
  logsBusy.value = true;
  try {
    diagnostic.value = await api.setDiagnosticDirectory(selected);
  } catch (error) {
    emit("message", t("修改日志目录失败：{error}", { error: String(error) }), true);
  } finally {
    logsBusy.value = false;
  }
}

async function restoreDefaultLogDirectory() {
  if (!inTauri() || logsBusy.value || diagnostic.value.isDefault) return;
  logsBusy.value = true;
  try {
    diagnostic.value = await api.setDiagnosticDirectory(null);
  } catch (error) {
    emit("message", t("恢复默认日志目录失败：{error}", { error: String(error) }), true);
  } finally {
    logsBusy.value = false;
  }
}

onMounted(async () => {
  if (!inTauri()) {
    appVersion.value = "DEV";
    return;
  }
  const [version, settings] = await Promise.all([
    getVersion().catch(() => ""),
    api.diagnosticSettings().catch(error => {
      emit("message", t("读取诊断日志设置失败：{error}", { error: String(error) }), true);
      return diagnostic.value;
    }),
  ]);
  appVersion.value = version;
  diagnostic.value = settings;
});
</script>

<template>
  <section class="settings-view">
    <div class="page-title"><span>SETTINGS</span><h2>{{ t("应用设置") }}</h2></div>
    <div class="integration-heading appearance-heading"><span>APPEARANCE</span><h3>{{ t("外观与语言") }}</h3></div>
    <div class="preference-grid">
      <div class="preference-item">
        <div><strong>{{ t("界面语言") }}</strong><p>{{ t("切换后立即应用，并在下次启动时保留。") }}</p></div>
        <select :value="appLocale" @change="updateLocale"><option value="zh-CN">{{ t("简体中文") }}</option><option value="en-US">English</option></select>
      </div>
      <div class="preference-item theme-preference">
        <div><strong>{{ t("界面主题") }}</strong><p>{{ t("也可以使用标题栏右侧的太阳或月亮按钮快速切换。") }}</p></div>
        <div class="theme-segments">
          <button :class="{ active: appTheme === 'dark' }" @click="updateTheme('dark')"><Moon :size="14" />{{ t("夜间模式") }}</button>
          <button :class="{ active: appTheme === 'light' }" @click="updateTheme('light')"><Sun :size="14" />{{ t("日间模式") }}</button>
        </div>
      </div>
    </div>
    <div class="integration-heading behavior-heading"><span>APPLICATION</span><h3>{{ t("应用行为") }}</h3></div>
    <div class="setting-row static behavior-row">
      <div><strong>{{ t("关闭按钮行为") }}</strong><p>{{ t("控制标题栏关闭按钮；最小化按钮始终隐藏到系统托盘。") }}</p></div>
      <select class="behavior-select" :value="closeBehavior" @change="updateCloseBehavior">
        <option value="ask">{{ t("下次关闭时询问") }}</option>
        <option value="tray">{{ t("最小化到系统托盘") }}</option>
        <option value="exit">{{ t("退出程序") }}</option>
      </select>
    </div>
    <div class="integration-heading device-heading"><span>DEVICE</span><h3>{{ t("耳机基座") }}</h3></div>
    <div class="setting-row static device-picker-row">
      <div>
        <strong>{{ t("目标设备") }}</strong>
        <p v-if="devicesBusy">{{ t("正在扫描 SteelSeries USB 设备...") }}</p>
        <p v-else-if="selectedDevice">{{ selectedDevice.product }} · {{ selectedDevice.productIdHex }} · {{ supportLabel(selectedDevice) }}</p>
        <p v-else-if="devices.length === 0">{{ t("当前未检测到耳机基座。") }}</p>
        <p v-else>{{ t("自动选择第一个已支持的耳机基座。") }}</p>
      </div>
      <div class="device-picker-controls">
        <select class="device-select" :value="deviceSelection" @change="$emit('update:deviceSelection', ($event.target as HTMLSelectElement).value)">
          <option value="auto">{{ t("自动选择（推荐）") }}</option>
          <option v-if="missingSelection" :value="deviceSelection">{{ t("已保存的设备（当前未连接）") }}</option>
          <option v-for="item in devices" :key="item.id" :value="item.id" :disabled="!item.supported">
            {{ item.product }} · {{ item.productIdHex }}{{ item.supported ? "" : ` · ${supportLabel(item)}` }}
          </option>
        </select>
        <button class="scan-button" :disabled="devicesBusy" :title="t('重新扫描 USB 设备')" @click="$emit('scanDevices')">
          <RefreshCw :size="14" :class="{ spin: devicesBusy }" />
        </button>
      </div>
    </div>
    <div class="setting-row">
      <div><strong>{{ t("启动时自动连接") }}</strong><p>{{ t("应用打开后自动查找受支持的 SteelSeries 基座。") }}</p></div>
      <label class="switch"><input :checked="autoConnect" type="checkbox" @change="$emit('update:autoConnect', ($event.target as HTMLInputElement).checked)" /><i></i></label>
    </div>
    <div class="setting-row">
      <div>
        <strong>{{ t("开机自启动") }}</strong>
        <p v-if="startup.supported">{{ t("电脑开机登录后自动启动本软件；是否自动连接基座仍由上方选项控制。") }}</p>
        <p v-else>{{ t("当前平台暂不支持自动配置开机自启动。") }}</p>
      </div>
      <label class="switch"><input :checked="startup.enabled" :disabled="startupBusy || !startup.supported" type="checkbox" @change="$emit('update:launchOnStartup', ($event.target as HTMLInputElement).checked)" /><i></i></label>
    </div>
    <div class="setting-row static">
      <div><strong>{{ t("OLED 帧率") }}</strong><p>{{ t("限制动画与视频的最高输出速率；GIF 仍遵循文件自身的帧延时。") }}</p></div>
      <select class="fps-select" :value="fps" @change="$emit('update:fps', Number(($event.target as HTMLSelectElement).value))">
        <option :value="5">5 FPS · {{ t("省资源") }}</option>
        <option :value="10">10 FPS · {{ t("标准") }}</option>
        <option :value="15">15 FPS · {{ t("流畅") }}</option>
        <option :value="20">20 FPS · {{ t("高") }}</option>
        <option :value="30">30 FPS · {{ t("最高") }}</option>
      </select>
    </div>
    <div class="setting-row static"><div><strong>{{ t("支持的平台") }}</strong><p>{{ t("Windows 10/11；Linux 需要对应 hidraw/udev 权限。") }}</p></div><b>WIN / LINUX</b></div>
    <div class="integration-heading"><span>DISPLAY PROTECTION</span><h3>{{ t("OLED 屏幕保护") }}</h3></div>
    <div class="setting-row">
      <div><strong>{{ t("防烧屏微移") }}</strong><p>{{ t("实时显示时每分钟将画面移动 1 个像素，完整循环后回到原位。") }}</p></div>
      <button class="switch-action" :class="{ active: pixelShiftEnabled }" type="button" role="switch" :aria-checked="pixelShiftEnabled" @click="$emit('update:pixelShiftEnabled', !pixelShiftEnabled)"><i></i></button>
    </div>
    <div class="setting-row static protection-sleep-row">
      <div>
        <strong>{{ t("静态画面自动休眠") }}</strong>
        <p>{{ t("同一画面持续不变时发送全黑画面；内容变化后立即恢复。") }}</p>
      </div>
      <div class="protection-controls">
        <span v-if="displaySleeping" class="sleeping-state">{{ t("当前休眠") }}</span>
        <select :value="staticSleepMinutes" :class="{ inactive: !staticSleepEnabled }" :aria-disabled="!staticSleepEnabled" @change="staticSleepEnabled && $emit('update:staticSleepMinutes', Number(($event.target as HTMLSelectElement).value))">
          <option :value="5">5 {{ t("分钟") }}</option>
          <option :value="10">10 {{ t("分钟") }}</option>
          <option :value="30">30 {{ t("分钟") }}</option>
          <option :value="60">60 {{ t("分钟") }}</option>
        </select>
        <button class="switch-action" :class="{ active: staticSleepEnabled }" type="button" role="switch" :aria-checked="staticSleepEnabled" @click="$emit('update:staticSleepEnabled', !staticSleepEnabled)"><i></i></button>
      </div>
    </div>
    <p class="protection-note">{{ t("默认关闭。SteelSeries GG 已提供类似保护；如果继续使用 GG 的屏幕保护功能，无需同时开启这里的选项。") }}</p>
    <div class="integration-heading"><span>DATA</span><h3>{{ t("备份与恢复") }}</h3></div>
    <div class="setting-row static backup-row">
      <div>
        <strong>{{ t("完整主题库备份") }}</strong>
        <p>{{ t("包含图片、GIF、视频、文字、自由场景、场景编排及常用应用偏好。") }}</p>
      </div>
      <div class="backup-actions">
        <button :disabled="backupBusy" :title="t('导出完整备份')" @click="$emit('exportBackup')"><Download :size="14" />{{ t("导出备份") }}</button>
        <button :disabled="backupBusy" :title="t('从备份合并恢复')" @click="$emit('restoreBackup')"><Upload :size="14" />{{ t("恢复备份") }}</button>
      </div>
    </div>
    <p class="backup-note">{{ t("恢复采用合并方式，不会删除或覆盖当前主题；Windows 开机自启动和目标设备选择不会被修改。") }}</p>
    <div class="integration-heading"><span>EXTENSIONS</span><h3>{{ t("功能扩展") }}</h3></div>
    <ExtensionManager @message="(value, error) => $emit('message', value, error)" />
    <div class="integration-heading"><span>GAMESENSE</span><h3>{{ t("官方 API 兼容性") }}</h3></div>
    <div class="setting-row static">
      <div>
        <strong>{{ t("SteelSeries GG 服务") }}</strong>
        <p v-if="gameSense?.running">{{ t("本地 GameSense API 已就绪：{address}", { address: gameSense.address }) }}</p>
        <p v-else-if="gameSense?.installed">{{ t("已找到 GG 配置，但本地 API 当前不可连接。") }}</p>
        <p v-else>{{ t("未找到 SteelSeries GG GameSense 配置。") }}</p>
      </div>
      <b :class="{ online: gameSense?.running }">{{ gameSense?.running ? "READY" : "OFFLINE" }}</b>
    </div>
    <div class="gamesense-actions">
      <button :disabled="gameSenseBusy" :title="t('重新读取 GG 本地服务状态')" @click="$emit('probeGameSense')">
        <RefreshCw :size="14" :class="{ spin: gameSenseBusy }" />{{ t("重新检测") }}
      </button>
      <button class="primary" :disabled="gameSenseBusy || !gameSense?.running" :title="t('断开 HID 并通过官方 API 发送测试图')" @click="$emit('testGameSense')">
        <FlaskConical :size="14" />{{ t("发送 128 x 64 测试帧") }}
      </button>
      <button :disabled="gameSenseBusy || !gameSense?.running" :title="t('从 GG 中移除临时测试应用')" @click="$emit('removeGameSenseProbe')">
        <Trash2 :size="14" />{{ t("清理测试") }}
      </button>
    </div>
    <p class="gamesense-note">{{ t("测试会停止当前实时输出并断开 HID。GG 接受请求不代表设备一定支持 128 x 64，请观察基座是否出现带 X 的边框图。") }}</p>
    <div class="integration-heading"><span>DEVELOPER</span><h3>{{ t("开发者选项") }}</h3></div>
    <div class="setting-row">
      <div>
        <strong>{{ t("WebView 开发者模式") }}</strong>
        <p>{{ t("开启后恢复右键菜单、页面刷新和开发者工具快捷键，供界面与扩展调试使用。") }}</p>
      </div>
      <button class="switch-action" :class="{ active: developerMode }" type="button" role="switch" :aria-checked="developerMode" @click="updateDeveloperMode(!developerMode)"><i></i></button>
    </div>
    <div class="setting-row diagnostic-row">
      <div>
        <strong>{{ t("诊断日志") }}</strong>
        <p>{{ t("开启后记录应用启动、退出、设备连接和程序异常；日志达到 512 KB 后自动轮换。") }}</p>
      </div>
      <button class="switch-action" :class="{ active: diagnostic.enabled }" :disabled="!inTauri()" type="button" role="switch" :aria-checked="diagnostic.enabled" @click="updateDiagnosticEnabled(!diagnostic.enabled)"><i></i></button>
    </div>
    <div class="setting-row static diagnostic-path-row">
      <div class="diagnostic-path-copy">
        <strong>{{ t("日志保存位置") }}</strong>
        <code :title="diagnostic.directory">{{ diagnostic.directory || t("正在读取...") }}</code>
        <p>{{ diagnostic.isDefault ? t("默认保存在软件安装目录的 logs 文件夹中。") : t("正在使用自定义日志目录。") }}</p>
      </div>
      <div class="diagnostic-actions">
        <button :disabled="logsBusy || !inTauri()" @click="chooseLogDirectory"><FolderOpen :size="14" />{{ t("更改位置") }}</button>
        <button :disabled="logsBusy || !inTauri() || diagnostic.isDefault" @click="restoreDefaultLogDirectory"><RefreshCw :size="14" />{{ t("恢复默认") }}</button>
        <button :disabled="logsBusy || !inTauri()" @click="openLogs"><FolderOpen :size="14" />{{ t("打开目录") }}</button>
      </div>
    </div>
    <p class="developer-note">{{ t("默认关闭。日常使用时建议保持关闭，使界面行为更接近普通桌面软件。") }}</p>
    <div class="about"><span>ABOUT</span><strong>Nova Display Controller{{ appVersion ? ` ${appVersion}` : "" }}</strong><p>{{ t("独立开源控制器，不隶属于 SteelSeries。请避免长时间显示静止高亮画面，以减轻 OLED 烧屏。") }}</p></div>
  </section>
</template>

<style scoped>
.settings-view { width: min(920px, 100%); margin: 0 auto; }.page-title span,.about > span,.integration-heading span { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }.page-title h2 { margin-top: 5px; color: var(--text-strong); font-size: 19px; }
.setting-row { min-height: 66px; display: flex; align-items: center; justify-content: space-between; gap: 24px; border-bottom: 1px solid var(--line); }.setting-row:first-of-type { border-top: 1px solid var(--line); }.setting-row strong, .preference-item strong { color: var(--text-soft); font-size: 12px; }.setting-row p, .preference-item p { max-width: 620px; margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.45; }.setting-row > b { color: var(--muted); font: 10px/1 var(--mono); }
.appearance-heading { margin-top: 24px; }.preference-grid { margin-top: 11px; display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line); }.preference-item { min-width: 0; min-height: 98px; padding: 15px; display: flex; flex-direction: column; justify-content: space-between; gap: 13px; background: var(--surface-raised); }.preference-item + .preference-item { border-left: 1px solid var(--line); }.preference-item select { width: 100%; height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: none; }.theme-segments { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--line-strong); border-radius: 3px; overflow: hidden; }.theme-segments button { height: 32px; border: 0; background: var(--surface-subtle); color: var(--muted); display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; }.theme-segments button + button { border-left: 1px solid var(--line-strong); }.theme-segments button.active { background: var(--accent-soft); color: var(--green); }
.behavior-heading { margin-top: 27px; }.behavior-row { border-top: 1px solid var(--line); }.behavior-select { width: 190px; height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: none; font-size: 10px; }.behavior-select:focus { border-color: var(--green); }
.setting-row > b.online { color: var(--green); }
.fps-select { width: 156px; height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: none; font: 10px/1 var(--mono); }.fps-select:focus { border-color: var(--green); }
.device-heading { margin-top: 27px; }.device-picker-row { border-top: 1px solid var(--line); }.device-picker-controls { display: flex; gap: 6px; align-items: center; }.device-select { width: min(350px, 44vw); height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: none; font: 10px/1 var(--mono); }.device-select:focus { border-color: var(--green); }.device-select option:disabled { color: var(--muted); }.scan-button { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--muted); cursor: pointer; }.scan-button:hover:not(:disabled) { border-color: var(--green); color: var(--green); }.scan-button:disabled { opacity: .45; cursor: wait; }
.switch input { position: absolute; opacity: 0; }.switch i { display: block; width: 30px; height: 16px; border-radius: 8px; background: var(--line-strong); position: relative; cursor: pointer; }.switch i::after { content:""; position:absolute; width:12px; height:12px; top:2px; left:2px; border-radius:50%; background:var(--muted); }.switch input:checked + i { background:#315c42; }.switch input:checked + i::after { left:16px; background:var(--green); }.switch input:disabled + i { opacity: .45; cursor: wait; }
.switch-action { width: 30px; height: 16px; padding: 0; flex: 0 0 auto; border: 0; border-radius: 8px; background: var(--line-strong); position: relative; cursor: pointer; }.switch-action i::after { content:""; position:absolute; width:12px; height:12px; top:2px; left:2px; border-radius:50%; background:var(--muted); }.switch-action.active { background:#315c42; }.switch-action.active i::after { left:16px; background:var(--green); }.switch-action:focus-visible { outline: 1px solid var(--green); outline-offset: 3px; }.switch-action:disabled { opacity: .45; cursor: default; }
.protection-controls { display: flex; align-items: center; gap: 9px; flex-shrink: 0; }.protection-controls select { width: 100px; height: 32px; padding: 0 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: none; font: 10px/1 var(--mono); }.protection-controls select.inactive { opacity: .42; pointer-events: none; }.sleeping-state { color: var(--green); font: 9px/1 var(--mono); }.protection-note { margin-top: 8px; color: var(--amber); font-size: 9px; line-height: 1.6; }
.integration-heading { margin-top: 30px; }.integration-heading h3 { margin-top: 5px; color: var(--text-strong); font-size: 15px; font-weight: 620; }
.gamesense-actions { min-height: 58px; display: flex; align-items: center; gap: 7px; }
.gamesense-actions button { height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); cursor: pointer; font-size: 10px; }
.gamesense-actions button:hover:not(:disabled) { border-color: #59615e; color: var(--text-strong); }.gamesense-actions button.primary { border-color: #4b725b; background: var(--accent-soft); color: var(--green); }.gamesense-actions button:disabled { opacity: .42; cursor: default; }
.gamesense-note { color: var(--muted); font-size: 9px; line-height: 1.6; }.spin { animation: spin .8s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
.developer-note { margin-top: 8px; color: var(--amber); font-size: 9px; line-height: 1.6; }
.diagnostic-path-row { padding: 12px 0; }.diagnostic-path-copy { min-width: 0; flex: 1; }.diagnostic-path-copy code { display: block; max-width: 580px; margin-top: 7px; overflow: hidden; color: var(--text-soft); font: 9px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }.diagnostic-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; flex-shrink: 0; }.diagnostic-actions button { height: 30px; padding: 0 9px; display: inline-flex; align-items: center; justify-content: center; gap: 5px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); cursor: pointer; font-size: 10px; }.diagnostic-actions button:hover:not(:disabled) { border-color: var(--green); color: var(--green); }.diagnostic-actions button:disabled { opacity: .42; cursor: default; }
.backup-row { align-items: center; }.backup-actions { display: flex; gap: 7px; flex-shrink: 0; }.backup-actions button { height: 30px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); cursor: pointer; font-size: 10px; }.backup-actions button:hover:not(:disabled) { border-color: #59615e; color: var(--text-strong); }.backup-actions button:disabled { opacity: .42; cursor: wait; }.backup-note { margin-top: 8px; color: var(--muted); font-size: 9px; line-height: 1.6; }
.about { margin-top: 38px; padding: 17px 0; border-top: 1px solid var(--line); }.about strong { display:block; margin-top:8px; color:var(--text-soft); font-size:11px; }.about p { max-width:560px; margin-top:7px; color:var(--muted); font-size:10px; line-height:1.6; }
@media(max-width:900px){.preference-grid{grid-template-columns:1fr}.preference-item + .preference-item{border-left:0;border-top:1px solid var(--line)}.backup-row,.diagnostic-path-row{align-items:flex-start;flex-direction:column;padding:14px 0}.backup-actions,.diagnostic-actions{width:100%;justify-content:flex-start}.backup-actions button{flex:1;justify-content:center}.device-picker-row{align-items:flex-start;flex-direction:column;padding:12px 0}.device-picker-controls,.device-select{width:100%}}
</style>
