<script setup lang="ts">
import { AudioLines, Box, Network, Power, ScrollText, ShieldAlert, Trash2, Upload } from "@lucide/vue";
import { onBeforeUnmount, onMounted, ref } from "vue";
import {
  chooseExtensionPackage,
  deleteExtension,
  installExtensionPackage,
  inspectExtensionPackage,
  loadBundledAudioProviderPackage,
  loadBundledNetworkProviderPackage,
  listExtensions,
  setExtensionEnabled,
  type InstalledExtension,
} from "../services/extensions";
import { api, inTauri, type ProviderStatus } from "../services/tauri";
import { useI18n } from "../services/i18n";

const emit = defineEmits<{ message: [value: string, error?: boolean] }>();
const items = ref<InstalledExtension[]>([]);
const busy = ref(false);
const fileInput = ref<HTMLInputElement>();
const providerStatuses = ref<Record<string, ProviderStatus>>({});
const visibleLogs = ref("");
const visibleLogId = ref("");
const { t } = useI18n();

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function refresh() {
  items.value = await listExtensions();
  if (inTauri()) {
    const statuses = await api.providerStatuses();
    providerStatuses.value = Object.fromEntries(statuses.map(status => [status.id, status]));
  }
}

async function installApprovedFile(file: File) {
  const manifest = await inspectExtensionPackage(file);
  let approved = false;
  if (manifest.runtime === "provider") {
    approved = window.confirm(t("“{name}”是原生 Provider 扩展。\n\n它会作为独立程序运行，拥有与当前用户相同的系统访问能力，可能读取音频、文件、网络或其他程序数据。主程序只能限制通信频率和终止进程，无法像 QuickJS 一样隔离其系统权限。\n\n仅在你信任扩展来源时继续安装。安装后默认保持停用。", { name: manifest.name }));
    if (!approved) return undefined;
  }
  return installExtensionPackage(file, approved);
}

async function installFile(file?: File) {
  if (!file) return;
  busy.value = true;
  try {
    const result = await installApprovedFile(file);
    if (!result) return;
    await refresh();
    emit("message", t(result.updated ? "扩展已更新：{name}" : "扩展已安装：{name}", { name: result.item.manifest.name }));
  } catch (error) {
    emit("message", t("安装扩展失败：{error}", { error: errorText(error) }), true);
  } finally {
    busy.value = false;
  }
}

async function choosePackage() {
  if (!inTauri()) {
    fileInput.value?.click();
    return;
  }
  busy.value = true;
  try {
    const file = await chooseExtensionPackage();
    if (file) {
      const result = await installApprovedFile(file);
      if (!result) return;
      await refresh();
      emit("message", t(result.updated ? "扩展已更新：{name}" : "扩展已安装：{name}", { name: result.item.manifest.name }));
    }
  } catch (error) {
    emit("message", t("安装扩展失败：{error}", { error: errorText(error) }), true);
  } finally {
    busy.value = false;
  }
}

function handleFile(event: Event) {
  const input = event.target as HTMLInputElement;
  void installFile(input.files?.[0]);
  input.value = "";
}

async function installAudioProvider() {
  busy.value = true;
  try {
    const result = await installApprovedFile(await loadBundledAudioProviderPackage());
    if (!result) return;
    await refresh();
    emit("message", t(result.updated ? "系统音频频谱已更新，重新启用后生效" : "系统音频频谱已安装，启用后可添加到自由场景"));
  } catch (error) {
    emit("message", t("安装音频频谱失败：{error}", { error: errorText(error) }), true);
  } finally {
    busy.value = false;
  }
}

async function installNetworkProvider() {
  busy.value = true;
  try {
    const result = await installApprovedFile(await loadBundledNetworkProviderPackage());
    if (!result) return;
    await refresh();
    emit("message", t(result.updated ? "系统网络吞吐已更新，重新启用后生效" : "系统网络吞吐已安装，启用后可绑定文字或进度条"));
  } catch (error) {
    emit("message", t("安装网络吞吐失败：{error}", { error: errorText(error) }), true);
  } finally {
    busy.value = false;
  }
}

