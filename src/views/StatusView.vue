<script setup lang="ts">
import { Battery, Headphones, Radio, Volume2 } from "@lucide/vue";
import { useI18n } from "../services/i18n";
import type { DeviceInfo, SystemMetrics } from "../types";

defineProps<{ device: DeviceInfo; metrics: SystemMetrics }>();
const { t } = useI18n();
</script>

<template>
  <section class="status-view">
    <div class="page-title"><span>DEVICE</span><h2>{{ t("设备状态") }}</h2><p>{{ device.connected ? device.product : t("基座尚未连接") }}</p></div>
    <div class="stat-grid">
      <article><Headphones :size="19" /><span>{{ t("耳机连接") }}</span><strong>{{ t(device.headsetConnected ? "已连接" : "未连接") }}</strong></article>
      <article><Battery :size="19" /><span>{{ t("耳机电池") }}</span><strong>{{ device.batteryAvailable ? `${device.battery}%` : "--" }}</strong><i><b :style="{ width: device.batteryAvailable ? `${device.battery}%` : '0%' }"></b></i></article>
      <article><Battery :size="19" /><span>{{ t("备用电池") }}</span><strong>{{ device.spareBatteryAvailable ? `${device.spareBattery}%` : "--" }}</strong><i><b :style="{ width: device.spareBatteryAvailable ? `${device.spareBattery}%` : '0%' }"></b></i></article>
      <article><Volume2 :size="19" /><span>{{ t("主音量") }}</span><strong>{{ device.volume }}%</strong><i><b :style="{ width: `${device.volume}%` }"></b></i></article>
      <article><Radio :size="19" /><span>Game / Chat</span><strong>{{ device.gameVolume }} / {{ device.chatVolume }}</strong></article>
    </div>
    <div v-if="device.connected" class="detail-band">
      <div><span>USB VID / PID</span><b>0x1038 / 0x{{ device.productId.toString(16).toUpperCase().padStart(4, "0") }}</b></div>
      <div><span>HID INTERFACE</span><b>{{ device.interfaceNumber }}</b></div>
      <div><span>OLED REPORT</span><b>0x{{ device.oledReportId.toString(16).toUpperCase().padStart(2, "0") }} / 0x93</b></div>
      <div><span>RESOLUTION</span><b>{{ device.width }} x {{ device.height }} / 1 BPP</b></div>
    </div>
    <div class="system-section">
      <div class="page-title compact"><span>HOST</span><h2>{{ t("主机负载") }}</h2></div>
      <div class="meter"><label><span>CPU</span><b>{{ metrics.cpu.toFixed(1) }}%</b></label><i><b :style="{ width: `${metrics.cpu}%` }"></b></i></div>
      <div class="meter"><label><span>{{ t("内存") }}</span><b>{{ metrics.memory.toFixed(1) }}% / {{ metrics.usedMemoryGb.toFixed(1) }} GB</b></label><i><b :style="{ width: `${metrics.memory}%` }"></b></i></div>
    </div>
  </section>
</template>

<style scoped>
.status-view { max-width: 900px; margin: 0 auto; }
.page-title span { color: var(--green); font: 9px/1 var(--mono); letter-spacing: 1.4px; }.page-title h2 { margin-top: 5px; color: var(--text-strong); font-size: 19px; }.page-title p { margin-top: 5px; color: var(--muted); font-size: 10px; }
.stat-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 22px; }
article { min-height: 118px; padding: 14px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface-raised); display: flex; flex-direction: column; color: var(--muted); }
article > span { margin-top: 16px; color: var(--muted); font-size: 10px; } article > strong { margin-top: 5px; color: var(--text-strong); font: 600 18px/1 var(--mono); }
article > i, .meter > i { height: 3px; margin-top: auto; background: #2b302f; overflow: hidden; } article > i b, .meter > i b { display: block; height: 100%; background: var(--green); }
.detail-band { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 10px; border: 1px solid var(--line); border-radius: 5px; }
.detail-band div { padding: 14px; border-right: 1px solid var(--line); }.detail-band div:last-child { border: 0; }.detail-band span,.detail-band b { display: block; }.detail-band span { color: var(--muted-soft); font: 8px/1 var(--mono); }.detail-band b { margin-top: 7px; color: #b8bebc; font: 10px/1 var(--mono); }
.system-section { margin-top: 31px; }.compact { margin-bottom: 16px; }.meter { margin: 13px 0; }.meter label { display: flex; justify-content: space-between; color: #8c9391; font-size: 10px; }.meter label b { font: 9px/1 var(--mono); color: #b9bfbd; }.meter > i { display: block; height: 5px; margin-top: 7px; }
@media(max-width:1000px){.stat-grid{grid-template-columns:repeat(2,1fr)}.detail-band{grid-template-columns:repeat(2,1fr)}}
</style>
