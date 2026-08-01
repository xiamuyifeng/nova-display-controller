<script setup lang="ts">
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getLibraryItem } from "../services/library";
import { releaseExtensionRuntimes, runExtensions, type ExtensionRuntimeInput, type ExtensionRuntimeResult } from "../services/extensions";
import { useI18n } from "../services/i18n";
import { createSceneRuntimeContext, resolveSceneText, sceneLayerVisible, sceneSourceValue } from "../services/scene";
import { drawSceneIcon } from "../services/sceneIcons";
import type { DeviceInfo, DisplayConfig, SceneLayer, SystemMetrics } from "../types";

const props = defineProps<{
  config: DisplayConfig;
  metrics: SystemMetrics;
  device: DeviceInfo;
  live: boolean;
  fps: number;
  active: boolean;
  extensionEventIds?: string[];
  compact?: boolean;
}>();

const emit = defineEmits<{ frame: [frame: number[]]; message: [message: string, error?: boolean] }>();
const { t } = useI18n();
const canvas = ref<HTMLCanvasElement>();
const mediaImage = ref<HTMLImageElement>();
const mediaVideo = ref<HTMLVideoElement>();
const OLED_W = 128;
const OLED_H = 64;
const PIXEL_GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["0", "1", "1", "0", "1", "1", "0"],
  "%": ["11001", "11010", "00100", "01000", "10110", "00110", "00000"],
  "/": ["00001", "00010", "00100", "00100", "01000", "10000", "00000"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
};
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/;
const CJK_FONT = '"SimSun", "NSimSun", "Noto Sans CJK SC", "WenQuanYi Micro Hei", sans-serif';
const LATIN_FONT = '"Segoe UI", "Cascadia Mono", sans-serif';
let timer = 0;
let animationFrame = 0;
let renderContext: CanvasRenderingContext2D | null = null;
let lastFrame: number[] = new Array(1024).fill(0);
let lastSentFrame: number[] | undefined;
let lastSentAt = 0;
let gifFrames: ParsedFrame[] = [];
let gifFrameIndex = 0;
let gifNextFrameAt = 0;
let gifPreviousFrame: ParsedFrame | undefined;
let gifRestoreSnapshot: ImageData | undefined;
let gifLoadToken = 0;
let sceneAssetLoadToken = 0;
let extensionBusy = false;
let lastExtensionRunAt = 0;
let lastExtensionError = "";
let extensionResult: ExtensionRuntimeResult = { variables: {}, pixels: {}, errors: [], errorDetails: [] };
let lastExtensionStatusSignature = "";
type SceneStaticAsset = {
  kind: "image" | "video";
  source: HTMLImageElement | HTMLVideoElement;
  url: string;
};
type SceneGifAsset = {
  kind: "gif";
  source: HTMLCanvasElement;
  url: string;
  context: CanvasRenderingContext2D;
  patchCanvas: HTMLCanvasElement;
  patchContext: CanvasRenderingContext2D;
  frames: ParsedFrame[];
  frameIndex: number;
  nextFrameAt: number;
  previousFrame?: ParsedFrame;
  restoreSnapshot?: ImageData;
};
type SceneAsset = SceneStaticAsset | SceneGifAsset;
const sceneAssets = new Map<string, SceneAsset>();

const gifCanvas = document.createElement("canvas");
const gifContext = gifCanvas.getContext("2d");
const gifPatchCanvas = document.createElement("canvas");
const gifPatchContext = gifPatchCanvas.getContext("2d");

const KEEPALIVE_INTERVAL_MS = 1000;
const MAX_GIF_CANVAS_PIXELS = 4_194_304;
const MAX_GIF_DECODE_PIXELS = 67_108_864;
const ditherValues = new Float32Array(OLED_W * OLED_H);
const gifImageData = new WeakMap<ParsedFrame, ImageData>();
const extensionRequests = computed(() => props.config.mode === "scene"
  ? props.config.scene.layers.flatMap(layer => layer.visible && layer.type === "extension" && layer.extensionId ? [{
    layerId: layer.id,
    extensionId: layer.extensionId,
    width: layer.width,
    height: layer.height,
    settings: layer.extensionSettings ?? {},
  }] : [])
  : []);
const extensionReferences = computed(() => {
  const references = new Set(props.extensionEventIds ?? []);
  if (props.config.mode !== "scene") return [...references];
  for (const layer of props.config.scene.layers) {
    if (!layer.visible) continue;
    if (layer.extensionId) references.add(layer.extensionId);
    if (layer.valueVariable) references.add(layer.valueVariable);
    if (layer.type === "text") {
      for (const match of layer.content.matchAll(/\{([a-z0-9_.-]+)\}/gi)) {
        if (match[1].includes(".")) references.add(match[1]);
      }
    }
  }
  return [...references];
});
const sceneHasClockText = computed(() => props.config.mode === "scene" && props.config.scene.layers.some(layer => layer.visible
  && layer.type === "text" && /\{(?:time|date)\}/i.test(layer.content)));

