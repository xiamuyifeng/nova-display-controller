<script setup lang="ts">
import { Battery, Headphones, Link, RefreshCw, Unplug, Volume2 } from "@lucide/vue";
import { useI18n } from "../services/i18n";
import type { DeviceInfo } from "../types";

defineProps<{ device: DeviceInfo; busy: boolean }>();
defineEmits<{ connect: []; disconnect: []; refresh: [] }>();
const { t } = useI18n();
</script>

<template>
  <header class="device-bar">
    <div class="identity">
      <span :class="['dot', { online: device.connected }]"></span>
      <div>
        <strong>{{ device.connected ? device.product : t("基座未连接") }}</strong>
        <small>{{ device.connected ? `USB HID / PID 0x${device.productId.toString(16).toUpperCase().padStart(4, "0")} / Interface ${device.interfaceNumber}` : t("连接设备后即可发送画面") }}</small>
      </div>
    </div>
    <div class="telemetry">
      <span :title="t(device.headsetConnected ? '耳机已连接' : '耳机未连接')">
        <Headphones :size="15" /> {{ device.headsetConnected ? "ONLINE" : "OFFLINE" }}
      </span>
      <span :title="t('耳机电池')">
        <Battery :size="15" /> H {{ device.batteryAvailable ? `${device.battery}%` : "--" }}
      </span>
      <span :title="t('基座仓备用电池')">
        <Battery :size="15" /> S {{ device.spareBatteryAvailable ? `${device.spareBattery}%` : "--" }}
      </span>
      <span :title="t('主音量')"><Volume2 :size="15" /> {{ device.volume }}%</span>
    </div>
    <button v-if="device.connected" class="icon-button" :title="t('刷新状态')" :disabled="busy" @click="$emit('refresh')">
      <RefreshCw :size="16" :class="{ spin: busy }" />
    </button>
    <button v-if="device.connected" class="icon-button" :title="t('断开设备')" :disabled="busy" @click="$emit('disconnect')"><Unplug :size="16" /></button>
    <button v-else class="connect-button" :disabled="busy" @click="$emit('connect')"><Link :size="15" />{{ t(busy ? "正在连接" : "连接基座") }}</button>
  </header>
</template>

<style scoped>
.device-bar { min-height: 60px; flex: 0 0 60px; padding: 0 18px; display: flex; align-items: center; gap: 9px; border-bottom: 1px solid var(--line); background: var(--surface); }
.identity { display: flex; align-items: center; gap: 10px; min-width: 245px; margin-right: auto; }
.dot { width: 7px; height: 7px; background: #6c7371; box-shadow: 0 0 0 4px rgba(108,115,113,.08); }
.dot.online { background: var(--green); box-shadow: 0 0 0 4px rgba(102,231,153,.09); }
.identity strong { display: block; color: var(--text-strong); font-size: 12px; font-weight: 600; }
.identity small { display: block; margin-top: 3px; color: var(--muted); font: 9px/1 var(--mono); }
.telemetry { display: flex; height: 30px; border: 1px solid var(--line); border-radius: 4px; }
.telemetry span { min-width: 76px; padding: 0 8px; display: flex; align-items: center; justify-content: center; gap: 5px; color: var(--muted); font: 10px/1 var(--mono); border-right: 1px solid var(--line); }
.telemetry span:last-child { border-right: 0; }
.icon-button, .connect-button { height: 30px; border: 1px solid var(--line-strong); border-radius: 4px; background: var(--control); color: var(--text-soft); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.icon-button { width: 32px; }
.connect-button { padding: 0 12px; gap: 7px; font-size: 11px; }
button:hover:not(:disabled) { border-color: var(--green); color: var(--green); }
button:disabled { opacity: .55; cursor: wait; }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 1050px) {
  .device-bar { padding: 0 12px; gap: 7px; }
  .identity { min-width: 125px; }
  .identity strong { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .identity small { display: none; }
  .telemetry span { min-width: 62px; padding: 0 6px; }
  .telemetry span:first-child { display: none; }
  .connect-button { padding: 0 9px; }
}
</style>
