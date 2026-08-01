# Nova Display Controller

English | [简体中文](./README.md)

Nova Display Controller is a desktop OLED controller for SteelSeries Arctis Nova Pro headset base stations. It uses Vue 3 for the interface and Tauri 2 with Rust for the desktop runtime and direct HID communication.

> [!IMPORTANT]
> Nova Display Controller is an independently developed open-source community project and currently has no affiliation or formal partnership with SteelSeries. SteelSeries, Arctis, and related names and marks belong to their respective owners and are used only to describe device compatibility. The project welcomes collaboration with SteelSeries and the community on device compatibility, official APIs, and ecosystem integration.

The project is currently in Preview and primarily targets Windows 10/11. Source code is available under the [MIT License](./LICENSE). Preview binaries will be distributed through GitHub Releases.

## Support status

| Target | Status | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | Primary | UI, HID, tray, startup, Windows media sessions, and WASAPI provider |
| Linux | Experimental | The UI and HID core are portable, but no Linux package is published yet; udev permissions are required and MPRIS media data is not implemented |
| macOS | Unsupported | Not implemented or verified |
| Arctis Nova Pro Wireless `0x12E0` | Verified | `MI_04`, 128 x 64 monochrome OLED |
| Other listed Nova Pro PIDs | Protocol profile available, hardware verification pending | Confirm the exact model before enabling output |

## Highlights

- 128 x 64 monochrome preview using the same column-major 1bpp layout as the base station
- PNG, JPEG, BMP, WebP, GIF, and video import with threshold, dithering, inversion, and scaling controls
- Reusable media and text themes with saved per-item display settings
- Visual scene editor with text, time, date, system metrics, media data, images, animations, icons, shapes, and progress bars
- Dynamic variables, layer conditions, scene rotation, music triggers, and low-battery triggers
- Importable and exportable `.nova-oled` scene packages and `.nova-backup` library backups
- Sandboxed QuickJS drawing extensions and isolated Provider v2 processes for system data sources
- Device scanning, automatic reconnect, battery and volume status, brightness control, tray behavior, and startup support
- Chinese and English interfaces with light and dark themes
- Optional pixel shifting and static-screen sleep, disabled by default to coexist with SteelSeries GG

## Local development

Windows development requires Node.js 20 LTS, Rust stable, Microsoft C++ Build Tools, and the WebView2 Runtime.

```powershell
npm install
npm run tauri dev
```

Run the validation suite before submitting changes:

```powershell
npm test
npm run build
cd src-tauri
cargo test
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution rules and [ROADMAP.md](./ROADMAP.md) for product direction. Extension authors should start with [extensions/README.md](./extensions/README.md) and [extensions/PROVIDER_API.md](./extensions/PROVIDER_API.md).

## Device communication

The application scans SteelSeries USB vendor ID `0x1038` and identifies headset base stations by PID, HID interface, and report capabilities. The currently verified device is Arctis Nova Pro Wireless `VID 0x1038 / PID 0x12E0 / MI_04`.

The following PIDs have a Nova Pro protocol profile but still need independent hardware verification:

- `0x12CB` Arctis Nova Pro Wired
- `0x12CD` Arctis Nova Pro Wired Xbox
- `0x12E5` Arctis Nova Pro Wireless Xbox
- `0x225D` Arctis Nova Pro Wireless Xbox White

Unknown models do not automatically receive Nova Pro commands. SteelSeries GG may run at the same time, although GG or the base station UI can temporarily replace custom OLED content.

## Security and privacy

- Use direct HID output only with a supported device or when you accept the risk of hardware testing.
- `.nova-oled` scene packages do not automatically embed and execute extensions. A `.nova-extension` Provider can launch a separate process, so install extensions only from trusted sources.
- Remove usernames, file paths, media titles, and other personal information before attaching diagnostic logs to an issue.
- See [PRIVACY.md](./PRIVACY.md) and [CODE_SIGNING_POLICY.md](./CODE_SIGNING_POLICY.md).

## License

Original project source is released under the [MIT License](./LICENSE). Any person or organization, including SteelSeries, may use, modify, and distribute it under that license. Third-party components retain their own licenses and copyright notices. The MIT License does not grant rights to any third-party trademarks.
