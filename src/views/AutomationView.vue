<script setup lang="ts">
import {
  ArrowDown, ArrowUp, BatteryWarning, Clock3, Copy, Gauge, GripVertical, Image,
  Layers3, ListVideo, Music2, Pause, Play, Plus, Save, SkipBack, SkipForward,
  Trash2, Type, Video, Zap,
} from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import {
  deleteLibraryItem,
  listLibraryItems,
  saveAutomationLibraryItem,
  type LibraryItem,
} from "../services/library";
import { listExtensions, type InstalledExtension } from "../services/extensions";
import { useI18n } from "../services/i18n";
import type { AutomationEntry, AutomationPlan, AutomationTrigger, AutomationTriggerType, DisplayMode } from "../types";

const props = defineProps<{
  running: boolean;
  activePlanId: string;
  currentIndex: number;
  endsAt: number;
  activeTrigger: AutomationTriggerType | "";
  connected: boolean;
}>();

const emit = defineEmits<{
  start: [plan: AutomationPlan, planId: string];
  stop: [];
  skip: [direction: -1 | 1];
  message: [value: string];
}>();
const { locale, t } = useI18n();

interface SourceOption {
  value: string;
  name: string;
  detail: string;
  mode: DisplayMode;
  libraryId?: string;
}

const items = ref<LibraryItem[]>([]);
const planId = ref("");
const planName = ref(t("未命名编排"));
const entries = ref<AutomationEntry[]>([]);
const musicTriggerSource = ref("");
const batteryTriggerSource = ref("");
const batteryThreshold = ref(20);
const extensionEventSource = ref("");
const extensionEventTarget = ref("");
const extensionItems = ref<InstalledExtension[]>([]);
const remaining = ref(0);
const dirty = ref(false);
const saving = ref(false);
let clockTimer = 0;
let autoSaveTimer = 0;
let hydrating = false;
let draggedEntryId = "";
let changeRevision = 0;

const plans = computed(() => items.value.filter(item => item.kind === "playlist" && item.playlist));
const sources = computed<SourceOption[]>(() => [
  { value: "builtin:clock", name: t("时钟"), detail: t("内置模式"), mode: "clock" },
  { value: "builtin:system", name: t("系统监控"), detail: t("内置模式"), mode: "system" },
  { value: "builtin:music", name: t("音乐信息"), detail: t("内置模式"), mode: "music" },
  ...items.value.flatMap<SourceOption>(item => {
    if (item.kind === "scene") return [{ value: `library:${item.id}`, name: item.name, detail: t("自由场景"), mode: "scene", libraryId: item.id }];
    if (item.kind === "image") return [{ value: `library:${item.id}`, name: item.name, detail: t("图片主题"), mode: "image", libraryId: item.id }];
    if (item.kind === "gif" || item.kind === "video") return [{ value: `library:${item.id}`, name: item.name, detail: t(item.kind === "gif" ? "GIF 主题" : "视频主题"), mode: "media", libraryId: item.id }];
    if (item.kind === "text") return [{ value: `library:${item.id}`, name: item.name, detail: t("文字主题"), mode: "text", libraryId: item.id }];
    return [];
  }),
]);
const sourceGroups = computed(() => [
  { label: t("常用显示"), items: sources.value.filter(source => !source.libraryId) },
  { label: t("我的场景"), items: sources.value.filter(source => source.mode === "scene") },
  { label: t("图片与动画"), items: sources.value.filter(source => source.mode === "image" || source.mode === "media") },
  { label: t("文字主题"), items: sources.value.filter(source => source.mode === "text") },
].filter(group => group.items.length));
const activeEntry = computed(() => props.running && props.activePlanId === planId.value ? entries.value[props.currentIndex] : undefined);
const activeLabel = computed(() => {
  if (props.activeTrigger === "batteryLow") return t("低电量场景");
  if (props.activeTrigger === "playing") return t("音乐场景");
  if (props.activeTrigger === "extensionEvent") return t("扩展事件场景");
  return activeEntry.value?.name ?? t("切换中");
});
const saveState = computed(() => t(saving.value ? "保存中" : dirty.value ? "待保存" : planId.value ? "已自动保存" : "添加内容后自动保存"));
const durationOptions = [5, 10, 15, 30, 60, 120];
const batteryThresholdOptions = [10, 15, 20, 25, 30];
const extensionEventOptions = computed(() => extensionItems.value.flatMap(extension => extension.manifest.events.map(event => ({
  value: `${extension.id}:${event.key}`,
  label: `${t(extension.manifest.name)} · ${t(event.label)}`,
  extensionId: extension.id,
  eventKey: event.key,
}))));

