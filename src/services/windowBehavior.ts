import { ref } from "vue";

export type CloseBehavior = "ask" | "tray" | "exit";

const STORAGE_KEY = "nova-close-behavior";
const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);

export const closeBehavior = ref<CloseBehavior>(stored === "tray" || stored === "exit" ? stored : "ask");

export function setCloseBehavior(value: CloseBehavior) {
  closeBehavior.value = value;
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, value);
}
