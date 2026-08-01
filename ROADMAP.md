# Nova Display Controller Roadmap

## Product direction

Build a reusable 128 x 64 OLED scene and automation platform for SteelSeries headset base stations. Clock, system monitoring, and music views remain available as presets, but the primary workflow is user-designed scenes rather than fixed display modes.

## Product principles

- Prefer useful presets and clear controls over maximum customization.
- Keep fixed display modes as the easiest entry point; the scene editor is an optional enhancement.
- Show common settings directly and avoid professional design-tool concepts unless they solve a frequent problem.
- Use simple trigger choices rather than nested rules or visual programming.
- Treat plugins, scripting, complex timelines, and advanced multi-selection as optional long-term work, not core requirements.

## 1. Scene foundation and visual editor

- Versioned scene schema with automatic migration of saved scenes.
- Text, time, date, metrics, progress bars, shapes, images, GIF, video, a small built-in icon set, and pixel layers.
- Move, resize, precise coordinates, snapping, alignment guides, layer order, visibility, locking, duplication, undo, and redo.
- Shared runtime variable context for editor preview and OLED output.
- Convert fixed clock, system, and music modes into editable built-in templates.

## 2. Dynamic bindings and conditions

- Variables for time, date, CPU, memory, headset battery, spare battery, volume, track, artist, playback state, and progress.
- Bind built-in values and extension-provided numeric variables to progress bars. Additional icon bindings remain optional.
- Per-layer playback and headset-connection visibility conditions are implemented, together with numeric fallback values.
- Network transfer speed and normalized activity are implemented as an independent Provider. Other local data sources remain extension territory.

## 3. Automation and triggers

- Keep the existing timed scene playlist.
- Music playback and configurable low-battery whole-scene triggers are implemented.
- Keep trigger behavior simple: a default playlist plus exceptional whole-scene replacements.
- Do not add custom volume, time, process, or game triggers; they either duplicate GG behavior or are outside the selected product scope.

## 4. Portable scene packages

- Import and export versioned `.nova-oled` packages containing scene JSON and referenced image, GIF, and video assets. Package v2 also records extension ID, minimum version, and runtime while retaining v1 import support.
- Validate package format, version, asset count, compressed size, and uncompressed asset size before import. Implemented.
- Diagnose missing, outdated, disabled, failed, or data-waiting extensions without installing or executing code from the scene package. Implemented.
- Add custom font packaging after the editor supports user-provided fonts.
- Keep scenes independent from device communication profiles so they can be reused on future base stations.

## 5. Library reliability and portability

- Unified search, favorites, duplication, and deletion for image, GIF, video, and text themes. Implemented.
- Automatic USB reconnect after unplug, communication loss, or system wake, with live-display and automation restoration. Implemented.
- Full `.nova-backup` export and merge restore for the complete local library and common preferences. Implemented.
- Automated round-trip tests for scene packages and full-library reference restoration. Implemented.

## 6. Extensible local data providers

- The `.nova-extension` v1 QuickJS sandbox remains available for lightweight variables and pixel renderers without system access.
- Provider API v2 is implemented for independent native processes, with JSONL communication, explicit installation approval, timeouts, crash isolation, logs, variables, renderers, and events.
- Provider extensions can implement GPU, network, microphone, game telemetry, or other local data without a matching hard-coded feature in the main application.
- Provider processes never receive the main application's HID handle; all OLED composition and device output remain owned by the host.
- The bundled `dev.nova.system-network` Provider supplies download/upload KB/s and a progress-bar-friendly activity value without adding a fixed network display mode.

## 7. Audio visualization

- The bundled `dev.nova.system-audio` Provider uses Windows WASAPI loopback for real default-output audio capture.
- RMS strength, configurable spectrum bars, and audio started/stopped events are implemented.
- Audio capture remains optional and requires the same explicit native Provider approval as third-party executables.

## 8. Optional display protection

- Optional one-pixel burn-in shifting and unchanged-frame sleep controls are implemented in Settings.
- Both remain off by default, with a clear note that SteelSeries GG already provides similar behavior.

## 9. Desktop usability

- Simplified Chinese and English interfaces are implemented, including runtime messages and confirmations.
- Light and dark themes are implemented with persistent preferences and a title-bar shortcut.
- Core pages have responsive wrapping and denser spacing so preview and controls remain usable in smaller desktop windows.

## Excluded scope

- Screen-region mapping, time-based switching, and process/game switching.
- A separate GG coexistence mode or custom volume overlay; the current direct-HID timing already allows GG's native screens to appear temporarily.
- Built-in game telemetry, HTTP/WebSocket screens, and a complex animation timeline remain outside the core application. Independent Provider extensions may implement those data sources without expanding the main UI.

## Current milestone

Scene Editor 5, portable scene packages with extension dependency diagnostics, simple layer conditions, library backup/restore, automatic USB recovery, Provider API v2, real system-audio visualization, network metrics, extension events and numeric progress-bar bindings, author tooling, and optional display protection are complete. Further local metrics should be delivered as independently installable Providers rather than new fixed display modes.