function validateGifSize(width: number, height: number, frameCount: number, name = "GIF") {
  const canvasPixels = width * height;
  if (!width || !height || canvasPixels > MAX_GIF_CANVAS_PIXELS) {
    throw new Error(`${name} 尺寸过大，最大支持约 2048 x 2048`);
  }
  if (canvasPixels * Math.max(1, frameCount) > MAX_GIF_DECODE_PIXELS) {
    throw new Error(`${name} 帧数或分辨率过高，请缩小素材后重试`);
  }
}

function imageDataForGifFrame(frame: ParsedFrame) {
  let image = gifImageData.get(frame);
  if (!image) {
    image = new ImageData(frame.patch, frame.dims.width, frame.dims.height);
    gifImageData.set(frame, image);
  }
  return image;
}

function startRenderTimer() {
  window.clearInterval(timer);
  timer = 0;
  syncMediaPlayback();
  queueRender();
  if ((!props.active || document.hidden) && !props.live) return;
  const fastFrames = (props.config.mode === "media" && (props.config.mediaKind === "gif" || props.config.mediaKind === "video"))
    || (props.config.mode === "scene" && props.config.scene.layers.some(layer => layer.visible && (layer.type === "media" || layer.type === "extension")));
  const dynamicPreview = props.live || props.config.mode === "clock"
    || Boolean(props.extensionEventIds?.length)
    || (props.config.mode === "scene" && (sceneHasClockText.value || extensionReferences.value.length > 0));
  if (!fastFrames && !dynamicPreview) return;
  const interval = fastFrames ? 1000 / Math.max(1, Math.min(30, props.fps)) : KEEPALIVE_INTERVAL_MS;
  timer = window.setInterval(render, interval);
}

function queueRender() {
  if ((!props.active || document.hidden) && !props.live) return;
  if (animationFrame) return;
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0;
    render();
  });
}

function resetGif() {
  gifFrames = [];
  gifFrameIndex = 0;
  gifNextFrameAt = 0;
  gifPreviousFrame = undefined;
  gifRestoreSnapshot = undefined;
  gifContext?.clearRect(0, 0, gifCanvas.width, gifCanvas.height);
}

function releaseSceneAsset(id: string) {
  const cached = sceneAssets.get(id);
  if (!cached) return;
  if (cached.source instanceof HTMLVideoElement) {
    cached.source.pause();
    cached.source.removeAttribute("src");
    cached.source.load();
  }
  URL.revokeObjectURL(cached.url);
  sceneAssets.delete(id);
}

function syncMediaPlayback() {
  const playbackAllowed = props.live || (props.active && !document.hidden);
  const primaryVideo = mediaVideo.value;
  if (primaryVideo) {
    if (playbackAllowed && props.config.mode === "media" && props.config.mediaKind === "video") {
      primaryVideo.play().catch(() => undefined);
    } else {
      primaryVideo.pause();
    }
  }

  const activeSceneVideos = props.config.mode === "scene"
    ? new Set(props.config.scene.layers.flatMap(layer => layer.visible && layer.type === "media" && layer.assetId ? [layer.assetId] : []))
    : new Set<string>();
  for (const [id, asset] of sceneAssets) {
    if (asset.kind !== "video") continue;
    if (playbackAllowed && activeSceneVideos.has(id)) asset.source.play().catch(() => undefined);
    else asset.source.pause();
  }
}

