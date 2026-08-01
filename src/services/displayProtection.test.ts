import { describe, expect, test } from "vitest";
import { DisplayProtectionController, shiftMonoFrame } from "./displayProtection";

const blank = () => new Array(1024).fill(0);

function pixelFrame(x: number, y: number) {
  const frame = blank();
  frame[x * 8 + Math.floor(y / 8)] |= 1 << (y % 8);
  return frame;
}

describe("OLED display protection", () => {
  test("shifts column-major monochrome pixels and clips the edges", () => {
    expect(shiftMonoFrame(pixelFrame(4, 5), 1, -1)).toEqual(pixelFrame(5, 4));
    expect(shiftMonoFrame(pixelFrame(127, 63), 1, 1)).toEqual(blank());
  });

  test("sleeps only after the source frame remains unchanged", () => {
    const controller = new DisplayProtectionController();
    const first = pixelFrame(10, 10);
    const changed = pixelFrame(11, 10);
    controller.reset(1000);

    expect(controller.process(first, { pixelShift: false, staticSleep: true, sleepAfterMs: 5000 }, 1000).sleeping).toBe(false);
    expect(controller.process(first, { pixelShift: false, staticSleep: true, sleepAfterMs: 5000 }, 6000).sleeping).toBe(true);
    expect(controller.process(changed, { pixelShift: false, staticSleep: true, sleepAfterMs: 5000 }, 7000).sleeping).toBe(false);
  });

  test("cycles through subtle pixel-shift positions", () => {
    const controller = new DisplayProtectionController();
    controller.reset(1000);
    const result = controller.process(pixelFrame(2, 2), {
      pixelShift: true,
      staticSleep: false,
      sleepAfterMs: 5000,
      shiftEveryMs: 1000,
    }, 2000);

    expect(result.offset).toEqual({ x: 1, y: 0 });
    expect(result.frame).toEqual(pixelFrame(3, 2));
  });
});
