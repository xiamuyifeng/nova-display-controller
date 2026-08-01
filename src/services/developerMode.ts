import { ref } from "vue";
import { api, inTauri } from "./tauri";

const STORAGE_KEY = "nova-developer-mode";

const storedValue = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
export const developerMode = ref(storedValue === "true");

export async function setDeveloperMode(enabled: boolean) {
  const previous = developerMode.value;
  developerMode.value = enabled;
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, String(enabled));
  try {
    if (inTauri()) await api.applyDeveloperMode(enabled);
  } catch (error) {
    developerMode.value = previous;
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, String(previous));
    throw error;
  }
}

export function isRestrictedWebViewShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey">) {
  const key = event.key.toLowerCase();
  if (key === "f5" || key === "f12") return true;
  if (!(event.ctrlKey || event.metaKey)) return false;
  if (key === "r") return true;
  return event.shiftKey && (key === "c" || key === "i" || key === "j");
}

export function installWebViewGuards() {
  document.addEventListener("contextmenu", event => {
    if (!developerMode.value) event.preventDefault();
  });
  window.addEventListener("keydown", event => {
    if (!developerMode.value && isRestrictedWebViewShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });
}