async function syncSceneAssets(assetIds: string[]) {
  const token = ++sceneAssetLoadToken;
  const wanted = new Set(assetIds.filter(Boolean));
  [...sceneAssets.keys()].forEach(id => {
    if (!wanted.has(id)) releaseSceneAsset(id);
  });
  try {
    await Promise.all([...wanted].filter(id => !sceneAssets.has(id)).map(async id => {
      const item = await getLibraryItem(id);
      if (!item?.blob || (item.kind !== "image" && item.kind !== "gif" && item.kind !== "video")) return;
      const url = URL.createObjectURL(item.blob);
      let asset: SceneAsset;
      if (item.kind === "video") {
        const video = document.createElement("video");
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        await new Promise<void>((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error(`无法读取场景视频：${item.name}`));
          video.src = url;
          video.load();
        });
        asset = { kind: "video", source: video, url };
      } else if (item.kind === "gif") {
        const parsed = parseGIF(await item.blob.arrayBuffer());
        validateGifSize(parsed.lsd.width, parsed.lsd.height, parsed.frames.length, `场景 GIF“${item.name}”`);
        const frames = decompressFrames(parsed, true);
        if (!frames.length) throw new Error(`场景 GIF 中没有可播放的画面：${item.name}`);
        const canvas = document.createElement("canvas");
        canvas.width = parsed.lsd.width;
        canvas.height = parsed.lsd.height;
        const context = canvas.getContext("2d");
        const patchCanvas = document.createElement("canvas");
        const patchContext = patchCanvas.getContext("2d");
        if (!context || !patchContext) throw new Error(`无法创建场景 GIF 画布：${item.name}`);
        asset = {
          kind: "gif",
          source: canvas,
          url,
          context,
          patchCanvas,
          patchContext,
          frames,
          frameIndex: 0,
          nextFrameAt: 0,
        };
      } else {
        const image = new Image();
        image.decoding = "async";
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error(`无法读取场景图片：${item.name}`));
          image.src = url;
        });
        asset = { kind: "image", source: image, url };
      }
      if (token !== sceneAssetLoadToken || !wanted.has(id)) {
        if (asset.source instanceof HTMLVideoElement) asset.source.pause();
        URL.revokeObjectURL(url);
        return;
      }
      sceneAssets.set(id, asset);
    }));
    if (token === sceneAssetLoadToken) {
      syncMediaPlayback();
      queueRender();
    }
  } catch (error) {
    if (token === sceneAssetLoadToken) emit("message", error instanceof Error ? error.message : String(error), true);
  }
}

function advanceSceneGif(asset: SceneGifAsset, now: number) {
  if (asset.nextFrameAt === 0) asset.nextFrameAt = now;
  let advanced = 0;
  while (now >= asset.nextFrameAt && advanced < asset.frames.length) {
    if (asset.previousFrame) {
      const { dims, disposalType } = asset.previousFrame;
      if (disposalType === 2) asset.context.clearRect(dims.left, dims.top, dims.width, dims.height);
      else if (disposalType === 3 && asset.restoreSnapshot) asset.context.putImageData(asset.restoreSnapshot, 0, 0);
    }
    const frame = asset.frames[asset.frameIndex];
    asset.restoreSnapshot = frame.disposalType === 3
      ? asset.context.getImageData(0, 0, asset.source.width, asset.source.height)
      : undefined;
    const { width, height, left, top } = frame.dims;
    if (asset.patchCanvas.width !== width || asset.patchCanvas.height !== height) {
      asset.patchCanvas.width = width;
      asset.patchCanvas.height = height;
    }
    asset.patchContext.putImageData(imageDataForGifFrame(frame), 0, 0);
    asset.context.drawImage(asset.patchCanvas, left, top);
    asset.previousFrame = frame;
    asset.frameIndex = (asset.frameIndex + 1) % asset.frames.length;
    asset.nextFrameAt += Math.max(20, frame.delay || 100);
    advanced += 1;
  }
}

async function loadGif(url: string) {
  const token = ++gifLoadToken;
  resetGif();
  if (!url) return;
  try {
    const buffer = await fetch(url).then(response => response.arrayBuffer());
    const parsed = parseGIF(buffer);
    validateGifSize(parsed.lsd.width, parsed.lsd.height, parsed.frames.length);
    const frames = decompressFrames(parsed, true);
    if (token !== gifLoadToken) return;
    if (!frames.length) throw new Error("GIF 中没有可播放的画面");
    gifCanvas.width = parsed.lsd.width;
    gifCanvas.height = parsed.lsd.height;
    gifFrames = frames;
    gifFrameIndex = 0;
    gifNextFrameAt = 0;
  } catch (error) {
    if (token === gifLoadToken) emit("message", t("GIF 解码失败：{error}", { error: error instanceof Error ? error.message : String(error) }), true);
  }
}

function applyPreviousGifDisposal() {
  if (!gifContext || !gifPreviousFrame) return;
  const { dims, disposalType } = gifPreviousFrame;
  if (disposalType === 2) gifContext.clearRect(dims.left, dims.top, dims.width, dims.height);
  else if (disposalType === 3 && gifRestoreSnapshot) gifContext.putImageData(gifRestoreSnapshot, 0, 0);
}

function drawGifFrame(frame: ParsedFrame) {
  if (!gifContext || !gifPatchContext) return;
  applyPreviousGifDisposal();
  gifRestoreSnapshot = frame.disposalType === 3
    ? gifContext.getImageData(0, 0, gifCanvas.width, gifCanvas.height)
    : undefined;
  const { width, height, left, top } = frame.dims;
  if (gifPatchCanvas.width !== width || gifPatchCanvas.height !== height) {
    gifPatchCanvas.width = width;
    gifPatchCanvas.height = height;
  }
  gifPatchContext.putImageData(imageDataForGifFrame(frame), 0, 0);
  gifContext.drawImage(gifPatchCanvas, left, top);
  gifPreviousFrame = frame;
}