const sourceIcons: Record<DisplayMode, Component> = {
  scene: Layers3,
  image: Image,
  media: Video,
  text: Type,
  clock: Clock3,
  system: Gauge,
  music: Music2,
};

function id() {
  return globalThis.crypto?.randomUUID?.() ?? `automation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function refreshLibrary() {
  items.value = await listLibraryItems();
}

async function refreshExtensions() {
  extensionItems.value = (await listExtensions()).filter(extension => extension.enabled && extension.manifest.events.length);
}

function handleLibraryChanged() {
  void refreshLibrary().catch(error => emit("message", t("刷新编排库失败：{error}", { error: errorMessage(error) })));
}

function handleExtensionsChanged() {
  void refreshExtensions().catch(error => emit("message", t("刷新扩展事件失败：{error}", { error: errorMessage(error) })));
}

function sourceValueFromEntry(entry?: AutomationEntry) {
  if (!entry) return "";
  return entry.libraryId ? `library:${entry.libraryId}` : `builtin:${entry.mode}`;
}

function entryFromSource(value: string, entryId = id()) {
  const source = sources.value.find(item => item.value === value);
  if (!source) return undefined;
  return {
    id: entryId,
    mode: source.mode,
    libraryId: source.libraryId,
    name: source.name,
    duration: source.mode === "media" ? 15 : 10,
  } satisfies AutomationEntry;
}

function currentTriggers() {
  const triggers: AutomationTrigger[] = [];
  const musicEntry = entryFromSource(musicTriggerSource.value, "trigger-entry-playing");
  const batteryEntry = entryFromSource(batteryTriggerSource.value, "trigger-entry-battery");
  if (musicEntry) triggers.push({ id: "trigger-playing", type: "playing", entry: musicEntry });
  if (batteryEntry) triggers.push({ id: "trigger-battery", type: "batteryLow", entry: batteryEntry, threshold: batteryThreshold.value });
  const eventEntry = entryFromSource(extensionEventTarget.value, "trigger-extension-event-entry");
  const event = extensionEventOptions.value.find(option => option.value === extensionEventSource.value);
  if (eventEntry && event) triggers.push({
    id: "trigger-extension-event",
    type: "extensionEvent",
    entry: eventEntry,
    extensionId: event.extensionId,
    eventKey: event.eventKey,
  });
  return triggers;
}

function currentPlan(): AutomationPlan {
  return { name: planName.value.trim() || t("未命名编排"), entries: structuredClone(entries.value), triggers: currentTriggers() };
}

async function usePlan(item: LibraryItem) {
  if (item.kind !== "playlist" || !item.playlist) return;
  await flushAutoSave();
  hydrating = true;
  planId.value = item.id;
  planName.value = item.playlist.name;
  entries.value = structuredClone(item.playlist.entries);
  musicTriggerSource.value = sourceValueFromEntry(item.playlist.triggers?.find(trigger => trigger.type === "playing")?.entry);
  const batteryTrigger = item.playlist.triggers?.find(trigger => trigger.type === "batteryLow");
  batteryTriggerSource.value = sourceValueFromEntry(batteryTrigger?.entry);
  batteryThreshold.value = batteryTrigger?.threshold ?? 20;
  const eventTrigger = item.playlist.triggers?.find(trigger => trigger.type === "extensionEvent");
  extensionEventSource.value = eventTrigger?.extensionId && eventTrigger.eventKey ? `${eventTrigger.extensionId}:${eventTrigger.eventKey}` : "";
  extensionEventTarget.value = sourceValueFromEntry(eventTrigger?.entry);
  localStorage.setItem("nova-automation-plan-id", item.id);
  dirty.value = false;
  await nextTick();
  hydrating = false;
}

async function newPlan() {
  await flushAutoSave();
  hydrating = true;
  planId.value = "";
  planName.value = t("新编排");
  entries.value = [];
  musicTriggerSource.value = "";
  batteryTriggerSource.value = "";
  batteryThreshold.value = 20;
  extensionEventSource.value = "";
  extensionEventTarget.value = "";
  dirty.value = false;
  localStorage.removeItem("nova-automation-plan-id");
  await nextTick();
  hydrating = false;
}

function addEntry(source: SourceOption) {
  const entry = entryFromSource(source.value);
  if (entry) entries.value.push(entry);
}

function moveEntry(index: number, direction: -1 | 1) {
  const target = index + direction;
  if (target < 0 || target >= entries.value.length) return;
  const [entry] = entries.value.splice(index, 1);
  entries.value.splice(target, 0, entry);
}

function removeEntry(index: number) {
  entries.value.splice(index, 1);
}

function startEntryDrag(event: DragEvent, entry: AutomationEntry) {
  draggedEntryId = entry.id;
  event.dataTransfer?.setData("text/plain", entry.id);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
}

function dropEntry(target: AutomationEntry) {
  const sourceIndex = entries.value.findIndex(entry => entry.id === draggedEntryId);
  const targetIndex = entries.value.findIndex(entry => entry.id === target.id);
  draggedEntryId = "";
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
  const [entry] = entries.value.splice(sourceIndex, 1);
  entries.value.splice(targetIndex, 0, entry);
}

function normalizeDuration(entry: AutomationEntry) {
  entry.duration = Math.max(2, Math.min(3600, Math.round(entry.duration || 10)));
}

async function savePlan(saveAs = false, showMessage = true) {
  if (!entries.value.length) {
    if (showMessage) emit("message", t("请先添加至少一个编排项目"));
    return false;
  }
  saving.value = true;
  const savingRevision = changeRevision;
  const snapshot = currentPlan();
  try {
    const item = await saveAutomationLibraryItem(snapshot, saveAs ? undefined : planId.value);
    planId.value = item.id;
    planName.value = item.name;
    if (savingRevision === changeRevision) dirty.value = false;
    await refreshLibrary();
    localStorage.setItem("nova-automation-plan-id", item.id);
    if (showMessage) emit("message", t(saveAs ? "已另存编排：{name}" : "编排已保存：{name}", { name: item.name }));
    return true;
  } catch (error) {
    emit("message", t("保存编排失败：{error}", { error: errorMessage(error) }));
    return false;
  } finally {
    saving.value = false;
    if (dirty.value && entries.value.length) {
      window.clearTimeout(autoSaveTimer);
      autoSaveTimer = window.setTimeout(() => void savePlan(false, false), 700);
    }
  }
}

function scheduleAutoSave() {
  if (hydrating) return;
  changeRevision += 1;
  dirty.value = true;
  window.clearTimeout(autoSaveTimer);
  if (entries.value.length) autoSaveTimer = window.setTimeout(() => void savePlan(false, false), 700);
}

async function flushAutoSave() {
  window.clearTimeout(autoSaveTimer);
  autoSaveTimer = 0;
  if (dirty.value && entries.value.length) await savePlan(false, false);
}

async function deletePlan(item: LibraryItem) {
  if (item.kind !== "playlist" || !window.confirm(t("确定删除编排“{name}”吗？", { name: item.name }))) return;
  try {
    if (props.running && props.activePlanId === item.id) emit("stop");
    await deleteLibraryItem(item.id);
    if (planId.value === item.id) {
      hydrating = true;
      planId.value = "";
      entries.value = [];
      musicTriggerSource.value = "";
      batteryTriggerSource.value = "";
      batteryThreshold.value = 20;
      extensionEventSource.value = "";
      extensionEventTarget.value = "";
      dirty.value = false;
      localStorage.removeItem("nova-automation-plan-id");
      await nextTick();
      hydrating = false;
    }
    await refreshLibrary();
    emit("message", t("已删除编排：{name}", { name: item.name }));
  } catch (error) {
    emit("message", t("删除编排失败：{error}", { error: errorMessage(error) }));
  }
}

async function start() {
  if (!entries.value.length) {
    emit("message", t("请先添加至少一个编排项目"));
    return;
  }
  entries.value.forEach(normalizeDuration);
  await flushAutoSave();
  emit("start", structuredClone(currentPlan()), planId.value);
}

async function startSavedPlan(item: LibraryItem) {
  await usePlan(item);
  await start();
}

function updateRemaining() {
  remaining.value = props.running ? Math.max(0, Math.ceil((props.endsAt - Date.now()) / 1000)) : 0;
}

function syncRemainingClock() {
  window.clearInterval(clockTimer);
  clockTimer = 0;
  updateRemaining();
  if (props.running) clockTimer = window.setInterval(updateRemaining, 1000);
}

onMounted(async () => {
  window.addEventListener("nova-library-changed", handleLibraryChanged);
  window.addEventListener("nova-extensions-changed", handleExtensionsChanged);
  try {
    await refreshLibrary();
    await refreshExtensions();
    const savedId = localStorage.getItem("nova-automation-plan-id");
    const selected = plans.value.find(item => item.id === savedId) ?? plans.value[0];
    if (selected) await usePlan(selected);
  } catch (error) {
    emit("message", t("读取编排库失败：{error}", { error: errorMessage(error) }));
  }
  syncRemainingClock();
});

watch([planName, entries, musicTriggerSource, batteryTriggerSource, batteryThreshold, extensionEventSource, extensionEventTarget], scheduleAutoSave, { deep: true });
watch(() => [props.running, props.endsAt] as const, syncRemainingClock);

watch(locale, async () => {
  const untouchedDefaults = ["我的编排", "My automations", "新编排", "New automation", "未命名编排", "Untitled automation"];
  if (planId.value || entries.value.length || !untouchedDefaults.includes(planName.value)) return;
  hydrating = true;
  planName.value = t("未命名编排");
  await nextTick();
  hydrating = false;
});

onBeforeUnmount(() => {
  window.removeEventListener("nova-library-changed", handleLibraryChanged);
  window.removeEventListener("nova-extensions-changed", handleExtensionsChanged);
  window.clearInterval(clockTimer);
  void flushAutoSave();
});
</script>

<template>
  <section class="automation-view">
    <div class="page-heading">
      <div><span class="eyebrow">AUTOMATION</span><h1>{{ t("场景编排") }}</h1></div>
      <div :class="['run-state', { active: running }]">
        <i></i>
        <span>{{ running ? `${activeLabel}${activeTrigger ? '' : ` · ${remaining}s`}` : t('已停止') }}</span>
      </div>
    </div>

    <div class="plan-toolbar">
      <label><span>{{ t("编排名称") }}</span><input v-model="planName" maxlength="32" /></label>
      <span :class="['save-state', { dirty }]">{{ saveState }}</span>
      <div class="toolbar-actions">
        <button :title="t('新建编排')" @click="newPlan"><Plus :size="15" />{{ t("新建") }}</button>
        <button class="save" :disabled="saving || !entries.length" :title="t('立即保存')" @click="savePlan(false, true)"><Save :size="15" /></button>
        <button :title="t('另存为新编排')" @click="savePlan(true)"><Copy :size="15" />{{ t("另存为") }}</button>
      </div>
    </div>

    <div class="plan-library">
      <div class="section-title"><strong>{{ t("我的编排") }}</strong><span>{{ t("{count} 个方案", { count: plans.length }) }}</span></div>
      <div v-if="plans.length" class="plan-list">
        <div
          v-for="item in plans"
          :key="item.id"
          :class="['plan-card', { active: planId === item.id }]"
          role="button"
          tabindex="0"
          @click="usePlan(item)"
          @keydown.enter="usePlan(item)"
        >
          <ListVideo :size="16" />
          <div><strong>{{ item.name }}</strong><span>{{ t("{count} 个项目", { count: item.playlist?.entries.length ?? 0 }) }}</span></div>
          <button class="play-plan" :title="t('启动 {name}', { name: item.name })" @click.stop="startSavedPlan(item)"><Play :size="12" fill="currentColor" /></button>
          <button class="delete-plan" :title="t('删除 {name}', { name: item.name })" @click.stop="deletePlan(item)"><Trash2 :size="13" /></button>
        </div>
      </div>
      <div v-else class="empty-library">{{ t("尚未保存编排方案") }}</div>
    </div>

    <div class="composer-grid">
      <aside class="source-browser">
        <div class="panel-heading"><strong>{{ t("内容库") }}</strong><span>{{ t("{count} 项", { count: sources.length }) }}</span></div>
        <div class="source-groups">
          <div v-for="group in sourceGroups" :key="group.label" class="source-group">
            <span>{{ group.label }}</span>
            <button v-for="source in group.items" :key="source.value" :title="t('添加 {name}', { name: source.name })" @click="addEntry(source)">
              <component :is="sourceIcons[source.mode]" :size="15" />
              <span><strong>{{ source.name }}</strong><small>{{ source.detail }}</small></span>
              <Plus :size="13" />
            </button>
          </div>
        </div>
      </aside>

      <section class="sequence-panel">
        <div class="trigger-panel">
          <div class="panel-heading"><strong>{{ t("自动切换") }}</strong><span>{{ t("可选") }}</span></div>
          <label><Music2 :size="15" /><span>{{ t("播放音乐时") }}</span><div class="trigger-controls"><select v-model="musicTriggerSource"><option value="">{{ t("不切换") }}</option><option v-for="source in sources" :key="source.value" :value="source.value">{{ source.detail }} · {{ source.name }}</option></select></div></label>
          <label><BatteryWarning :size="15" /><span>{{ t("低电量时") }}</span><div class="trigger-controls with-option"><select v-model="batteryTriggerSource"><option value="">{{ t("不切换") }}</option><option v-for="source in sources" :key="source.value" :value="source.value">{{ source.detail }} · {{ source.name }}</option></select><select v-model.number="batteryThreshold" :aria-label="t('低电量阈值')"><option v-for="value in batteryThresholdOptions" :key="value" :value="value">≤ {{ value }}%</option></select></div></label>
          <label v-if="extensionEventOptions.length"><Zap :size="15" /><span>{{ t("扩展事件时") }}</span><div class="trigger-controls with-option event-option"><select v-model="extensionEventSource"><option value="">{{ t("不切换") }}</option><option v-for="event in extensionEventOptions" :key="event.value" :value="event.value">{{ event.label }}</option></select><select v-model="extensionEventTarget" :aria-label="t('扩展事件显示内容')"><option value="">{{ t("选择显示内容") }}</option><option v-for="source in sources" :key="source.value" :value="source.value">{{ source.detail }} · {{ source.name }}</option></select></div></label>
        </div>

        <div class="sequence-heading">
          <div><strong>{{ t("播放顺序") }}</strong><span>{{ t("{count} 个项目", { count: entries.length }) }}</span></div>
          <div class="transport">
            <button :disabled="!running || !!activeTrigger" :title="t('上一个')" @click="$emit('skip', -1)"><SkipBack :size="16" fill="currentColor" /></button>
            <button v-if="!running" class="play" :title="t('启动编排')" @click="start"><Play :size="16" fill="currentColor" />{{ t("启动") }}</button>
            <button v-else class="stop" :title="t('停止编排')" @click="$emit('stop')"><Pause :size="16" fill="currentColor" />{{ t("停止") }}</button>
            <button :disabled="!running || !!activeTrigger" :title="t('下一个')" @click="$emit('skip', 1)"><SkipForward :size="16" fill="currentColor" /></button>
          </div>
        </div>

        <div v-if="entries.length" class="sequence-list">
          <div
            v-for="(entry, index) in entries"
            :key="entry.id"
            :class="['sequence-row', { active: running && !activeTrigger && activePlanId === planId && currentIndex === index }]"
            draggable="true"
            @dragstart="startEntryDrag($event, entry)"
            @dragend="draggedEntryId = ''"
            @dragover.prevent
            @drop.prevent="dropEntry(entry)"
          >
            <GripVertical :size="14" class="drag-handle" />
            <span class="sequence-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <component :is="sourceIcons[entry.mode]" :size="16" />
            <div class="entry-name"><strong>{{ entry.name }}</strong><span>{{ t(entry.libraryId ? '主题库' : '内置模式') }}</span></div>
            <select v-model.number="entry.duration" class="duration" :aria-label="t('停留时间')" @change="normalizeDuration(entry)">
              <option v-if="!durationOptions.includes(entry.duration)" :value="entry.duration">{{ t("{seconds} 秒", { seconds: entry.duration }) }}</option>
              <option v-for="duration in durationOptions" :key="duration" :value="duration">{{ t("{seconds} 秒", { seconds: duration }) }}</option>
            </select>
            <button :disabled="index === 0" :title="t('上移')" @click="moveEntry(index, -1)"><ArrowUp :size="14" /></button>
            <button :disabled="index === entries.length - 1" :title="t('下移')" @click="moveEntry(index, 1)"><ArrowDown :size="14" /></button>
            <button class="remove" :title="t('移除')" @click="removeEntry(index)"><Trash2 :size="14" /></button>
          </div>
        </div>
        <div v-else class="empty-sequence">{{ t("尚未添加播放内容") }}</div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.automation-view { max-width: 1120px; margin: 0 auto; }
.page-heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 18px; }
.eyebrow { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }
h1 { margin-top: 6px; color: var(--text-strong); font-size: 22px; font-weight: 620; }
.run-state { height: 27px; padding: 0 9px; border: 1px solid var(--line-strong); border-radius: 3px; display: flex; align-items: center; gap: 7px; color: #727a77; font: 9px/1 var(--mono); }
.run-state i { width: 6px; height: 6px; border-radius: 50%; background: #565d5a; }
.run-state.active { border-color: #41654d; color: #a9dfbd; }
.run-state.active i { background: var(--green); box-shadow: 0 0 8px rgba(102, 231, 153, .55); }
.plan-toolbar { padding: 12px; border: 1px solid var(--line); background: var(--surface); display: flex; align-items: end; flex-wrap: wrap; gap: 9px; }
.plan-toolbar label { flex: 1; display: flex; flex-direction: column; gap: 5px; color: var(--muted); font-size: 9px; }
.plan-toolbar input, .trigger-panel select, .duration { border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); color: var(--text); outline: 0; }
.plan-toolbar input { width: 100%; height: 32px; padding: 0 9px; }
.save-state { flex: 0 0 auto; height: 24px; padding: 0 8px; margin-bottom: 4px; border: 1px solid #34403a; border-radius: 3px; display: inline-flex; align-items: center; color: #7fa68d; font: 8px/1 var(--mono); }
.save-state.dirty { border-color: #665637; color: #d2b46f; }
.toolbar-actions { display: flex; gap: 6px; }
button { border: 1px solid var(--line-strong); border-radius: 3px; background: var(--control); color: var(--text-soft); cursor: pointer; }
button:hover:not(:disabled) { border-color: #4b725b; color: var(--green); }
button:disabled { opacity: .35; cursor: default; }
.toolbar-actions button { height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; font-size: 9px; }
.toolbar-actions .save { border-color: #45634f; background: var(--accent-soft); color: var(--green); }
.plan-library { padding: 13px; border: 1px solid var(--line); border-top: 0; background: var(--surface-sidebar); }
.section-title { display: flex; justify-content: space-between; margin-bottom: 8px; }
.section-title strong { color: var(--text-soft); font-size: 10px; font-weight: 600; }
.section-title span { color: var(--muted-soft); font: 8px/1 var(--mono); }
.plan-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 7px; }
.plan-card { position: relative; height: 48px; padding: 7px 57px 7px 8px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); display: flex; align-items: center; gap: 8px; color: #777f7c; cursor: pointer; outline: 0; }
.plan-card:hover, .plan-card:focus-visible { border-color: #53605b; }
.plan-card.active { border-color: var(--green); background: var(--accent-soft); color: var(--green); }
.plan-card div { min-width: 0; }
.plan-card strong, .plan-card span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-card strong { color: var(--text-soft); font-size: 9px; font-weight: 600; }
.plan-card span { margin-top: 4px; color: #67706c; font-size: 8px; }
.plan-card > button { position: absolute; right: 4px; width: 24px; height: 24px; border: 0; background: transparent; display: grid; place-items: center; }
.plan-card > button.play-plan { right: 29px; }
.plan-card > button.play-plan:hover { background: var(--accent-soft); color: var(--green); }
.plan-card > button.delete-plan:hover { background: #352321; color: #e19a8c; }
.empty-library { height: 36px; border: 1px dashed var(--line-strong); display: grid; place-items: center; color: #606865; font-size: 9px; }
.composer-grid { margin-top: 14px; display: grid; grid-template-columns: 245px minmax(0, 1fr); gap: 12px; align-items: start; }
.source-browser, .sequence-panel { border: 1px solid var(--line); background: var(--surface); }
.source-browser { max-height: 462px; display: flex; flex-direction: column; }
.panel-heading { height: 38px; padding: 0 10px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); }
.panel-heading strong { color: var(--text-soft); font-size: 10px; font-weight: 600; }
.panel-heading span { color: #68706d; font: 8px/1 var(--mono); }
.source-groups { padding: 8px; overflow: auto; }
.source-group + .source-group { margin-top: 10px; }
.source-group > span { display: block; margin: 0 2px 5px; color: var(--muted-soft); font-size: 8px; }
.source-group > button { width: 100%; min-height: 38px; padding: 5px 7px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--surface-sidebar); display: grid; grid-template-columns: 20px minmax(0, 1fr) 16px; align-items: center; gap: 6px; text-align: left; }
.source-group > button:first-of-type { border-radius: 3px 3px 0 0; }
.source-group > button:last-of-type { border-bottom: 0; border-radius: 0 0 3px 3px; }
.source-group > button:hover { background: var(--accent-soft); }
.source-group > button > span { min-width: 0; }
.source-group strong, .source-group small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-group strong { color: var(--text-soft); font-size: 9px; font-weight: 550; }
.source-group small { margin-top: 3px; color: #65706b; font-size: 7px; }
.source-group button > svg:last-child { color: #66716c; }
.source-group button:hover > svg:last-child { color: var(--green); }
.trigger-panel { padding-bottom: 8px; border-bottom: 1px solid var(--line); }
.trigger-panel .panel-heading { border-bottom: 0; }
.trigger-panel label { min-height: 38px; padding: 4px 10px; display: grid; grid-template-columns: 18px minmax(92px, auto) minmax(0, 1fr); align-items: center; gap: 7px; color: var(--muted); font-size: 9px; }
.trigger-panel label > svg { color: #75807b; }
.trigger-panel select { width: 100%; height: 29px; padding: 0 6px; font-size: 9px; }
.trigger-controls { min-width: 0; }
.trigger-controls.with-option { display: grid; grid-template-columns: minmax(0, 1fr) 78px; gap: 6px; }
.trigger-controls.with-option.event-option { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.sequence-heading { min-height: 54px; padding: 9px 12px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sequence-heading > div:first-child strong, .sequence-heading > div:first-child span { display: block; }
.sequence-heading strong { color: #d0d6d3; font-size: 11px; }
.sequence-heading span { margin-top: 4px; color: #68706d; font-size: 8px; }
.transport { display: flex; gap: 5px; }
.transport button { width: 32px; height: 31px; display: grid; place-items: center; }
.transport .play, .transport .stop { width: auto; padding: 0 11px; display: inline-flex; gap: 6px; font-size: 9px; }
.transport .play { border-color: #62d98f; background: var(--green); color: #0e1812; }
.transport .play:hover { color: #0e1812; }
.transport .stop { border-color: #9b5a4e; background: #39231f; color: #eda394; }
.sequence-list { border-top: 1px solid var(--line); }
.sequence-row { min-height: 51px; padding: 7px 8px; display: grid; grid-template-columns: 17px 25px 19px minmax(105px, 1fr) 82px 29px 29px 29px; align-items: center; gap: 5px; border-bottom: 1px solid var(--line); color: #727a77; }
.sequence-row:last-child { border-bottom: 0; }
.sequence-row.active { background: var(--accent-soft); box-shadow: inset 2px 0 var(--green); color: var(--green); }
.drag-handle { color: #555e5a; cursor: grab; }
.sequence-index { color: #5f6764; font: 9px/1 var(--mono); }
.entry-name { min-width: 0; }
.entry-name strong, .entry-name span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entry-name strong { color: var(--text-soft); font-size: 10px; font-weight: 550; }
.entry-name span { margin-top: 4px; color: #646c69; font-size: 8px; }
.duration { width: 82px; height: 29px; padding: 0 5px; font: 9px/1 var(--mono); }
.sequence-row > button { width: 29px; height: 29px; display: grid; place-items: center; }
.sequence-row > button.remove:hover { border-color: #75483f; color: #e19a8c; }
.empty-sequence { height: 112px; border-top: 1px solid var(--line); display: grid; place-items: center; color: #616966; font-size: 10px; }
@media (max-width: 900px) { .composer-grid { grid-template-columns: 1fr; } .source-browser { max-height: 300px; } }
@media (max-width: 780px) { .plan-toolbar { align-items: stretch; flex-direction: column; } .toolbar-actions { flex-wrap: wrap; } .sequence-row { grid-template-columns: 15px 23px 17px minmax(90px, 1fr) 70px 27px 27px 27px; gap: 3px; } }
</style>
