<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { drawSceneIcon } from "../services/sceneIcons";
import type { SceneIconName } from "../types";

const props = defineProps<{
  icon: SceneIconName;
  value: number;
  playing: boolean;
  connected: boolean;
}>();

const canvas = ref<HTMLCanvasElement>();

function render() {
  const context = canvas.value?.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, 64, 64);
  drawSceneIcon(context, props.icon, 0, 0, 64, 64, {
    value: props.value,
    playing: props.playing,
    connected: props.connected,
  });
}

onMounted(render);
watch(() => [props.icon, props.value, props.playing, props.connected], render);
</script>

<template><canvas ref="canvas" width="64" height="64" /></template>

<style scoped>
canvas { display: block; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
</style>