function advanceGif(now: number) {
  if (!gifFrames.length) return;
  if (gifNextFrameAt === 0) gifNextFrameAt = now;
  let advanced = 0;
  while (now >= gifNextFrameAt && advanced < gifFrames.length) {
    const frame = gifFrames[gifFrameIndex];
    drawGifFrame(frame);
    gifFrameIndex = (gifFrameIndex + 1) % gifFrames.length;
    gifNextFrameAt += Math.max(20, frame.delay || 100);
    advanced += 1;
  }
}

function pixelTextWidth(text: string, pixelSize: number, gap: number) {
  return [...text].reduce((width, char, index) => {
    const glyph = PIXEL_GLYPHS[char];
    return width + (glyph?.[0].length ?? 0) * pixelSize + (index ? gap : 0);
  }, 0);
}

function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  top: number,
  pixelSize: number,
  gap: number,
) {
  let cursor = Math.round(centerX - pixelTextWidth(text, pixelSize, gap) / 2);
  for (const char of text) {
    const glyph = PIXEL_GLYPHS[char];
    if (!glyph) continue;
    glyph.forEach((row, y) => {
      [...row].forEach((value, x) => {
        if (value === "1") ctx.fillRect(cursor + x * pixelSize, top + y * pixelSize, pixelSize, pixelSize);
      });
    });
    cursor += glyph[0].length * pixelSize + gap;
  }
}

function drawClockText(
  ctx: CanvasRenderingContext2D,
  groups: string[],
  centerX: number,
  top: number,
  pixelSize: number,
) {
  const digitGap = pixelSize === 3 ? 2 : 3;
  const colonGap = pixelSize === 3 ? 4 : pixelSize === 4 ? 6 : 5;
  const groupWidths = groups.map(group => pixelTextWidth(group, pixelSize, digitGap));
  const colonWidth = pixelSize;
  const totalWidth = groupWidths.reduce((sum, width) => sum + width, 0)
    + Math.max(0, groups.length - 1) * (colonWidth + colonGap * 2);
  let cursor = Math.round(centerX - totalWidth / 2);

  groups.forEach((group, groupIndex) => {
    for (const [digitIndex, digit] of [...group].entries()) {
      const glyph = PIXEL_GLYPHS[digit];
      if (!glyph) continue;
      glyph.forEach((row, y) => {
        [...row].forEach((value, x) => {
          if (value === "1") ctx.fillRect(cursor + x * pixelSize, top + y * pixelSize, pixelSize, pixelSize);
        });
      });
      cursor += glyph[0].length * pixelSize;
      if (digitIndex < group.length - 1) cursor += digitGap;
    }

    if (groupIndex >= groups.length - 1) return;
    cursor += colonGap;
    const colon = PIXEL_GLYPHS[":"];
    colon.forEach((row, y) => {
      if (row === "1") ctx.fillRect(cursor, top + y * pixelSize, pixelSize, pixelSize);
    });
    cursor += colonWidth + colonGap;
  });
}

function fitRect(width: number, height: number) {
  if (props.config.fit === "stretch") return { x: 0, y: 0, width: OLED_W, height: OLED_H };
  const scale = props.config.fit === "cover"
    ? Math.max(OLED_W / width, OLED_H / height)
    : Math.min(OLED_W / width, OLED_H / height);
  const targetWidth = width * scale;
  const targetHeight = height * scale;
  return {
    x: (OLED_W - targetWidth) / 2,
    y: (OLED_H - targetHeight) / 2,
    width: targetWidth,
    height: targetHeight,
  };
}

function drawMedia(ctx: CanvasRenderingContext2D) {
  if (props.config.mediaKind === "gif" && gifFrames.length) {
    advanceGif(performance.now());
    const rect = fitRect(gifCanvas.width, gifCanvas.height);
    ctx.drawImage(gifCanvas, rect.x, rect.y, rect.width, rect.height);
    return true;
  }
  const source = props.config.mediaKind === "video" ? mediaVideo.value : mediaImage.value;
  if (!source) return false;
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
  if (!width || !height) return false;
  const rect = fitRect(width, height);
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
  return true;
}

function truncate(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (ctx.measureText(value).width <= maxWidth) return value;
  let result = value;
  while (result.length && ctx.measureText(`${result}...`).width > maxWidth) result = result.slice(0, -1);
  return `${result}...`;
}

