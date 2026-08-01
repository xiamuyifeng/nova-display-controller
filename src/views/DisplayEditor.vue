<script setup lang="ts">
import {
  AlignCenter, AlignLeft, Clock3, Copy, FileImage, Gauge, Image, Invert,
  Layers3, Music2, Pause, Play, Save, Search, Send, SlidersHorizontal, Star, Trash2, Type, Upload, Video,
} from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from "vue";
import SceneEditor from "../components/SceneEditor.vue";
import { useI18n } from "../services/i18n";
import {
  deleteLibraryItem,
  duplicateLibraryItem,
  listLibraryItems,
  removeAssetFromSavedScenes,
  removeItemFromSavedPlaylists,
  saveMediaLibraryItem,
  saveTextLibraryItem,
  setLibraryItemFavorite,
  updateMediaLibrarySettings,
  type LibraryItem,
} from "../services/library";
import type { DeviceInfo, DisplayConfig, DisplayMode, MediaDisplaySettings, SystemMetrics } from "../types";

const props = defineProps<{
  config: DisplayConfig;
  brightness: number;
  live: boolean;
  connected: boolean;
  busy: boolean;
  metrics: SystemMetrics;
  device: DeviceInfo;
}>();

const emit = defineEmits<{
  "update:brightness": [value: number];
  send: [];
  start: [];
  stop: [];
  message: [value: string];
}>();

const { t } = useI18n();
const modes = computed<{ id: DisplayMode; label: string; icon: Component }[]>(() => [
  { id: "scene", label: t("自由场景"), icon: Layers3 },
  { id: "image", label: t("图片"), icon: Image },
  { id: "media", label: t("动画 / 视频"), icon: Video },
  { id: "text", label: t("文字"), icon: Type },
  { id: "clock", label: t("时钟"), icon: Clock3 },
  { id: "system", label: t("系统监控"), icon: Gauge },
  { id: "music", label: t("音乐信息"), icon: Music2 },
]);

const libraryItems = ref<LibraryItem[]>([]);
const libraryUrls = ref<Record<string, string>>({});
const mediaItems = computed(() => libraryItems.value.filter(item => props.config.mode === "image"
  ? item.kind === "image"
  : item.kind === "gif" || item.kind === "video"));
const textItems = computed(() => libraryItems.value.filter(item => item.kind === "text"));
const themeSearch = ref("");
const favoriteOnly = ref(false);
const matchesThemeFilter = (item: LibraryItem) => (!favoriteOnly.value || item.favorite)
  && (!themeSearch.value.trim() || item.name.toLocaleLowerCase().includes(themeSearch.value.trim().toLocaleLowerCase()));
const filteredMediaItems = computed(() => mediaItems.value.filter(matchesThemeFilter));
const filteredTextItems = computed(() => textItems.value.filter(matchesThemeFilter));
let activeMediaUrl = "";
let mediaSettingsTimer = 0;

