<script setup lang="ts">
import { computed } from "vue";
import { createSceneRuntimeContext, resolveSceneText, sceneLayerVisible, sceneSourceValue } from "../services/scene";
import type { DeviceInfo, DisplayConfig, SceneConfig, SceneLayer, SystemMetrics } from "../types";
import PixelLayerCanvas from "./PixelLayerCanvas.vue";
import SceneIconCanvas from "./SceneIconCanvas.vue";

const props = defineProps<{
  scene: SceneConfig;
  config: DisplayConfig;
  metrics: SystemMetrics;
  device: DeviceInfo;
  assetUrls: Record<string, string>;
  assetKinds: Record<string, string>;
}>();

const runtime = computed(() => createSceneRuntimeContext(props.config, props.metrics, props.device));

function layerStyle(layer: SceneLayer) {
  return {
    left: `${layer.x}px`,
    top: `${layer.y}px`,
    width: `${layer.width}px`,
    height: `${layer.height}px`,
    fontSize: `${layer.fontSize}px`,
    fontWeight: String(layer.weight),
    justifyContent: layer.align === "left" ? "flex-start" : layer.align === "right" ? "flex-end" : "center",
  };
}
</script>

<template>
  <div class="scene-thumbnail" aria-hidden="true">
    <div
      v-for="layer in scene.layers"
      v-show="sceneLayerVisible(layer, runtime)"
      :key="layer.id"
      :class="['thumbnail-layer', layer.type, { filled: layer.filled }]"
      :style="layerStyle(layer)"
    >
      <span v-if="layer.type === 'text'">{{ resolveSceneText(layer.content, runtime) }}</span>
      <i v-else-if="layer.type === 'bar'" :style="{ width: `${sceneSourceValue(layer, runtime)}%` }"></i>
      <img v-else-if="layer.type === 'image' && layer.assetId" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" alt="" />
      <img v-else-if="layer.type === 'media' && layer.assetId && assetKinds[layer.assetId] === 'gif'" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" alt="" />
      <video v-else-if="layer.type === 'media' && layer.assetId && assetKinds[layer.assetId] === 'video'" :src="assetUrls[layer.assetId]" :style="{ filter: layer.invert ? 'invert(1)' : 'none' }" muted preload="metadata" playsinline />
      <SceneIconCanvas
        v-else-if="layer.type === 'icon' && layer.icon"
        :icon="layer.icon"
        :value="sceneSourceValue(layer, runtime)"
        :playing="config.playing"
        :connected="device.headsetConnected"
      />
      <PixelLayerCanvas v-else-if="layer.type === 'pixels'" :layer="layer" :editable="false" />
      <span v-else-if="layer.type === 'extension'" class="extension-layer">EXT</span>
    </div>
  </div>
</template>

<style scoped>
.scene-thumbnail { position: relative; flex: 0 0 128px; width: 128px; height: 64px; overflow: hidden; background: #000; color: #fff; image-rendering: pixelated; }
.thumbnail-layer { position: absolute; overflow: hidden; color: #fff; line-height: 1; }
.thumbnail-layer.text { display: flex; align-items: flex-start; white-space: nowrap; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
.thumbnail-layer.text > span { overflow: hidden; text-overflow: clip; }
.thumbnail-layer.bar { padding: 1px; border: 1px solid #fff; display: flex; align-items: stretch; }
.thumbnail-layer.bar > i { display: block; height: 100%; background: #fff; }
.thumbnail-layer.rect { border: 1px solid #fff; }
.thumbnail-layer.rect.filled { background: #fff; }
.thumbnail-layer.ellipse { border: 1px solid #fff; border-radius: 50%; }
.thumbnail-layer.ellipse.filled { background: #fff; }
.thumbnail-layer img, .thumbnail-layer video { display: block; width: 100%; height: 100%; object-fit: fill; image-rendering: pixelated; }
.thumbnail-layer.extension { display: grid; place-items: center; border: 1px dashed #fff; }.extension-layer { font: 7px/1 var(--mono); }
</style>