function setOledFont(ctx: CanvasRenderingContext2D, value: string, size: number, weight = 400) {
  const cjk = CJK_PATTERN.test(value);
  ctx.font = `${cjk ? 400 : weight} ${size}px ${cjk ? CJK_FONT : LATIN_FONT}`;
}

function wrapText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    const tokens = CJK_PATTERN.test(paragraph)
      ? [...paragraph]
      : paragraph.split(/(\s+)/).filter(Boolean);
    let line = "";
    for (const token of tokens) {
      const next = line ? `${line}${token}` : token.trimStart();
      if (ctx.measureText(next).width > maxWidth && line.trim()) {
        lines.push(line.trimEnd());
        line = token.trimStart();
      } else {
        line = next;
      }
    }
    if (line.trim()) lines.push(line.trimEnd());
  }
  return lines;
}

function drawScene(ctx: CanvasRenderingContext2D) {
  const runtime = createSceneRuntimeContext(props.config, props.metrics, props.device, new Date(), extensionResult.variables);
  for (const layer of props.config.scene.layers) {
    if (!sceneLayerVisible(layer, runtime) || layer.width <= 0 || layer.height <= 0) continue;
    const x = Math.round(layer.x);
    const y = Math.round(layer.y);
    const width = Math.round(layer.width);
    const height = Math.round(layer.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";

    if (layer.type === "text") {
      if (layer.content.trim() === "{time}") {
        const groups = resolveSceneText(layer.content, runtime).split(":");
        const pixelSize = Math.max(1, Math.min(3, Math.floor(layer.fontSize / 7)));
        drawClockText(ctx, groups, x + width / 2, y, pixelSize);
      } else {
        const text = resolveSceneText(layer.content, runtime);
        setOledFont(ctx, text, layer.fontSize, layer.weight);
        ctx.textBaseline = "top";
        ctx.textAlign = layer.align;
        const textX = layer.align === "left" ? x : layer.align === "right" ? x + width : x + width / 2;
        ctx.fillText(truncate(ctx, text, width), textX, y);
      }
    } else if (layer.type === "bar") {
      const inset = Math.min(2, Math.floor(Math.min(width, height) / 3));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
      const innerWidth = Math.max(0, width - inset * 2);
      const innerHeight = Math.max(1, height - inset * 2);
      ctx.fillRect(x + inset, y + inset, Math.round(innerWidth * sceneSourceValue(layer, runtime) / 100), innerHeight);
    } else if (layer.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.max(0.5, (width - 1) / 2), Math.max(0.5, (height - 1) / 2), 0, 0, Math.PI * 2);
      if (layer.filled) ctx.fill();
      else ctx.stroke();
    } else if (layer.type === "pixels") {
      for (const index of layer.pixels ?? []) {
        if (index >= 0 && index < OLED_W * OLED_H) ctx.fillRect(index % OLED_W, Math.floor(index / OLED_W), 1, 1);
      }
    } else if (layer.type === "image" || layer.type === "media") {
      const asset = layer.assetId ? sceneAssets.get(layer.assetId) : undefined;
      if (asset?.kind === "gif") advanceSceneGif(asset, performance.now());
      if (asset) {
        ctx.filter = layer.invert ? "invert(1)" : "none";
        ctx.drawImage(asset.source, x, y, width, height);
        ctx.filter = "none";
      }
    } else if (layer.type === "icon" && layer.icon) {
      drawSceneIcon(ctx, layer.icon, x, y, width, height, {
        value: sceneSourceValue(layer, runtime),
        playing: runtime.flags.playing,
        connected: runtime.flags.headsetConnected,
      });
    } else if (layer.type === "extension") {
      const pixels = extensionResult.pixels[layer.id] ?? [];
      if (layer.invert) {
        ctx.fillStyle = "#fff";
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = "#000";
      }
      for (const index of pixels) {
        const pixelX = index % width;
        const pixelY = Math.floor(index / width);
        if (pixelY < height) ctx.fillRect(x + pixelX, y + pixelY, 1, 1);
      }
    } else if (layer.type === "rect") {
      if (layer.filled) ctx.fillRect(x, y, width, height);
      else ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    }
    ctx.restore();
  }
}

function extensionInput(): ExtensionRuntimeInput {
  return {
    timeMs: Date.now(),
    cpu: props.metrics.cpu,
    memory: props.metrics.memory,
    battery: props.device.batteryAvailable ? props.device.battery : null,
    spareBattery: props.device.spareBatteryAvailable ? props.device.spareBattery : null,
    volume: props.device.volume,
    track: props.config.track,
    artist: props.config.artist,
    progress: props.config.progress,
    playing: props.config.playing,
    headsetConnected: props.device.headsetConnected,
  };
}

