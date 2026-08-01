<script setup lang="ts">
import { LogOut, Minimize2, Minus, Moon, Square, Sun, X } from "@lucide/vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { appTheme, toggleTheme } from "../services/appearance";
import { useI18n } from "../services/i18n";
import { api, inTauri } from "../services/tauri";
import { closeBehavior, setCloseBehavior, type CloseBehavior } from "../services/windowBehavior";

const appWindow = inTauri() ? getCurrentWindow() : undefined;
const { t } = useI18n();
const closePromptOpen = ref(false);
const closePrompt = ref<HTMLElement>();
let unlistenClose: (() => void) | undefined;

function minimize() {
  void appWindow?.hide();
}

function toggleMaximize() {
  appWindow?.toggleMaximize();
}

function requestClose() {
  if (closeBehavior.value === "tray") {
    minimize();
  } else if (closeBehavior.value === "exit") {
    void api.quit();
  } else {
    closePromptOpen.value = true;
    void nextTick(() => closePrompt.value?.focus());
  }
}

function chooseCloseBehavior(value: Exclude<CloseBehavior, "ask">) {
  setCloseBehavior(value);
  closePromptOpen.value = false;
  if (value === "tray") minimize();
  else void api.quit();
}

function startDrag() {
  appWindow?.startDragging();
}

onMounted(async () => {
  if (!appWindow) return;
  unlistenClose = await appWindow.onCloseRequested(event => {
    event.preventDefault();
    requestClose();
  });
});

onBeforeUnmount(() => unlistenClose?.());
</script>

<template>
  <header class="titlebar" @mousedown.self="startDrag" @dblclick.self="toggleMaximize">
    <div class="titlebar-brand" @mousedown="startDrag" @dblclick.stop="toggleMaximize">
      <span class="app-icon"><i></i><i></i><i></i></span>
      <span>Nova Display Controller</span>
    </div>
    <div class="window-controls">
      <button class="theme-toggle" :title="t(appTheme === 'dark' ? '切换到日间模式' : '切换到夜间模式')" @click="toggleTheme"><Sun v-if="appTheme === 'dark'" :size="15" /><Moon v-else :size="15" /></button>
      <button :title="t('最小化到系统托盘')" @click="minimize"><Minus :size="15" /></button>
      <button :title="t('最大化')" @click="toggleMaximize"><Square :size="13" /></button>
      <button class="close" :title="t('关闭')" @click="requestClose"><X :size="16" /></button>
    </div>
  </header>
  <Teleport to="body">
    <div v-if="closePromptOpen" class="close-prompt-backdrop" @click.self="closePromptOpen = false">
      <section ref="closePrompt" class="close-prompt" role="dialog" aria-modal="true" :aria-label="t('关闭 Nova Display Controller')" tabindex="-1" @keydown.esc="closePromptOpen = false">
        <button class="prompt-close" :title="t('取消')" @click="closePromptOpen = false"><X :size="15" /></button>
        <span class="prompt-eyebrow">WINDOW BEHAVIOR</span>
        <h2>{{ t("关闭 Nova Display Controller") }}</h2>
        <p>{{ t("请选择点击关闭按钮时的行为。选择会被记住，也可以稍后在设置中修改。") }}</p>
        <div class="close-actions">
          <button class="tray-action" @click="chooseCloseBehavior('tray')"><Minimize2 :size="17" /><span><strong>{{ t("最小化到系统托盘") }}</strong><small>{{ t("继续在后台运行并保持 OLED 输出") }}</small></span></button>
          <button class="exit-action" @click="chooseCloseBehavior('exit')"><LogOut :size="17" /><span><strong>{{ t("退出程序") }}</strong><small>{{ t("停止后台运行，并将基座屏幕交还给 SteelSeries GG") }}</small></span></button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.titlebar {
  height: 34px;
  flex: 0 0 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  color: var(--text-soft);
  user-select: none;
}
.titlebar-brand {
  height: 100%;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding-left: 12px;
  color: var(--text-strong);
  font-size: 12px;
}
.app-icon {
  width: 18px;
  height: 18px;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: 3px;
  background: var(--surface-subtle);
}
.app-icon i { display: block; background: var(--green); }
.window-controls {
  height: 100%;
  display: flex;
}
.window-controls button {
  width: 46px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
}
.window-controls button:hover {
  background: var(--control-hover);
  color: var(--text-strong);
}
.window-controls button.theme-toggle { width: 38px; margin-right: 2px; color: var(--green); }
.window-controls button.close:hover {
  background: #c74343;
  color: #fff;
}
.close-prompt-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, .58);
}
.close-prompt {
  position: relative;
  width: min(410px, 100%);
  padding: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  box-shadow: 0 18px 45px rgba(0, 0, 0, .34);
  color: var(--text);
  outline: none;
}
.prompt-close {
  position: absolute;
  top: 9px;
  right: 9px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.prompt-close:hover { background: var(--control-hover); color: var(--text-strong); }
.prompt-eyebrow { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }
.close-prompt h2 { margin-top: 8px; color: var(--text-strong); font-size: 18px; }
.close-prompt > p { margin-top: 8px; padding-right: 16px; color: var(--muted); font-size: 11px; line-height: 1.55; }
.close-actions { margin-top: 20px; display: grid; gap: 8px; }
.close-actions > button {
  min-height: 58px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 11px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  background: var(--control);
  color: var(--text-soft);
  text-align: left;
  cursor: pointer;
}
.close-actions > button:hover { border-color: var(--green); background: var(--accent-soft); color: var(--green); }
.close-actions span { min-width: 0; display: grid; gap: 4px; }
.close-actions strong { color: var(--text-strong); font-size: 12px; }
.close-actions small { color: var(--muted); font-size: 9px; line-height: 1.35; }
.close-actions .exit-action:hover { border-color: #b55656; background: rgba(181, 86, 86, .1); color: #d36a6a; }
</style>
