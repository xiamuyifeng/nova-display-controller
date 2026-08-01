# Nova Display Provider API v2

Provider 扩展用于实现 QuickJS 沙箱无法完成的系统能力，例如系统音频频谱、GPU 监控、网络数据、游戏遥测或第三方硬件读取。它是独立进程，拥有与当前用户相同的系统权限，因此只能安装可信来源的扩展。

主程序仍然独占场景合成与 OLED/HID 输出。Provider 只能通过标准输入和标准输出交换 JSON Lines 消息，不能接管常规 OLED 通信。

## manifest.json

```json
{
  "format": "nova-display-extension",
  "apiVersion": 2,
  "runtime": "provider",
  "id": "com.example.spectrum",
  "name": "系统音频频谱",
  "version": "1.0.0",
  "author": "Example",
  "description": "读取系统回放音频并输出频谱。",
  "entry": {
    "windows": "bin/provider.exe",
    "linux": "bin/provider"
  },
  "protocol": "nova-jsonl-v1",
  "capabilities": ["variables", "renderer", "events"],
  "variables": [
    { "key": "rms", "label": "音量强度" }
  ],
  "events": [
    { "key": "audio_started", "label": "检测到声音" }
  ],
  "renderer": {
    "label": "音频频谱",
    "settings": [
      { "key": "bars", "label": "频段数量", "type": "range", "default": 16, "min": 4, "max": 32, "step": 1 }
    ]
  },
  "permissions": ["native.process"]
}
```

扩展包可包含 Provider 所需的动态库和资源。打包命令会递归包含扩展目录中的文件：

```powershell
npm run pack:extension -- extensions/my-provider
```

## nova-jsonl-v1

每条消息必须是单行 UTF-8 JSON，最大 1 MB。Provider 不应向标准输出写普通日志，日志应写入标准错误。

启动后主程序先发送：

```json
{"type":"initialize","protocol":"nova-jsonl-v1","extensionId":"com.example.spectrum","host":{"name":"Nova Display","version":"0.1.0","platform":"windows"}}
```

场景刷新时发送：

```json
{"type":"tick","requestId":1,"context":{"timeMs":0,"cpu":25},"renders":[{"id":"layer-1","width":64,"height":24,"settings":{"bars":16}}]}
```

Provider 必须针对该请求返回一个 `result`。变量名和图层 ID 由主程序校验，像素使用图层内部的行优先索引 `y * width + x`：

```json
{"type":"result","requestId":1,"variables":{"rms":72},"renders":[{"id":"layer-1","pixels":[0,1,64,65]}],"events":[{"name":"audio_started","data":{"rms":72}}]}
```

Provider 也可以在 `result` 前发送增量消息：

```json
{"type":"variables","values":{"rms":72}}
{"type":"frame","layerId":"layer-1","pixels":[0,1,64,65]}
{"type":"event","name":"audio_started","data":{"rms":72}}
```

清单中声明的事件会进入场景编排的“扩展事件时”选项。主程序不解释事件的业务含义，只按扩展 ID 和事件名匹配，因此新扩展可以自行定义游戏回合、网络状态、麦克风状态等触发条件。

无法继续时可以返回：

```json
{"type":"error","message":"未找到默认音频设备"}
```

停用、删除或应用退出时主程序会发送 `{"type":"shutdown"}`，随后终止仍未退出的进程。首次启动允许 1500 ms 响应，常规刷新允许 350 ms；超时、崩溃或通信断开后进程会被终止，下次需要数据时重新启动。输出队列、消息大小、文件数量和安装体积均有限制。

## 安全模型

- 安装与首次启用均需要用户明确确认。
- Provider 单独运行，崩溃不会带走主程序。
- 主程序限制消息大小、输出队列和响应时间，并保留最近 200 行标准错误日志。
- 完整备份不会携带原生可执行文件，也不会在另一台电脑自动恢复 Provider。
- Provider 不会获得主程序的 HID 句柄；扩展返回的数据仍经过变量声明、像素范围和场景裁切校验。
