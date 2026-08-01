import { createApp } from "vue";
import App from "./App.vue";
import "./services/appearance";
import "./services/i18n";
import { installWebViewGuards } from "./services/developerMode";
import { api, inTauri } from "./services/tauri";

installWebViewGuards();

function errorText(error: unknown) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function showStartupError(error: unknown) {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root || root.childElementCount > 0) return;
  const detail = document.createElement("pre");
  detail.style.cssText = "max-width:720px;padding:24px;white-space:pre-wrap;color:#e8aaa0;font:12px/1.6 Consolas,monospace";
  detail.textContent = `界面启动失败\n\n${errorText(error)}\n\n请关闭窗口后重新运行 npm run tauri dev，并检查终端中的错误信息。`;
  root.replaceChildren(detail);
}

function recordFrontendError(source: string, error: unknown) {
  if (!inTauri()) return;
  void api
    .writeDiagnosticLog("error", `${source}: ${errorText(error)}`)
    .catch(logError => console.error("Failed to write diagnostic log", logError));
}

window.addEventListener("error", event => {
  const error = event.error || event.message;
  recordFrontendError("window.error", error);
  showStartupError(error);
});
window.addEventListener("unhandledrejection", event => {
  recordFrontendError("window.unhandledrejection", event.reason);
  showStartupError(event.reason);
});

try {
  const app = createApp(App);
  app.config.errorHandler = error => {
    console.error(error);
    recordFrontendError("vue.errorHandler", error);
    showStartupError(error);
  };
  app.mount("#app");
} catch (error) {
  console.error(error);
  recordFrontendError("startup", error);
  showStartupError(error);
}
