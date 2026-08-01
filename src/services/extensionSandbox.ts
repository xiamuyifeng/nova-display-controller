import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export interface SandboxRenderRequest {
  id: string;
  width: number;
  height: number;
  settings: Record<string, unknown>;
}

const quickJsPromise = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);

export async function executeExtensionSource(
  sourceCode: string,
  input: Record<string, unknown>,
  renderRequests: SandboxRenderRequest[],
) {
  const QuickJS = await quickJsPromise;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const context = runtime.newContext();
  try {
    const source = `
      "use strict";
      const input = ${JSON.stringify(input)};
      const renderRequests = ${JSON.stringify(renderRequests)};
      ${sourceCode}
      (() => {
        const extension = globalThis.novaExtension;
        if (!extension || typeof extension !== "object") throw new Error("扩展必须定义 globalThis.novaExtension");
        const variables = typeof extension.update === "function" ? extension.update(input) : {};
        const renders = renderRequests.map(request => ({
          id: request.id,
          pixels: typeof extension.render === "function"
            ? extension.render({ ...input, width: request.width, height: request.height }, request.settings)
            : [],
        }));
        return JSON.stringify({ variables: variables ?? {}, renders });
      })();
    `;
    const deadline = performance.now() + 50;
    runtime.setInterruptHandler(() => performance.now() > deadline);
    const evaluation = context.evalCode(source, "extension.js");
    if (evaluation.error) {
      const detail = context.dump(evaluation.error) as { message?: string } | string;
      evaluation.error.dispose();
      throw new Error(typeof detail === "string" ? detail : detail?.message || "扩展执行失败");
    }
    const serialized = context.dump(evaluation.value);
    evaluation.value.dispose();
    if (typeof serialized !== "string") throw new Error("扩展返回值无法序列化");
    return JSON.parse(serialized) as unknown;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
