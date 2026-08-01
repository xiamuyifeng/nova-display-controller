import { ref } from "vue";

export type AppTheme = "dark" | "light";

const storedTheme = localStorage.getItem("nova-app-theme");
export const appTheme = ref<AppTheme>(storedTheme === "light" ? "light" : "dark");

export function applyTheme(theme = appTheme.value) {
  appTheme.value = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  localStorage.setItem("nova-app-theme", theme);
}

export function setTheme(theme: AppTheme) {
  applyTheme(theme);
}

export function toggleTheme() {
  setTheme(appTheme.value === "dark" ? "light" : "dark");
}

applyTheme();
