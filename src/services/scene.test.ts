import { describe, expect, test } from "vitest";
import { migrateSceneLayer, sceneLayerVisible, sceneSourceValue, type SceneRuntimeContext } from "./scene";

const runtime: SceneRuntimeContext = {
  text: { "com.example.metrics.load": "72.5" },
  values: {
    cpu: 10,
    memory: 20,
    progress: 30,
    battery: 40,
    spareBattery: 50,
    volume: 60,
    custom: 0,
  },
  flags: { playing: false, headsetConnected: true },
};

function extensionBar(variable = "com.example.metrics.load") {
  return migrateSceneLayer({
    id: "extension-bar",
    name: "Extension value",
    type: "bar",
    x: 0,
    y: 0,
    width: 100,
    height: 8,
    visible: true,
    source: "extension",
    valueVariable: variable,
    value: 35,
  })!;
}

describe("scene numeric bindings", () => {
  test("uses a numeric extension variable for progress layers", () => {
    const layer = extensionBar();
    expect(layer.valueVariable).toBe("com.example.metrics.load");
    expect(sceneSourceValue(layer, runtime)).toBe(72.5);
  });

  test("uses the configured fallback for missing or non-numeric values", () => {
    expect(sceneSourceValue(extensionBar("com.example.metrics.missing"), runtime)).toBe(35);
    expect(sceneSourceValue(extensionBar(), {
      ...runtime,
      text: { "com.example.metrics.load": "not-a-number" },
    })).toBe(35);
  });

  test("clamps extension values to the OLED percentage range", () => {
    expect(sceneSourceValue(extensionBar(), {
      ...runtime,
      text: { "com.example.metrics.load": "140" },
    })).toBe(100);
  });
});

describe("scene layer visibility", () => {
  test.each([
    ["always", true],
    ["playing", false],
    ["paused", true],
    ["headsetConnected", true],
    ["headsetDisconnected", false],
  ] as const)("evaluates %s", (condition, expected) => {
    const layer = { ...extensionBar(), condition };
    expect(sceneLayerVisible(layer, runtime)).toBe(expected);
  });

  test("migrates old layers to always visible", () => {
    expect(extensionBar().condition).toBe("always");
  });

  test("manual visibility still takes precedence", () => {
    const layer = { ...extensionBar(), visible: false, condition: "always" as const };
    expect(sceneLayerVisible(layer, runtime)).toBe(false);
  });
});
