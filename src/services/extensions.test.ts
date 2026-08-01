import "fake-indexeddb/auto";
import JSZip from "jszip";
import { beforeEach, describe, expect, test } from "vitest";
import { detectExtensionPlatform, inspectExtensionPackage, installExtensionPackage, listExtensions, plainExtensionSettings } from "./extensions";

function resetExtensions() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nova-display-extensions");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("测试扩展库仍被占用"));
  });
}

async function extensionFile(overrides: Record<string, unknown> = {}) {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({
    format: "nova-display-extension",
    apiVersion: 1,
    id: "com.example.meter",
    name: "测试仪表",
    version: "1.0.0",
    author: "Tester",
    description: "Extension package test",
    entry: "main.js",
    capabilities: ["variables", "renderer"],
    variables: [{ key: "score", label: "分数" }],
    renderer: { label: "测试图层", settings: [{ key: "level", label: "等级", type: "range", default: 5, min: 1, max: 10 }] },
    permissions: [],
    ...overrides,
  }));
  zip.file("main.js", "globalThis.novaExtension = { update() { return { score: 1 }; }, render() { return [0]; } };");
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new File([bytes], "test.nova-extension", { type: "application/zip" });
}

describe("extension packages", () => {
  test("detects browser and Node platforms without assuming macOS", () => {
    expect(detectExtensionPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "")).toBe("windows");
    expect(detectExtensionPlatform("", "win32")).toBe("windows");
    expect(detectExtensionPlatform("Mozilla/5.0 (X11; Linux x86_64)", "")).toBe("linux");
    expect(detectExtensionPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X)", "")).toBe("macos");
    expect(() => detectExtensionPlatform("", "")).toThrow("无法识别当前平台");
  });

  beforeEach(resetExtensions);

  test("installs a validated extension package", async () => {
    const result = await installExtensionPackage(await extensionFile());
    const installed = await listExtensions();
    expect(result.updated).toBe(false);
    expect(installed).toHaveLength(1);
    expect(installed[0].manifest.renderer?.settings[0].default).toBe(5);
    expect(installed[0].manifest.runtime).toBe("quickjs");
    expect(installed[0].source).toContain("novaExtension");
  });

  test("purges the retired pulse extension from existing libraries", async () => {
    await installExtensionPackage(await extensionFile({
      id: "dev.nova.pulse",
      name: "Retired pulse example",
    }));

    expect(await listExtensions()).toEqual([]);
  });

  test("rejects undeclared host permissions in API v1", async () => {
    await expect(installExtensionPackage(await extensionFile({ permissions: ["network"] }))).rejects.toThrow("不开放系统权限");
    expect(await listExtensions()).toHaveLength(0);
  });

  test("converts reactive-style settings into a cloneable plain object", () => {
    const settings = new Proxy({ columns: 12, filled: true }, {});
    const plain = plainExtensionSettings(settings);
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype);
    expect(plain).toEqual({ columns: 12, filled: true });
  });

  test("recognizes Provider v2 and requires explicit native approval", async () => {
    const file = await extensionFile({
      apiVersion: 2,
      runtime: "provider",
      entry: { windows: "provider.exe", linux: "provider" },
      protocol: "nova-jsonl-v1",
      capabilities: ["variables", "renderer", "events"],
      events: [{ key: "sample_ready", label: "采样完成" }],
      permissions: ["native.process"],
    });
    const manifest = await inspectExtensionPackage(file);
    expect(manifest.runtime).toBe("provider");
    expect(manifest.events).toEqual([{ key: "sample_ready", label: "采样完成" }]);
    await expect(installExtensionPackage(file)).rejects.toThrow("必须确认完全系统访问权限");
    expect(await listExtensions()).toHaveLength(0);
  });
});