async function toggle(item: InstalledExtension) {
  try {
    if (!item.enabled && item.manifest.runtime === "provider") {
      const approved = window.confirm(t("启用原生扩展“{name}”？\n\n启用后，它会在场景需要数据时作为独立程序启动，并拥有完全系统访问能力。", { name: item.manifest.name }));
      if (!approved) return;
    }
    await setExtensionEnabled(item.id, !item.enabled);
    await refresh();
  } catch (error) {
    emit("message", t("切换扩展失败：{error}", { error: errorText(error) }), true);
  }
}

async function toggleLogs(item: InstalledExtension) {
  if (visibleLogId.value === item.id) {
    visibleLogId.value = "";
    visibleLogs.value = "";
    return;
  }
  const logs = await api.providerLogs(item.id);
  visibleLogId.value = item.id;
  visibleLogs.value = logs.length ? logs.join("\n") : t("暂无运行日志");
}

async function remove(item: InstalledExtension) {
  if (!window.confirm(t("确定删除扩展“{name}”吗？使用它的场景图层会保留，但在重新安装前不会显示。", { name: item.manifest.name }))) return;
  try {
    await deleteExtension(item.id);
    await refresh();
    emit("message", t("扩展已删除：{name}", { name: item.manifest.name }));
  } catch (error) {
    emit("message", t("删除扩展失败：{error}", { error: errorText(error) }), true);
  }
}

function handleChanged() {
  void refresh();
}

function variableToken(extension: InstalledExtension, key: string) {
  return `{${extension.id}.${key}}`;
}

onMounted(() => {
  window.addEventListener("nova-extensions-changed", handleChanged);
  void refresh().catch(error => emit("message", t("读取扩展失败：{error}", { error: errorText(error) }), true));
});
onBeforeUnmount(() => window.removeEventListener("nova-extensions-changed", handleChanged));
</script>

<template>
  <section class="extension-manager">
    <div class="extension-toolbar">
      <div><strong>{{ t("扩展运行时") }}</strong><p>{{ t("普通扩展在 QuickJS 沙箱运行；原生 Provider 可自行实现音频、GPU、网络或游戏数据源。") }}</p></div>
      <div class="extension-actions">
        <button :disabled="busy" :title="t('安装真实的 Windows 系统音频频谱')" @click="installAudioProvider"><AudioLines :size="14" />{{ t("安装音频频谱") }}</button>
        <button :disabled="busy" :title="t('安装系统网络吞吐数据源')" @click="installNetworkProvider"><Network :size="14" />{{ t("安装网络监控") }}</button>
        <button class="primary" :disabled="busy" :title="t('导入 .nova-extension 扩展包')" @click="choosePackage"><Upload :size="14" />{{ t("导入扩展") }}</button>
        <input ref="fileInput" type="file" accept=".nova-extension,application/zip" @change="handleFile" />
      </div>
    </div>
    <div v-if="items.length" class="extension-list">
      <article v-for="item in items" :key="item.id" :class="{ disabled: !item.enabled, provider: item.manifest.runtime === 'provider' }">
        <ShieldAlert v-if="item.manifest.runtime === 'provider'" :size="17" />
        <Box v-else :size="17" />
        <div class="extension-detail">
          <div><strong>{{ t(item.manifest.name) }}</strong><span>v{{ item.manifest.version }} · {{ item.manifest.author }}</span></div>
          <p>{{ t(item.manifest.description || item.id) }}</p>
          <div class="extension-meta">
            <span>{{ t(item.manifest.runtime === "provider" ? "原生 Provider · 完全系统访问" : "QuickJS 沙箱") }}</span>
            <span v-if="item.manifest.runtime === 'provider' && providerStatuses[item.id]?.running" class="running">{{ t("运行中 · PID {pid}", { pid: providerStatuses[item.id].pid ?? '' }) }}</span>
            <span v-else-if="item.manifest.runtime === 'provider' && providerStatuses[item.id]?.lastError" class="failed">{{ t("已停止 · {error}", { error: providerStatuses[item.id].lastError ?? '' }) }}</span>
            <span v-if="item.manifest.renderer">{{ t("绘图：{label}", { label: t(item.manifest.renderer.label) }) }}</span>
            <span v-for="event in item.manifest.events" :key="`event-${event.key}`">{{ t("事件：{label}", { label: t(event.label) }) }}</span>
            <code v-for="variable in item.manifest.variables" :key="variable.key">{{ variableToken(item, variable.key) }}</code>
          </div>
        </div>
        <button v-if="item.manifest.runtime === 'provider'" class="icon-button" :title="t('查看 Provider 日志')" @click="toggleLogs(item)"><ScrollText :size="14" /></button>
        <button :class="['icon-button', { active: item.enabled }]" :title="t(item.enabled ? '停用扩展' : '启用扩展')" @click="toggle(item)"><Power :size="14" /></button>
        <button class="icon-button delete" :title="t('删除扩展')" @click="remove(item)"><Trash2 :size="14" /></button>
        <pre v-if="visibleLogId === item.id" class="provider-logs">{{ visibleLogs }}</pre>
      </article>
    </div>
    <div v-else class="extension-empty">{{ t("尚未安装扩展。可以安装系统音频频谱、网络监控，或导入可信来源的 .nova-extension 扩展包。") }}</div>
    <p class="extension-warning">{{ t("原生 Provider 不受 QuickJS 沙箱限制，等同于运行第三方应用程序；仅安装来源可信的扩展。完整备份不会携带或自动恢复原生可执行文件。") }}</p>
  </section>
