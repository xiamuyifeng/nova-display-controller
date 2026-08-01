<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import type { SceneLayer } from "../types";

const props = defineProps<{
  layer: SceneLayer;
  editable: boolean;
}>();

const emit = defineEmits<{ select: [] }>();
const canvas = ref<HTMLCanvasElement>();
let drawing = false;
let lastPoint: { x: number; y: number } | undefined;
let pixelSet = new Set<number>();

function render() {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, 128, 64);
  context.fillStyle = "#fff";
  for (const index of props.layer.pixels ?? []) {
    context.fillRect(index % 128, Math.floor(index / 128), 1, 1);
  }
}

function point(event: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: Math.max(0, Math.min(127, Math.floor((event.clientX - rect.left) * 128 / rect.width))),
    y: Math.max(0, Math.min(63, Math.floor((event.clientY - rect.top) * 64 / rect.height))),
  };
}

function applyPoint(x: number, y: number) {
  const index = y * 128 + x;
  if (props.layer.pixelTool === "erase") pixelSet.delete(index);
  else pixelSet.add(index);
}

function drawLine(from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
  for (let step = 0; step <= steps; step++) {
    applyPoint(
      Math.round(from.x + (to.x - from.x) * step / steps),
      Math.round(from.y + (to.y - from.y) * step / steps),
    );
  }
  props.layer.pixels = [...pixelSet].sort((a, b) => a - b);
  render();
}

function start(event: PointerEvent) {
  if (!props.editable) return;
  emit("select");
  drawing = true;
  pixelSet = new Set(props.layer.pixels ?? []);
  lastPoint = point(event);
  drawLine(lastPoint, lastPoint);
  canvas.value?.setPointerCapture(event.pointerId);
}

function move(event: PointerEvent) {
  if (!drawing || !lastPoint) return;
  const next = point(event);
  drawLine(lastPoint, next);
  lastPoint = next;
}

function stop() {
  drawing = false;
  lastPoint = undefined;
}

onMounted(render);
watch(() => props.layer.pixels, render, { deep: true });
</script>

<template>
  <canvas
    ref="canvas"
    :class="['pixel-canvas', { editable }]"
    width="128"
    height="64"
    @pointerdown.stop.prevent="start"
    @pointermove.stop.prevent="move"
    @pointerup.stop="stop"
    @pointercancel.stop="stop"
  />
</template>

<style scoped>
.pixel-canvas { position: absolute; inset: 0; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
.pixel-canvas.editable { pointer-events: auto; cursor: crosshair; touch-action: none; outline: 1px solid var(--green); outline-offset: -1px; }
</style>