function updateExtensions(force = false) {
  if (extensionBusy || extensionReferences.value.length === 0) return;
  const now = performance.now();
  if (!force && now - lastExtensionRunAt < 100) return;
  lastExtensionRunAt = now;
  extensionBusy = true;
  void runExtensions(extensionInput(), extensionRequests.value, extensionReferences.value).then(result => {
    extensionResult = result;
    const status = { variableKeys: Object.keys(result.variables).sort(), errors: result.errorDetails };
    const signature = JSON.stringify(status);
    if (signature !== lastExtensionStatusSignature) {
      lastExtensionStatusSignature = signature;
      window.dispatchEvent(new CustomEvent("nova-extension-runtime-status", { detail: status }));
    }
    const error = result.errors.join("；");
      if (error && error !== lastExtensionError) emit("message", t("扩展运行失败：{error}", { error }), true);
    lastExtensionError = error;
  }).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    const status = { variableKeys: [] as string[], errors: [{ extensionId: "", message }] };
    const signature = JSON.stringify(status);
    if (signature !== lastExtensionStatusSignature) {
      lastExtensionStatusSignature = signature;
      window.dispatchEvent(new CustomEvent("nova-extension-runtime-status", { detail: status }));
    }
      if (message !== lastExtensionError) emit("message", t("扩展运行失败：{error}", { error: message }), true);
    lastExtensionError = message;
  }).finally(() => {
    extensionBusy = false;
    if (!extensionReferences.value.length) void releaseExtensionRuntimes();
  });
}

function drawSource(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, OLED_W, OLED_H);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";

  if (props.config.mode === "scene") {
    drawScene(ctx);
    return;
  }

  if ((props.config.mode === "image" || props.config.mode === "media") && drawMedia(ctx)) return;

  if (props.config.mode === "text") {
    const hasCjk = CJK_PATTERN.test(props.config.text);
    setOledFont(ctx, props.config.text, props.config.fontSize, hasCjk ? 400 : 700);
    ctx.textBaseline = "middle";
    ctx.textAlign = props.config.align;
    const x = props.config.align === "center" ? OLED_W / 2 : 4;
    const lines = wrapText(ctx, props.config.text, OLED_W - 8);
    const visible = lines.slice(0, 3);
    const lineHeight = props.config.fontSize + 2;
    const startY = OLED_H / 2 - ((visible.length - 1) * lineHeight) / 2;
    visible.forEach((value, index) => ctx.fillText(truncate(ctx, value, 120), x, startY + index * lineHeight));
    return;
  }

  if (props.config.mode === "clock") {
    const now = new Date();
    const hour12 = props.config.clockFormat === "12h";
    const withSeconds = props.config.clockFormat === "24h-seconds";
    const period = hour12 ? (now.getHours() >= 12 ? "PM" : "AM") : "";
    const hour = hour12 ? now.getHours() % 12 || 12 : now.getHours();
    const parts = [hour, now.getMinutes(), ...(withSeconds ? [now.getSeconds()] : [])];
    const timeGroups = parts.map(value => value.toString().padStart(2, "0"));
    const pixelSize = withSeconds ? 3 : props.config.showDate ? 4 : 5;
    const timeTop = props.config.showDate ? (withSeconds ? 7 : 5) : withSeconds ? 22 : 14;
    drawClockText(ctx, timeGroups, OLED_W / 2, timeTop, pixelSize);
    if (props.config.showDate) {
      const month = (now.getMonth() + 1).toString().padStart(2, "0");
      const day = now.getDate().toString().padStart(2, "0");
      const date = `${month}/${day}  ${WEEKDAYS[now.getDay()]}`;
      drawPixelText(ctx, period ? `${period}  ${date}` : date, OLED_W / 2, 46, 1, 1);
    } else if (period) {
      drawPixelText(ctx, period, 117, 56, 1, 1);
    }
    return;
  }

  if (props.config.mode === "system") {
    const visibleRows = Number(props.config.showCpu) + Number(props.config.showMemory);
    const rowStride = 28;
    const rowHeight = 19;
    const blockHeight = visibleRows > 0 ? rowHeight + (visibleRows - 1) * rowStride : 0;
    const startTop = Math.round((OLED_H - blockHeight) / 2);
    let row = 0;
    const drawBar = (label: string, value: number) => {
      const top = startTop + row * rowStride;
      const percentage = `${Math.round(Math.max(0, Math.min(100, value)))}%`;
      const labelWidth = pixelTextWidth(label, 1, 1);
      const percentageWidth = pixelTextWidth(percentage, 1, 1);
      drawPixelText(ctx, label, 3 + labelWidth / 2, top, 1, 1);
      drawPixelText(ctx, percentage, 125 - percentageWidth / 2, top, 1, 1);
      ctx.strokeRect(3.5, top + 10.5, 121, 8);
      ctx.fillRect(6, top + 13, Math.max(0, Math.min(116, value * 1.16)), 3);
      row += 1;
    };
    if (props.config.showCpu) drawBar("CPU", props.metrics.cpu);
    if (props.config.showMemory) drawBar("RAM", props.metrics.memory);
    return;
  }

  if (props.config.mode === "music") {
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const track = props.config.track || "No media";
    const artist = props.config.artist || "Unknown artist";
    setOledFont(ctx, track, CJK_PATTERN.test(track) ? 12 : 13, 600);
    ctx.fillText(truncate(ctx, track, 120), 4, 16);
    setOledFont(ctx, artist, CJK_PATTERN.test(artist) ? 12 : 10);
    ctx.fillText(truncate(ctx, artist, 120), 4, 34);

    // Playback state icon and a compact progress track share the final OLED row.
    if (props.config.playing) {
      ctx.beginPath();
      ctx.moveTo(5, 49);
      ctx.lineTo(5, 59);
      ctx.lineTo(13, 54);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillRect(5, 49, 3, 10);
      ctx.fillRect(11, 49, 3, 10);
    }
    ctx.strokeRect(19.5, 50.5, 104, 7);
    ctx.fillRect(22, 53, Math.round(99 * Math.max(0, Math.min(100, props.config.progress)) / 100), 2);
    return;
  }

  drawPixelText(ctx, "SELECT A", OLED_W / 2, 15, 2, 2);
  drawPixelText(ctx, "SOURCE", OLED_W / 2, 35, 2, 2);
}

