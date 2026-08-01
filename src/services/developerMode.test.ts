import { describe, expect, it } from "vitest";
import { isRestrictedWebViewShortcut } from "./developerMode";

function shortcut(key: string, ctrlKey = false, shiftKey = false) {
  return { key, ctrlKey, metaKey: false, shiftKey };
}

describe("WebView shortcut restrictions", () => {
  it("blocks refresh shortcuts", () => {
    expect(isRestrictedWebViewShortcut(shortcut("F5"))).toBe(true);
    expect(isRestrictedWebViewShortcut(shortcut("r", true))).toBe(true);
  });

  it("blocks developer tools shortcuts", () => {
    expect(isRestrictedWebViewShortcut(shortcut("F12"))).toBe(true);
    expect(isRestrictedWebViewShortcut(shortcut("c", true, true))).toBe(true);
    expect(isRestrictedWebViewShortcut(shortcut("I", true, true))).toBe(true);
    expect(isRestrictedWebViewShortcut(shortcut("j", true, true))).toBe(true);
  });

  it("keeps regular application shortcuts available", () => {
    expect(isRestrictedWebViewShortcut(shortcut("r"))).toBe(false);
    expect(isRestrictedWebViewShortcut(shortcut("c", true))).toBe(false);
  });
});
