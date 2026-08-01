<script setup lang="ts">
import { Activity, ListVideo, MonitorUp, Settings } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "../services/i18n";

defineProps<{ current: string; automationRunning?: boolean }>();
defineEmits<{ "update:current": [value: "editor" | "automation" | "status" | "settings"] }>();

const { t } = useI18n();
const items = computed(() => [
  { id: "editor" as const, icon: MonitorUp, label: t("屏幕工作台") },
  { id: "automation" as const, icon: ListVideo, label: t("场景编排") },
  { id: "status" as const, icon: Activity, label: t("设备状态") },
  { id: "settings" as const, icon: Settings, label: t("设置") },
]);
</script>

<template>
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark"><i></i><i></i><i></i></span>
      <div><strong>NOVA DISPLAY</strong><small>BASE STATION CONTROL</small></div>
    </div>
    <nav>
      <button
        v-for="item in items"
        :key="item.id"
        :class="{ active: current === item.id }"
        @click="$emit('update:current', item.id)"
      >
        <component :is="item.icon" :size="17" :stroke-width="1.8" />
        <span>{{ item.label }}</span>
        <i v-if="item.id === 'automation' && automationRunning" class="running-dot" :title="t('编排正在运行')"></i>
      </button>
    </nav>
    <div class="sidebar-foot">
      <span class="version">DESKTOP / 0.1.0</span>
      <span>Windows + Linux</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar { width: 188px; flex: 0 0 188px; border-right: 1px solid var(--line); background: var(--surface-sidebar); padding: 18px 10px 14px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 11px; padding: 3px 8px 25px; }
.brand-mark { width: 29px; height: 29px; border: 1px solid #525957; display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; padding: 6px; }
.brand-mark i { display: block; background: var(--green); }
.brand strong { display: block; font-size: 11px; letter-spacing: 1.2px; color: var(--text-strong); }
.brand small { display: block; margin-top: 3px; font: 8px/1 var(--mono); color: var(--muted); letter-spacing: .4px; }
nav { display: flex; flex-direction: column; gap: 3px; }
button { width: 100%; height: 39px; display: flex; align-items: center; gap: 10px; padding: 0 10px; border: 0; border-radius: 4px; background: transparent; color: var(--muted); cursor: pointer; font-size: 13px; text-align: left; }
button:hover { background: var(--control-hover); color: var(--text-strong); }
button.active { background: var(--control); color: var(--text-strong); box-shadow: inset 2px 0 var(--green); }
.running-dot { width: 6px; height: 6px; margin-left: auto; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px rgba(102, 231, 153, .55); }
.sidebar-foot { margin-top: auto; padding: 12px 8px 0; border-top: 1px solid var(--line); display: grid; gap: 5px; color: #616866; font: 9px/1.2 var(--mono); }
.version { color: var(--muted); }
</style>
