import { describe, expect, test } from "vitest";
import { formatTranslation } from "./i18n";

describe("interface translations", () => {
  test("returns the selected English translation", () => {
    expect(formatTranslation("设置", "en-US")).toBe("Settings");
  });

  test("interpolates values in translated messages", () => {
    expect(formatTranslation("检测到 {count} 个耳机基座", "en-US", { count: 2 }))
      .toBe("Detected 2 headset base station(s)");
  });

  test("preserves unknown user or extension text", () => {
    expect(formatTranslation("My Custom Scene", "en-US")).toBe("My Custom Scene");
  });

  test("keeps Chinese source text in Chinese mode", () => {
    expect(formatTranslation("已连接 {name}", "zh-CN", { name: "Nova Pro" }))
      .toBe("已连接 Nova Pro");
  });
});
