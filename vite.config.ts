import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**", "**/dist/**", "**/*.log"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  worker: {
    format: "es",
  },
  build: {
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
