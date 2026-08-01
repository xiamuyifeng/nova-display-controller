import "fake-indexeddb/auto";
import JSZip from "jszip";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deleteLibraryItem,
  getLibraryItem,
  listLibraryItems,
  saveAutomationLibraryItem,
  saveMediaLibraryItem,
  saveSceneLibraryItem,
  saveTextLibraryItem,
  setLibraryItemFavorite,
} from "./library";
import { createLibraryBackup, restoreLibraryBackup } from "./libraryBackup";
import { deleteExtension, installExtensionPackage, listExtensions } from "./extensions";
import { migrateScene } from "./scene";
import { assessSceneExtensionDependencies, compareExtensionVersions, createScenePackage, importScenePackage } from "./scenePackage";

function resetLibrary() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("steelseries-oled-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("测试主题库仍被占用"));
  });
}

function resetExtensions() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nova-display-extensions");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("测试扩展库仍被占用"));
  });
}

async function installBackupTestExtension() {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "nova-display-extension",
    apiVersion: 1,
    id: "com.example.backup",
    name: "备份测试扩展",
    version: "1.0.0",
    entry: "main.js",
    capabilities: ["variables"],
    variables: [{ key: "value", label: "数值" }],
    permissions: [],
  }));
  zip.file("main.js", "globalThis.novaExtension = { update() { return { value: 1 }; } };");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await installExtensionPackage(new File([bytes], "backup-test.nova-extension", { type: "application/zip" }));
}

async function installSceneTestExtension() {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "nova-display-extension",
    apiVersion: 1,
    id: "com.example.visualizer",
    name: "测试可视化",
    version: "1.2.0",
    entry: "main.js",
    capabilities: ["variables", "renderer"],
    variables: [{ key: "level", label: "强度" }],
    renderer: { label: "测试图层", settings: [] },
    permissions: [],
  }));
  zip.file("main.js", "globalThis.novaExtension = { update() { return { level: 50 }; }, render() { return []; } };");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  await installExtensionPackage(new File([bytes], "scene-test.nova-extension", { type: "application/zip" }));
}