function monochrome(ctx: CanvasRenderingContext2D) {
  const image = ctx.getImageData(0, 0, OLED_W, OLED_H);
  const dither = props.config.dither && (props.config.mode === "image" || props.config.mode === "media");
  const threshold = props.config.mode === "text"
    ? CJK_PATTERN.test(props.config.text) ? 188 : 160
    : props.config.mode === "music" || props.config.mode === "scene" ? 176 : props.config.threshold;
  lastFrame.fill(0);

  if (dither) {
    for (let i = 0; i < ditherValues.length; i++) {
      const p = i * 4;
      ditherValues[i] = image.data[p] * 0.299 + image.data[p + 1] * 0.587 + image.data[p + 2] * 0.114;
    }
    for (let y = 0; y < OLED_H; y++) {
      for (let x = 0; x < OLED_W; x++) {
        const i = y * OLED_W + x;
        const old = ditherValues[i];
        const next = old >= threshold ? 255 : 0;
        ditherValues[i] = next;
        const error = old - next;
        if (x + 1 < OLED_W) ditherValues[i + 1] += error * 7 / 16;
        if (y + 1 < OLED_H) {
          if (x > 0) ditherValues[i + OLED_W - 1] += error * 3 / 16;
          ditherValues[i + OLED_W] += error * 5 / 16;
          if (x + 1 < OLED_W) ditherValues[i + OLED_W + 1] += error / 16;
        }
      }
    }
  }

  for (let y = 0; y < OLED_H; y++) {
    for (let x = 0; x < OLED_W; x++) {
      const index = y * OLED_W + x;
      const p = index * 4;
      const luminance = dither
        ? ditherValues[index]
        : image.data[p] * 0.299 + image.data[p + 1] * 0.587 + image.data[p + 2] * 0.114;
      const on = luminance >= threshold !== props.config.invert;
      const value = on ? 255 : 0;
      image.data[p] = value;
      image.data[p + 1] = value;
      image.data[p + 2] = value;
      image.data[p + 3] = 255;
      if (on) lastFrame[x * 8 + Math.floor(y / 8)] |= 1 << (y % 8);
    }
  }
  ctx.putImageData(image, 0, 0);
}

function render() {
  const ctx = renderContext ?? canvas.value?.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  renderContext = ctx;
  updateExtensions();
  drawSource(ctx);
  monochrome(ctx);
  if (props.live) {
    const now = performance.now();
    const changed = !lastSentFrame || lastFrame.some((value, index) => value !== lastSentFrame?.[index]);
    if (changed || now - lastSentAt >= KEEPALIVE_INTERVAL_MS) {
      lastSentFrame = [...lastFrame];
      lastSentAt = now;
      emit("frame", lastSentFrame);
    }
  } else {
    lastSentFrame = undefined;
    lastSentAt = 0;
  }
}

function getFrame() {
  render();
  return [...lastFrame];
}

function playVideo() {
  syncMediaPlayback();
  queueRender();
}

function handleVisibilityChange() {
  startRenderTimer();
}

defineExpose({ getFrame });

