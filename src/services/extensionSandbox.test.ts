import { describe, expect, test } from "vitest";
import { executeExtensionSource } from "./extensionSandbox";

describe("extension sandbox", () => {
  test("returns variables and pixels without exposing host browser APIs", async () => {
    const result = await executeExtensionSource(`
      globalThis.novaExtension = {
        update(input) { return { value: input.cpu, network: typeof fetch }; },
        render(context, settings) { return [0, context.width - 1, settings.pixel]; },
      };
    `, { cpu: 42 }, [{ id: "layer", width: 8, height: 4, settings: { pixel: 9 } }]) as {
      variables: Record<string, unknown>;
      renders: Array<{ id: string; pixels: number[] }>;
    };

    expect(result.variables).toEqual({ value: 42, network: "undefined" });
    expect(result.renders).toEqual([{ id: "layer", pixels: [0, 7, 9] }]);
  });

  test("interrupts extensions that exceed the execution deadline", async () => {
    await expect(executeExtensionSource(`
      globalThis.novaExtension = { update() { while (true) {} } };
    `, {}, [])).rejects.toThrow();
  });
});