describe("scene package", () => {
  beforeEach(async () => {
    await resetLibrary();
    await resetExtensions();
  });

  test("compares extension versions and reports dependency states", async () => {
    await installSceneTestExtension();
    const installed = await listExtensions();
    expect(compareExtensionVersions("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareExtensionVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
    expect(assessSceneExtensionDependencies([
      { id: "com.example.visualizer", name: "Visualizer", minimumVersion: "1.3.0", runtime: "quickjs" },
      { id: "com.example.missing", name: "Missing", minimumVersion: "1.0.0", runtime: "provider" },
    ], installed).map(item => item.status)).toEqual(["outdated", "missing"]);
  });

  test("removes layers created by the retired pulse example", () => {
    const scene = migrateScene({
      name: "Legacy scene",
      layers: [
        {
          id: "retired-layer",
          name: "Pulse bars",
          type: "extension",
          extensionId: "dev.nova.pulse",
          x: 0,
          y: 0,
          width: 128,
          height: 64,
          visible: true,
        },
        {
          id: "clock-layer",
          name: "Clock",
          type: "text",
          content: "{time}",
          x: 0,
          y: 0,
          width: 128,
          height: 16,
          visible: true,
        },
      ],
    });

    expect(scene.layers.map(layer => layer.id)).toEqual(["clock-layer"]);
  });

  test("restores referenced media with a new local id", async () => {
    await installSceneTestExtension();
    const sourceBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const sourceAsset = await saveMediaLibraryItem(
      new File([sourceBytes], "test-image.png", { type: "image/png" }),
      { fit: "cover", threshold: 144, dither: true, invert: false },
    );
    const sourceScene = migrateScene({
      name: "带素材场景",
      layers: [{
        id: "image-layer",
        name: "图片",
        type: "image",
        x: 0,
        y: 0,
        width: 128,
        height: 64,
        visible: true,
        assetId: sourceAsset.id,
      }, {
        id: "extension-layer",
        name: "代码图层",
        type: "extension",
        x: 8,
        y: 8,
        width: 40,
        height: 20,
        visible: true,
        condition: "paused",
        extensionId: "com.example.visualizer",
        extensionSettings: { columns: 12, filled: true },
      }, {
        id: "extension-value-bar",
        name: "扩展数值",
        type: "bar",
        x: 8,
        y: 52,
        width: 112,
        height: 8,
        visible: true,
        source: "extension",
        valueVariable: "com.example.visualizer.level",
        value: 25,
      }],
    });

    const exported = await createScenePackage(sourceScene);
    const exportedZip = await JSZip.loadAsync(await exported.blob.arrayBuffer());
    const manifest = JSON.parse(await exportedZip.file("manifest.json")!.async("text"));
    expect(manifest.version).toBe(2);
    expect(manifest.extensions).toEqual([{
      id: "com.example.visualizer",
      name: "测试可视化",
      minimumVersion: "1.2.0",
      runtime: "quickjs",
    }]);
    await deleteLibraryItem(sourceAsset.id);
    await deleteExtension("com.example.visualizer");
    const imported = await importScenePackage(
      new File([exported.blob], exported.fileName, { type: "application/zip" }),
    );
    const importedSceneItem = imported.item;

    const importedAssetId = importedSceneItem.scene?.layers[0]?.assetId;
    expect(importedSceneItem.scene?.name).toBe("带素材场景");
    expect(importedAssetId).toBeTruthy();
    expect(importedAssetId).not.toBe(sourceAsset.id);
    const importedAsset = await getLibraryItem(importedAssetId!);
    expect(importedAsset?.name).toBe("test-image.png");
    expect(importedAsset?.mediaSettings).toEqual({ fit: "cover", threshold: 144, dither: true, invert: false });
    expect(new Uint8Array(await importedAsset!.blob!.arrayBuffer())).toEqual(sourceBytes);
    expect(importedSceneItem.scene?.layers[1].extensionId).toBe("com.example.visualizer");
    expect(importedSceneItem.scene?.layers[1].condition).toBe("paused");
    expect(importedSceneItem.scene?.layers[1].extensionSettings).toEqual({ columns: 12, filled: true });
    expect(importedSceneItem.scene?.layers[2].valueVariable).toBe("com.example.visualizer.level");
    expect(imported.dependencies.map(item => item.status)).toEqual(["missing"]);
  });
});

describe("library backup", () => {
  beforeEach(async () => {
    await resetLibrary();
    await resetExtensions();
  });

  test("restores the complete library and remaps scene and playlist references", async () => {
    const image = await saveMediaLibraryItem(
      new File([new Uint8Array([1, 3, 5, 7])], "panel.png", { type: "image/png" }),
      { fit: "cover", threshold: 160, dither: false, invert: true },
    );
    await setLibraryItemFavorite(image.id, true);
    const text = await saveTextLibraryItem("正在播放", 12, "center");
    const scene = await saveSceneLibraryItem(migrateScene({
      name: "媒体面板",
      layers: [{
        id: "backup-image",
        name: "背景",
        type: "image",
        x: 0,
        y: 0,
        width: 128,
        height: 64,
        visible: true,
        assetId: image.id,
      }],
    }));
    const playlist = await saveAutomationLibraryItem({
      name: "日常轮播",
      entries: [{ id: "scene-entry", mode: "scene", libraryId: scene.id, name: scene.name, duration: 10 }],
      triggers: [{
        id: "music-trigger",
        type: "playing",
        entry: { id: "text-entry", mode: "text", libraryId: text.id, name: text.name, duration: 10 },
      }],
    });
    await installBackupTestExtension();

    const output = await createLibraryBackup({
      autoConnect: false,
      fps: 20,
      pixelShiftEnabled: true,
      staticSleepEnabled: true,
      staticSleepMinutes: 30,
      currentScene: scene.scene!,
      currentSceneLibraryId: scene.id,
      currentAutomationPlanId: playlist.id,
    });
    await resetLibrary();
    await resetExtensions();
    const restored = await restoreLibraryBackup(new File([output.blob], output.fileName, { type: "application/zip" }));
    const items = await listLibraryItems();
    const extensions = await listExtensions();
    const restoredImage = items.find(item => item.kind === "image")!;
    const restoredText = items.find(item => item.kind === "text")!;
    const restoredScene = items.find(item => item.kind === "scene")!;
    const restoredPlaylist = items.find(item => item.kind === "playlist")!;

    expect(items).toHaveLength(4);
    expect(restoredImage.id).not.toBe(image.id);
    expect(restoredImage.favorite).toBe(true);
    expect(restoredImage.mediaSettings).toEqual({ fit: "cover", threshold: 160, dither: false, invert: true });
    expect(restoredScene.scene?.layers[0].assetId).toBe(restoredImage.id);
    expect(restoredPlaylist.playlist?.entries[0].libraryId).toBe(restoredScene.id);
    expect(restoredPlaylist.playlist?.triggers?.[0].entry.libraryId).toBe(restoredText.id);
    expect(restored.preferences.currentScene.layers[0].assetId).toBe(restoredImage.id);
    expect(restored.preferences.currentSceneLibraryId).toBe(restoredScene.id);
    expect(restored.preferences.currentAutomationPlanId).toBe(restoredPlaylist.id);
    expect(restored.preferences.autoConnect).toBe(false);
    expect(restored.preferences.fps).toBe(20);
    expect(restored.preferences.pixelShiftEnabled).toBe(true);
    expect(restored.preferences.staticSleepEnabled).toBe(true);
    expect(restored.preferences.staticSleepMinutes).toBe(30);
    expect(restored.extensionCount).toBe(1);
    expect(extensions[0].id).toBe("com.example.backup");
  });
});