const defaultMediaSettings: MediaDisplaySettings = {
  fit: "contain",
  threshold: 128,
  dither: true,
  invert: false,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function revokeActiveMediaUrl() {
  if (activeMediaUrl) URL.revokeObjectURL(activeMediaUrl);
  activeMediaUrl = "";
}

async function refreshLibrary() {
  Object.values(libraryUrls.value).forEach(url => URL.revokeObjectURL(url));
  const items = await listLibraryItems();
  libraryItems.value = items;
  libraryUrls.value = Object.fromEntries(items
    .filter(item => item.blob)
    .map(item => [item.id, URL.createObjectURL(item.blob!)]));
}

function handleLibraryChanged() {
  void refreshLibrary().catch(error => emit("message", t("刷新主题库失败：{error}", { error: errorMessage(error) })));
}

function useMediaItem(item: LibraryItem) {
  if (!item.blob || (item.kind !== "image" && item.kind !== "gif" && item.kind !== "video")) return;
  if (props.config.mediaLibraryId && props.config.mediaLibraryId !== item.id) {
    window.clearTimeout(mediaSettingsTimer);
    mediaSettingsTimer = 0;
    void persistCurrentMediaSettings();
  }
  revokeActiveMediaUrl();
  activeMediaUrl = URL.createObjectURL(item.blob);
  props.config.mediaUrl = activeMediaUrl;
  props.config.mediaLibraryId = item.id;
  props.config.mediaKind = item.kind;
  props.config.mediaName = item.name;
  Object.assign(props.config, item.mediaSettings ?? defaultMediaSettings);
}

function currentMediaSettings(): MediaDisplaySettings {
  return {
    fit: props.config.fit,
    threshold: props.config.threshold,
    dither: props.config.dither,
    invert: props.config.invert,
  };
}

async function persistCurrentMediaSettings() {
  const id = props.config.mediaLibraryId;
  if (!id) return;
  const settings = currentMediaSettings();
  try {
    await updateMediaLibrarySettings(id, settings);
    const item = libraryItems.value.find(entry => entry.id === id);
    if (item) item.mediaSettings = settings;
  } catch (error) {
    emit("message", t("保存主题参数失败：{error}", { error: errorMessage(error) }));
  }
}

function useTextItem(item: LibraryItem) {
  if (item.kind !== "text") return;
  props.config.text = item.text ?? "";
  props.config.fontSize = item.fontSize ?? 20;
  props.config.align = item.align ?? "center";
}

function updateBrightness(event: Event) {
  emit("update:brightness", Number((event.target as HTMLInputElement).value));
}

async function loadFile(file?: File) {
  if (!file) return;
  const isVideo = file.type.startsWith("video/");
  const isGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
  if (props.config.mode === "image" && (isVideo || isGif)) {
    emit("message", t("动画和视频请在“动画 / 视频”模式中导入"));
    return;
  }
  try {
    const item = await saveMediaLibraryItem(file, currentMediaSettings());
    await refreshLibrary();
    useMediaItem(item);
    emit("message", t("已保存到我的主题：{name}", { name: file.name }));
  } catch (error) {
    emit("message", t("保存素材失败：{error}", { error: errorMessage(error) }));
  }
}

function handleFile(event: Event) {
  const input = event.target as HTMLInputElement;
  void loadFile(input.files?.[0]);
  input.value = "";
}

function handleDrop(event: DragEvent) {
  void loadFile(event.dataTransfer?.files[0]);
}

async function saveTextPreset() {
  try {
    await saveTextLibraryItem(props.config.text, props.config.fontSize, props.config.align);
    await refreshLibrary();
    emit("message", t("文字主题已保存"));
  } catch (error) {
    emit("message", t("保存文字失败：{error}", { error: errorMessage(error) }));
  }
}

async function toggleFavorite(item: LibraryItem) {
  try {
    await setLibraryItemFavorite(item.id, !item.favorite);
    await refreshLibrary();
  } catch (error) {
    emit("message", t("更新收藏失败：{error}", { error: errorMessage(error) }));
  }
}

async function duplicateTheme(item: LibraryItem) {
  try {
    const copy = await duplicateLibraryItem(item.id);
    await refreshLibrary();
    if (copy.kind === "text") useTextItem(copy);
    else useMediaItem(copy);
    emit("message", t("已复制主题：{name}", { name: copy.name }));
  } catch (error) {
    emit("message", t("复制主题失败：{error}", { error: errorMessage(error) }));
  }
}

async function removeLibraryItem(item: LibraryItem) {
  const sceneAsset = item.kind === "image" || item.kind === "gif" || item.kind === "video";
  const referencedByScene = sceneAsset && props.config.scene.layers.some(layer => layer.assetId === item.id);
  const warning = referencedByScene ? t("\n这个素材也用于自由场景，删除后对应图层将变为空白。") : "";
  if (!window.confirm(t("确定删除“{name}”吗？{warning}", { name: item.name, warning }))) return;
  try {
    if (props.config.mediaLibraryId === item.id) {
      window.clearTimeout(mediaSettingsTimer);
      mediaSettingsTimer = 0;
      await persistCurrentMediaSettings();
    }
    await deleteLibraryItem(item.id);
    if (props.config.mediaLibraryId === item.id) {
      revokeActiveMediaUrl();
      props.config.mediaUrl = "";
      props.config.mediaLibraryId = "";
      props.config.mediaKind = "";
      props.config.mediaName = "";
    }
    if (referencedByScene) {
      props.config.scene.layers.forEach(layer => {
        if (layer.assetId === item.id) layer.assetId = undefined;
      });
    }
    const savedSceneCount = sceneAsset ? await removeAssetFromSavedScenes(item.id) : 0;
    const savedPlaylistCount = await removeItemFromSavedPlaylists(item.id);
    await refreshLibrary();
    const cleaned = [
      savedSceneCount > 0 ? t("{count} 个场景", { count: savedSceneCount }) : "",
      savedPlaylistCount > 0 ? t("{count} 个编排", { count: savedPlaylistCount }) : "",
    ].filter(Boolean).join(t("、"));
    emit("message", cleaned
      ? t("已删除：{name}，并清理 {items} 中的引用", { name: item.name, items: cleaned })
      : t("已删除：{name}", { name: item.name }));
  } catch (error) {
    emit("message", t("删除失败：{error}", { error: errorMessage(error) }));
  }
}

onMounted(async () => {
  window.addEventListener("nova-library-changed", handleLibraryChanged);
  try {
    activeMediaUrl = props.config.mediaLibraryId ? props.config.mediaUrl : "";
    await refreshLibrary();
    const selected = libraryItems.value.find(item => item.id === props.config.mediaLibraryId);
    if (selected?.blob) useMediaItem(selected);
  } catch (error) {
    emit("message", t("读取主题库失败：{error}", { error: errorMessage(error) }));
  }
});

watch(
  () => [props.config.mediaLibraryId, props.config.fit, props.config.threshold, props.config.dither, props.config.invert] as const,
  ([id]) => {
    window.clearTimeout(mediaSettingsTimer);
    if (!id) return;
    mediaSettingsTimer = window.setTimeout(() => {
      mediaSettingsTimer = 0;
      void persistCurrentMediaSettings();
    }, 250);
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("nova-library-changed", handleLibraryChanged);
  if (mediaSettingsTimer) {
    window.clearTimeout(mediaSettingsTimer);
    void persistCurrentMediaSettings();
  }
  if (activeMediaUrl && activeMediaUrl !== props.config.mediaUrl) URL.revokeObjectURL(activeMediaUrl);
  activeMediaUrl = "";
  Object.values(libraryUrls.value).forEach(url => URL.revokeObjectURL(url));
});
</script>

<template>
  <section class="editor">
    <div class="section-heading">
      <div><span class="eyebrow">SOURCE</span><h2>{{ t("显示内容") }}</h2></div>
      <span class="mode-note">{{ modes.find(item => item.id === config.mode)?.label }}</span>
    </div>

    <div class="mode-grid">
      <button
        v-for="mode in modes"
        :key="mode.id"
        :class="['mode-button', { active: config.mode === mode.id }]"
        @click="config.mode = mode.id"
      >
        <component :is="mode.icon" :size="17" :stroke-width="1.7" />
        <span>{{ mode.label }}</span>
      </button>
    </div>

    <div class="control-panel" :class="{ compact: config.mode === 'clock', scene: config.mode === 'scene' }">
      <SceneEditor v-if="config.mode === 'scene'" :config="config" :metrics="metrics" :device="device" @message="$emit('message', $event)" />

      <template v-else-if="config.mode === 'image' || config.mode === 'media'">
        <label class="drop-zone" @dragover.prevent @drop.prevent="handleDrop">
          <input
            type="file"
            :accept="config.mode === 'image' ? 'image/png,image/jpeg,image/bmp,image/webp' : 'image/gif,video/*'"
            hidden
            @change="handleFile"
          />
          <FileImage v-if="config.mediaName" :size="24" />
          <Upload v-else :size="24" />
          <strong>{{ config.mediaName || t(config.mode === 'image' ? '导入图片' : '导入 GIF 或视频') }}</strong>
          <small>{{ t(config.mediaName ? '点击以替换当前媒体' : '点击选择文件，也可拖放到这里') }}</small>
        </label>
        <div class="field-row three">
          <label class="field"><span>{{ t("缩放方式") }}</span><select v-model="config.fit"><option value="contain">{{ t("完整显示") }}</option><option value="cover">{{ t("填满屏幕") }}</option><option value="stretch">{{ t("拉伸") }}</option></select></label>
          <label class="field"><span>{{ t("黑白阈值") }} <b>{{ config.threshold }}</b></span><input v-model.number="config.threshold" type="range" min="32" max="224" /></label>
          <div class="switch-stack">
            <label class="switch"><input v-model="config.dither" type="checkbox" /><i></i><span>{{ t("误差扩散抖动") }}</span></label>
            <label class="switch"><input v-model="config.invert" type="checkbox" /><i></i><span>{{ t("反色") }}</span></label>
          </div>
        </div>
        <div class="library-section">
          <div class="library-heading">
            <div><strong>{{ t("我的主题") }}</strong><span>{{ t("{count} 个素材", { count: mediaItems.length }) }}</span></div>
            <div v-if="mediaItems.length" class="library-filters"><button :class="{ active: favoriteOnly }" :title="t('只看收藏')" @click="favoriteOnly = !favoriteOnly"><Star :size="13" :fill="favoriteOnly ? 'currentColor' : 'none'" /></button><label><Search :size="13" /><input v-model="themeSearch" type="search" :placeholder="t('搜索主题')" /></label></div>
          </div>
          <div v-if="filteredMediaItems.length" class="library-grid">
            <div
              v-for="item in filteredMediaItems"
              :key="item.id"
              :class="['library-card', { active: config.mediaLibraryId === item.id }]"
              role="button"
              tabindex="0"
              @click="useMediaItem(item)"
              @keydown.enter="useMediaItem(item)"
            >
              <div class="asset-preview">
                <img v-if="item.kind !== 'video'" :src="libraryUrls[item.id]" alt="" />
                <Video v-else :size="22" />
                <span class="asset-kind">{{ item.kind === 'gif' ? 'GIF' : t(item.kind === 'image' ? '图片' : '视频') }}</span>
              </div>
              <div class="asset-name" :title="item.name">{{ item.name }}</div>
              <div class="theme-card-actions"><button :class="{ favorite: item.favorite }" :title="t(item.favorite ? '取消收藏 {name}' : '收藏 {name}', { name: item.name })" @click.stop="toggleFavorite(item)"><Star :size="13" :fill="item.favorite ? 'currentColor' : 'none'" /></button><button :title="t('复制 {name}', { name: item.name })" @click.stop="duplicateTheme(item)"><Copy :size="13" /></button><button class="delete" :title="t('删除 {name}', { name: item.name })" @click.stop="removeLibraryItem(item)"><Trash2 :size="13" /></button></div>
            </div>
          </div>
          <div v-else-if="mediaItems.length" class="library-empty">{{ t("没有匹配的主题") }}</div>
          <div v-else class="library-empty">{{ t("上传后的素材会保存在这里，之后可以直接切换。") }}</div>
        </div>
      </template>

      <template v-else-if="config.mode === 'text'">
        <label class="field"><span>{{ t("显示文字") }}</span><textarea v-model="config.text" maxlength="120" rows="4" :placeholder="t('输入要显示在 OLED 上的内容')" /></label>
        <div class="field-row">
          <label class="field"><span>{{ t("字号") }} <b>{{ config.fontSize }} px</b></span><input v-model.number="config.fontSize" type="range" min="8" max="32" /></label>
          <div class="field"><span>{{ t("对齐与保存") }}</span><div class="text-actions"><div class="segmented"><button :class="{ active: config.align === 'left' }" :title="t('左对齐')" @click="config.align = 'left'"><AlignLeft :size="16" /></button><button :class="{ active: config.align === 'center' }" :title="t('居中')" @click="config.align = 'center'"><AlignCenter :size="16" /></button></div><button class="save-text" :title="t('保存到我的主题')" @click="saveTextPreset"><Save :size="14" />{{ t("保存主题") }}</button></div></div>
        </div>
        <div class="library-section text-library">
          <div class="library-heading">
            <div><strong>{{ t("我的文字主题") }}</strong><span>{{ t("{count} 个预设", { count: textItems.length }) }}</span></div>
            <div v-if="textItems.length" class="library-filters"><button :class="{ active: favoriteOnly }" :title="t('只看收藏')" @click="favoriteOnly = !favoriteOnly"><Star :size="13" :fill="favoriteOnly ? 'currentColor' : 'none'" /></button><label><Search :size="13" /><input v-model="themeSearch" type="search" :placeholder="t('搜索主题')" /></label></div>
          </div>
          <div v-if="filteredTextItems.length" class="library-grid text-presets">
            <div
              v-for="item in filteredTextItems"
              :key="item.id"
              class="library-card text-card"
              role="button"
              tabindex="0"
              @click="useTextItem(item)"
              @keydown.enter="useTextItem(item)"
            >
              <div class="text-sample">{{ item.text }}</div>
              <div class="asset-name">{{ item.name }} · {{ item.fontSize }} px</div>
              <div class="theme-card-actions"><button :class="{ favorite: item.favorite }" :title="t(item.favorite ? '取消收藏 {name}' : '收藏 {name}', { name: item.name })" @click.stop="toggleFavorite(item)"><Star :size="13" :fill="item.favorite ? 'currentColor' : 'none'" /></button><button :title="t('复制 {name}', { name: item.name })" @click.stop="duplicateTheme(item)"><Copy :size="13" /></button><button class="delete" :title="t('删除 {name}', { name: item.name })" @click.stop="removeLibraryItem(item)"><Trash2 :size="13" /></button></div>
            </div>
          </div>
          <div v-else-if="textItems.length" class="library-empty">{{ t("没有匹配的文字主题") }}</div>
          <div v-else class="library-empty">{{ t("保存常用文字后，可在这里快速恢复内容、字号和对齐。") }}</div>
        </div>
      </template>

      <template v-else-if="config.mode === 'clock'">
        <div class="field-row">
          <label class="field"><span>{{ t("时间格式") }}</span><select v-model="config.clockFormat"><option value="24h-seconds">{{ t("24 小时，含秒") }}</option><option value="24h">{{ t("24 小时") }}</option><option value="12h">{{ t("12 小时") }}</option></select></label>
          <div class="field"><span>{{ t("附加内容") }}</span><label class="switch"><input v-model="config.showDate" type="checkbox" /><i></i><span>{{ t("显示日期与星期") }}</span></label></div>
        </div>
      </template>

      <template v-else-if="config.mode === 'system'">
        <div class="monitor-options">
          <label class="switch"><input v-model="config.showCpu" type="checkbox" /><i></i><span>{{ t("CPU 使用率") }}</span></label>
          <label class="switch"><input v-model="config.showMemory" type="checkbox" /><i></i><span>{{ t("内存使用率") }}</span></label>
        </div>
        <p class="inline-note">{{ t("系统指标每秒刷新，OLED 使用条形图显示当前负载。") }}</p>
      </template>

      <template v-else-if="config.mode === 'music'">
        <div class="monitor-options music-source">
          <label class="switch"><input v-model="config.autoMedia" type="checkbox" /><i></i><span>{{ t("自动读取 Windows 当前媒体") }}</span></label>
        </div>
        <div class="field-row">
          <label class="field"><span>{{ t("曲目") }}</span><input v-model="config.track" :disabled="config.autoMedia" type="text" maxlength="60" /></label>
          <label class="field"><span>{{ t("艺术家") }}</span><input v-model="config.artist" :disabled="config.autoMedia" type="text" maxlength="60" /></label>
        </div>
        <label class="field"><span>{{ t("播放进度") }} <b>{{ Math.round(config.progress) }}%</b></span><input v-model.number="config.progress" :disabled="config.autoMedia" type="range" min="0" max="100" /></label>
        <p class="inline-note">{{ t("自动模式通过 Windows GSMTC 读取 Spotify、浏览器和常见播放器；无会话时保留上一条信息。") }}</p>
      </template>
    </div>

    <div class="output-strip">
      <SlidersHorizontal :size="17" />
      <label class="brightness"><span>{{ t("OLED 亮度") }}</span><input :value="brightness" type="range" min="1" max="10" @input="updateBrightness" /><b>{{ brightness }}/10</b></label>
      <div class="actions">
        <button class="secondary" :disabled="busy || !connected" @click="$emit('send')"><Send :size="15" />{{ t("发送当前帧") }}</button>
        <button v-if="!live" class="primary" :disabled="busy || !connected" @click="$emit('start')"><Play :size="15" fill="currentColor" />{{ t(config.mode === 'media' ? '播放到 OLED' : '开始实时显示') }}</button>
        <button v-else class="danger" :disabled="busy" @click="$emit('stop')"><Pause :size="15" fill="currentColor" />{{ t(config.mode === 'media' ? '停止播放并返回' : '停止并返回') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; min-height: 100%; }
.section-heading { display: flex; align-items: end; justify-content: space-between; margin-bottom: 13px; }
.eyebrow { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }
h2 { margin-top: 5px; color: var(--text-strong); font-size: 17px; font-weight: 620; letter-spacing: 0; }
.mode-note { color: var(--muted); font: 10px/1 var(--mono); }
.mode-grid { display: grid; grid-template-columns: repeat(7, minmax(78px, 1fr)); gap: 6px; margin-bottom: 12px; }
.mode-button { height: 54px; display: flex; align-items: center; justify-content: center; gap: 7px; border: 1px solid var(--line); border-radius: 4px; background: var(--control); color: var(--muted); cursor: pointer; font-size: 11px; }
.mode-button:hover { color: var(--text-strong); border-color: var(--line-strong); }
.mode-button.active { color: var(--green); border-color: #4b725b; background: var(--accent-soft); }
.control-panel { min-height: 203px; padding: 17px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); }
.control-panel.compact { min-height: 92px; padding-block: 14px; }
.control-panel.compact .field-row { margin-top: 0; }
.control-panel.scene { min-height: 0; padding: 14px; }
.drop-zone { height: 94px; border: 1px dashed var(--line-strong); border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--muted); cursor: pointer; }
.drop-zone:hover { border-color: var(--green); color: var(--green); }
.drop-zone strong { margin-top: 8px; max-width: 90%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }
.drop-zone small { margin-top: 4px; color: var(--muted-soft); font-size: 9px; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 15px; }
.field-row.three { grid-template-columns: .8fr 1.2fr 1fr; }
.field { min-width: 0; display: flex; flex-direction: column; gap: 7px; color: var(--muted); font-size: 10px; }
.field > span { display: flex; justify-content: space-between; min-height: 12px; }
.field b { color: #bdc3c1; font: 9px/1 var(--mono); }
select, textarea, input[type="text"] { width: 100%; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--surface-subtle); color: var(--text); outline: 0; font: 11px/1.4 inherit; }
select, input[type="text"] { height: 32px; padding: 0 9px; }
textarea { padding: 9px; resize: none; font: 13px/1.4 "Segoe UI", sans-serif; }
select:focus, textarea:focus, input[type="text"]:focus { border-color: #588069; }
input[type="range"] { width: 100%; height: 3px; accent-color: var(--green); cursor: pointer; }
.switch-stack { display: flex; flex-direction: column; justify-content: end; gap: 10px; padding-bottom: 1px; }
.switch { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; cursor: pointer; }
.switch input { position: absolute; opacity: 0; }
.switch i { width: 26px; height: 14px; border-radius: 7px; background: var(--line-strong); position: relative; transition: .15s; }
.switch i::after { content: ""; position: absolute; width: 10px; height: 10px; left: 2px; top: 2px; border-radius: 50%; background: #777e7b; transition: .15s; }
.switch input:checked + i { background: #315c42; }
.switch input:checked + i::after { left: 14px; background: var(--green); }
.segmented { width: fit-content; display: flex; border: 1px solid var(--line-strong); border-radius: 3px; overflow: hidden; }
.segmented button { width: 38px; height: 30px; border: 0; border-right: 1px solid var(--line-strong); background: var(--surface-subtle); color: #7f8684; display: grid; place-items: center; cursor: pointer; }
.segmented button:last-child { border-right: 0; }
.segmented button.active { color: var(--green); background: var(--accent-soft); }
.text-actions { display: flex; align-items: center; gap: 8px; }
.save-text { height: 32px; padding: 0 10px; border: 1px solid #45634f; border-radius: 3px; background: var(--accent-soft); color: var(--green); display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font-size: 9px; }
.library-section { margin-top: 15px; padding-top: 13px; border-top: 1px solid var(--line); }
.library-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 9px; }
.library-heading > div:first-child { display: flex; align-items: center; gap: 7px; }
.library-heading strong { color: var(--text-soft); font-size: 10px; font-weight: 600; }
.library-heading span { color: var(--muted-soft); font: 8px/1 var(--mono); }
.library-filters { display: flex; align-items: center; gap: 5px; }
.library-filters > button { width: 27px; height: 27px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); color: #747d79; display: grid; place-items: center; cursor: pointer; }
.library-filters > button:hover, .library-filters > button.active { border-color: #4b725b; color: var(--green); }
.library-filters label { width: 180px; height: 27px; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--bg); display: flex; align-items: center; gap: 6px; color: #66706c; }
.library-filters label:focus-within { border-color: #4b725b; color: var(--green); }
.library-filters input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-soft); font-size: 9px; }
.library-filters input::-webkit-search-cancel-button { display: none; }
.library-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 7px; }
.library-card { position: relative; min-width: 0; height: 91px; padding: 5px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--surface-sidebar); color: #8d9692; cursor: pointer; outline: none; }
.library-card:hover, .library-card:focus-visible { border-color: #53605b; color: var(--text-soft); }
.library-card.active { border-color: var(--green); background: var(--accent-soft); box-shadow: inset 0 0 0 1px rgba(102, 231, 153, .12); }
.asset-preview { position: relative; height: 57px; display: grid; place-items: center; overflow: hidden; background: #050606; color: #737c78; }
.asset-preview img { width: 100%; height: 100%; object-fit: contain; image-rendering: pixelated; }
.asset-kind { position: absolute; left: 3px; bottom: 3px; padding: 2px 3px; background: rgba(7, 9, 8, .82); color: #9da5a2; font: 7px/1 var(--mono); }
.asset-name { margin-top: 6px; padding-right: 72px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.theme-card-actions { position: absolute; right: 4px; bottom: 3px; display: flex; gap: 1px; }
.theme-card-actions button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: #6e7773; display: grid; place-items: center; cursor: pointer; }
.theme-card-actions button:hover, .theme-card-actions button.favorite { background: var(--accent-soft); color: var(--green); }
.theme-card-actions button.delete:hover { background: #352321; color: #e19a8c; }
.library-empty { height: 47px; border: 1px dashed var(--line-strong); display: grid; place-items: center; color: #606865; font-size: 9px; text-align: center; }
.text-library { margin-top: 13px; }
.text-presets { grid-template-columns: repeat(auto-fill, minmax(145px, 1fr)); }
.library-card.text-card { height: 66px; padding: 8px; }
.text-sample { height: 30px; padding-right: 22px; overflow: hidden; color: var(--text-soft); font: 12px/1.25 "Segoe UI", "Microsoft YaHei", sans-serif; white-space: pre-wrap; }
.monitor-options { display: flex; gap: 28px; padding: 22px 4px 12px; }
.music-source { padding: 0 0 2px; }
.field input:disabled { opacity: .58; cursor: not-allowed; }
.inline-note { margin-top: 14px; padding-top: 13px; border-top: 1px solid var(--line); color: var(--muted); font-size: 10px; }
.output-strip { min-height: 57px; margin-top: 12px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); display: flex; align-items: center; gap: 10px; color: var(--muted); }
.brightness { width: 225px; display: grid; grid-template-columns: 68px 1fr 30px; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; }
.brightness b { color: var(--text-soft); font: 9px/1 var(--mono); }
.actions { display: flex; margin-left: auto; gap: 7px; }
.actions button { height: 33px; padding: 0 12px; border-radius: 3px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-size: 10px; }
.actions button:disabled { opacity: .42; cursor: not-allowed; }
.secondary { border: 1px solid var(--line-strong); background: var(--control); color: var(--text-soft); }
.primary { border: 1px solid #6de59d; background: var(--green); color: #0d1811; font-weight: 650; }
.danger { border: 1px solid #a86052; background: #3b2521; color: #f2a292; }
@media (max-width: 950px) { .mode-grid { grid-template-columns: repeat(3, 1fr); } .field-row.three { grid-template-columns: 1fr 1fr; } .switch-stack { grid-column: 1 / -1; flex-direction: row; } }
@media (max-width: 680px) { .field-row, .field-row.three { grid-template-columns: 1fr; } .switch-stack { grid-column: auto; } .output-strip { align-items: flex-start; flex-wrap: wrap; } .actions { width: 100%; margin-left: 0; } }
</style>