onMounted(() => {
  window.addEventListener("nova-extensions-changed", handleExtensionsChanged);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  startRenderTimer();
});
function handleExtensionsChanged() {
  lastExtensionRunAt = 0;
  if (props.active || props.live) updateExtensions(true);
  queueRender();
}
watch(
  () => [
    props.fps,
    props.live,
    props.active,
    props.config.mode,
    props.config.mediaKind,
    sceneHasClockText.value,
    extensionReferences.value.join("|"),
    props.config.scene.layers.map(layer => `${layer.visible}:${layer.type}`).join("|"),
  ] as const,
  startRenderTimer,
);
watch(extensionReferences, references => {
  if (!references.length) void releaseExtensionRuntimes();
});
watch(() => props.config, queueRender, { deep: true });
watch(() => props.metrics, queueRender, { deep: true });
watch(() => props.device, queueRender, { deep: true });
watch(
  () => [props.config.mode, props.config.mediaUrl, props.config.mediaKind] as const,
  ([mode, url, kind]) => {
    if (mode === "media" && kind === "gif") loadGif(url);
    else {
      ++gifLoadToken;
      resetGif();
    }
  },
  { immediate: true },
);
watch(
  () => `${props.config.mode}|${props.config.scene.layers.map(layer => layer.type === "image" || layer.type === "media" ? `${layer.type}:${layer.assetId ?? ""}` : "").join("|")}`,
  () => void syncSceneAssets(props.config.mode === "scene"
    ? props.config.scene.layers.flatMap(layer => (layer.type === "image" || layer.type === "media") && layer.assetId ? [layer.assetId] : [])
    : []),
  { immediate: true },
);
onBeforeUnmount(() => {
  window.removeEventListener("nova-extensions-changed", handleExtensionsChanged);
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  ++gifLoadToken;
  ++sceneAssetLoadToken;
  [...sceneAssets.keys()].forEach(releaseSceneAsset);
  window.clearInterval(timer);
  window.cancelAnimationFrame(animationFrame);
  void releaseExtensionRuntimes();
  renderContext = null;
});
</script>

<template>
  <div :class="['preview-shell', { compact }]">
    <div class="screen-bezel">
      <canvas ref="canvas" :width="OLED_W" :height="OLED_H" />
      <span class="screen-brand">STEELSERIES</span>
    </div>
    <div class="preview-meta">
      <span>128 x 64 MONO</span>
      <span :class="['live-state', { active: live }]">{{ live ? "LIVE" : "PREVIEW" }}</span>
    </div>
    <img
      v-if="(config.mode === 'image' || config.mode === 'media') && config.mediaUrl && config.mediaKind !== 'video'"
      ref="mediaImage"
      class="media-source"
      :src="config.mediaUrl"
      alt=""
      @load="render"
    />
    <video
      v-if="config.mode === 'media' && config.mediaUrl && config.mediaKind === 'video'"
      ref="mediaVideo"
      class="media-source"
      :src="config.mediaUrl"
      muted
      loop
      playsinline
      @loadeddata="playVideo"
    />
  </div>
</template>

<style scoped>
.preview-shell { width: 100%; max-width: 540px; margin: 0 auto; }
.preview-shell.compact { max-width: 350px; }
.screen-bezel {
  position: relative; padding: 23px 24px 31px; border: 1px solid #454a4c; border-radius: 6px;
  background: linear-gradient(145deg, #272b2c, #111314); box-shadow: 0 18px 40px rgba(0, 0, 0, .32), inset 0 1px rgba(255,255,255,.08);
}
.compact .screen-bezel { padding: 12px 14px 20px; box-shadow: 0 8px 22px rgba(0, 0, 0, .3), inset 0 1px rgba(255,255,255,.08); }
.compact .screen-brand { bottom: 5px; font-size: 5px; }
.compact .preview-meta { margin-top: 5px; font-size: 8px; }
canvas {
  display: block; width: 100%; aspect-ratio: 2 / 1; background: #000; image-rendering: pixelated;
  border: 1px solid #353a35; box-shadow: inset 0 0 18px rgba(153, 255, 194, .08), 0 0 14px rgba(113, 255, 170, .05);
}
.screen-brand { position: absolute; left: 50%; bottom: 9px; transform: translateX(-50%); color: #717676; font-size: 7px; letter-spacing: 2px; }
.preview-meta { display: flex; justify-content: space-between; margin-top: 9px; color: var(--muted); font: 600 10px/1 var(--mono); }
.live-state { color: #8c9290; }
.live-state.active { color: var(--green); }
.media-source { position: fixed; left: -10px; top: -10px; width: 1px; height: 1px; opacity: .01; pointer-events: none; }
</style>
