import { invoke } from "@tauri-apps/api/core";
import type { DetectedDevice, DeviceInfo, DiagnosticSettings, GameSenseStatus, GameSenseTestResult, MediaInfo, StartupStatus, SystemMetrics } from "../types";

export interface ProviderFilePayload {
  path: string;
  bytes: number[];
}

export interface ProviderStatus {
  id: string;
  running: boolean;
  pid: number | null;
  lastError: string;
}

export const inTauri = () => "__TAURI_INTERNALS__" in window;

export const api = {
  devices: () => invoke<DetectedDevice[]>("list_devices"),
  connect: (deviceId?: string) => invoke<DeviceInfo>("connect", { deviceId }),
  disconnect: () => invoke<void>("disconnect"),
  status: () => invoke<DeviceInfo>("get_status"),
  setBrightness: (level: number) => invoke<void>("set_brightness", { level }),
  sendFrame: (frame: number[]) => invoke<void>("send_frame", { frame }),
  stopDisplay: () => invoke<void>("stop_display"),
  metrics: () => invoke<SystemMetrics>("get_system_metrics"),
  media: () => invoke<MediaInfo>("get_media_info"),
  gameSenseStatus: () => invoke<GameSenseStatus>("get_gamesense_status"),
  gameSenseProbe: () => invoke<GameSenseTestResult>("send_gamesense_probe"),
  removeGameSenseProbe: () => invoke<void>("remove_gamesense_probe"),
  startupStatus: () => invoke<StartupStatus>("get_startup_status"),
  setStartup: (enabled: boolean) => invoke<StartupStatus>("set_launch_on_startup", { enabled }),
  applyDeveloperMode: (enabled: boolean) => invoke<void>("apply_developer_mode", { enabled }),
  diagnosticSettings: () => invoke<DiagnosticSettings>("get_diagnostic_settings"),
  setDiagnosticEnabled: (enabled: boolean) => invoke<DiagnosticSettings>("set_diagnostic_enabled", { enabled }),
  setDiagnosticDirectory: (directory: string | null) => invoke<DiagnosticSettings>("set_diagnostic_directory", { directory }),
  writeDiagnosticLog: (level: "info" | "warn" | "error", message: string) => invoke<void>("write_diagnostic_log", { level, message }),
  openLogDirectory: () => invoke<void>("open_log_directory"),
  quit: () => invoke<void>("quit_app"),
  installProvider: (manifest: unknown, files: ProviderFilePayload[]) => invoke<{ id: string; entry: string }>("install_provider_extension", { manifest, files }),
  removeProvider: (id: string) => invoke<void>("remove_provider_extension", { id }),
  stopProvider: (id: string) => invoke<void>("stop_provider_extension", { id }),
  providerStatuses: () => invoke<ProviderStatus[]>("get_provider_statuses"),
  providerLogs: (id: string) => invoke<string[]>("get_provider_logs", { id }),
  tickProvider: (id: string, input: unknown, renderRequests: unknown) => invoke<{ variables?: unknown; renders?: unknown; events?: unknown }>("tick_provider_extension", { id, input, renderRequests }),
};