</template>

<style scoped>
.extension-manager { border-bottom: 1px solid var(--line); }.extension-toolbar { min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }.extension-toolbar strong { color: var(--text-soft); font-size: 12px; }.extension-toolbar p { margin-top: 5px; color: var(--muted); font-size: 10px; }.extension-actions { display: flex; gap: 7px; flex-shrink: 0; }.extension-actions button, .icon-button { height: 30px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); cursor: pointer; font-size: 10px; }.extension-actions button:hover:not(:disabled), .icon-button:hover { border-color: #59615e; color: var(--text-strong); }.extension-actions button.primary { border-color: #4b725b; color: var(--green); }.extension-actions button:disabled { opacity: .42; cursor: wait; }.extension-actions input { display: none; }
.extension-list { display: grid; gap: 6px; padding-bottom: 8px; }.extension-list article { min-height: 72px; padding: 10px; display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px; border: 1px solid var(--line); border-radius: 3px; background: var(--surface-sidebar); }.extension-list article.provider { border-color: #554d33; }.extension-list article.disabled { opacity: .58; }.extension-list article > svg { margin-top: 2px; color: var(--green); flex: 0 0 auto; }.extension-list article.provider > svg { color: #d6b968; }.extension-detail { min-width: 0; flex: 1; }.extension-detail > div:first-child { display: flex; align-items: baseline; gap: 7px; }.extension-detail strong { color: var(--text-soft); font-size: 11px; }.extension-detail span, .extension-detail p { color: #717976; font-size: 9px; }.extension-detail p { margin-top: 4px; line-height: 1.45; }.extension-meta { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 5px; }.extension-meta span, .extension-meta code { padding: 3px 5px; border: 1px solid var(--line); border-radius: 2px; background: var(--bg); color: #8c9692; font: 8px/1 var(--mono); }.extension-meta .running { border-color: #45634f; color: var(--green); }.extension-meta .failed { border-color: #70483f; color: #ee9e90; }.icon-button { width: 30px; padding: 0; flex: 0 0 auto; }.icon-button.active { border-color: #45634f; color: var(--green); }.icon-button.delete:hover { border-color: #70483f; color: #ee9e90; }.provider-logs { width: 100%; max-height: 150px; overflow: auto; margin: 0; padding: 8px; border: 1px solid var(--line); background: var(--surface-subtle); color: #909996; font: 9px/1.5 var(--mono); white-space: pre-wrap; }.extension-empty { padding: 17px 10px; border: 1px dashed var(--line-strong); color: #6e7673; font-size: 9px; text-align: center; }.extension-warning { padding: 8px 0 12px; color: #8e8060; font-size: 9px; line-height: 1.5; }
@media(max-width:900px){.extension-toolbar{align-items:flex-start;flex-direction:column;padding:14px 0}.extension-actions{width:100%}.extension-actions button{flex:1}.extension-list article{flex-wrap:wrap}}
</style>
