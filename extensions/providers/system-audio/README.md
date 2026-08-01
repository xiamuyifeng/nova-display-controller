# 系统音频频谱 Provider

这是 Nova Display Provider API v2 的第一个真实系统能力扩展。它使用 Windows WASAPI loopback 读取默认播放设备，提供：

- `{dev.nova.system-audio.rms}` 音频强度变量；
- 可配置频段数量、灵敏度、平滑度和填充方式的频谱图层。
- `audio_started` 与 `audio_stopped` 通用事件，可在场景编排中绑定显示内容。

它不包含在主程序中，也不访问 HID。默认音频设备读取和频谱计算都在独立 `provider.exe` 中完成，画面像素通过 `nova-jsonl-v1` 返回主程序。

## 构建与打包

```powershell
cd extensions/providers/system-audio
cargo build --release --offline
Copy-Item target/release/nova-system-audio-provider.exe provider.exe
cd ../../..
npm run pack:extension -- extensions/providers/system-audio
```

生成的扩展包位于：

```text
dist-extensions/dev.nova.system-audio-1.1.0.nova-extension
```

在“设置 > 功能扩展 > 导入扩展”中选择该文件。原生 Provider 拥有当前 Windows 用户权限，因此安装和首次启用都会要求确认。

当前版本跟随 Windows 默认播放设备。切换默认设备后，停用再启用扩展即可重新连接。
