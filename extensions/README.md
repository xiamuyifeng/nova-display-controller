# Nova Display Extension API v1

扩展是一个 `.nova-extension` ZIP 包，至少包含 `manifest.json` 和一个 JavaScript 入口文件。扩展代码运行在独立 Worker 内的 QuickJS 沙箱中，不能访问 DOM、网络、文件、Tauri、HID 或 Node.js。

## 创建和打包

QuickJS 扩展可以自行创建包含 `manifest.json` 和 `main.js` 的目录，然后在项目根目录运行：

```powershell
npm run pack:extension -- extensions/local/com.example.quickjs
```

生成文件位于 `dist-extensions`。在软件的“设置 > 功能扩展”中导入该文件。

需要系统权限的 Provider 扩展请从开发模板开始：

```powershell
npm run create:provider -- com.example.my-provider
```

完整开发与检查流程见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## 扩展入口

入口文件必须定义 `globalThis.novaExtension`。两个函数均为可选，但至少需要在清单中声明对应能力。

```js
globalThis.novaExtension = {
  update(context) {
    return { score: 42 };
  },

  render(context, settings) {
    return [0, 1, 2, context.width];
  },
};
```

`update` 返回的字段必须在清单的 `variables` 中声明。场景文字使用完整变量名，例如 `{com.example.meter.score}`。数值变量还可以在自由场景的进度条中选择为“扩展数值”数据源；无数据、非数字或扩展停用时使用图层设置的回退百分比。

`render` 返回需要点亮的像素索引数组。索引为图层内部的行优先坐标：

```js
const index = y * context.width + x;
```

主程序会把这些局部像素放到扩展图层的位置，并应用图层裁切、层级和反色。扩展不负责 HID 通信。

## Runtime context

每次执行会收到只读快照：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `timeMs` | number | 当前 Unix 毫秒时间，可用于动画 |
| `width` / `height` | number | 仅 `render` 中存在，当前图层尺寸 |
| `cpu` / `memory` | number | CPU 与内存百分比 |
| `battery` / `spareBattery` | number or null | 耳机与备用电池 |
| `volume` | number | 当前音量 |
| `track` / `artist` | string | 当前媒体信息 |
| `progress` / `playing` | number / boolean | 播放进度与状态 |
| `headsetConnected` | boolean | 耳机连接状态 |

## 设置类型

绘图扩展可以在 `renderer.settings` 中声明最多 24 个设置，软件会自动生成控件：

- `range`: 滑块，支持 `min`、`max` 和 `step`。
- `number`: 数字输入。
- `toggle`: 开关。
- `select`: 选项菜单，需要 `options`。

设置值作为 `render` 的第二个参数传入。不需要为扩展编写设置界面。

## 限制

- 扩展包最大 2 MB，入口源码最大 256 KB。
- 单次执行内存上限 8 MB，代码执行预算约 35 ms；运行环境无响应超过 2 秒会重建 Worker。
- 最多声明 32 个变量和 24 个设置。
- 单个图层最多返回 8192 个有效像素。
- API v1 不支持外部模块、异步函数或任何系统权限，`permissions` 必须为空数组。
- 普通 `.nova-oled` 场景包不会嵌入可执行扩展；分享场景时应同时提供所需的 `.nova-extension`。
- `.nova-oled` v2 会记录所需扩展的 ID、最低版本与运行时，并在导入后显示诊断状态，但不会自动安装或执行这些扩展。
- 完整 `.nova-backup` 会保存已安装扩展，恢复时不会覆盖同 ID 的现有版本。

需要系统音频、GPU、网络、游戏遥测等能力时，使用独立进程型 Provider API v2。协议、安全边界和清单格式见 [PROVIDER_API.md](./PROVIDER_API.md)。

可直接测试的 Windows Provider：

- `providers/system-audio`：WASAPI 系统音频强度、频谱图层和声音事件；
- `providers/system-network`：下载/上传 KB/s 与 0-100 网络活跃度变量。

构建好的 `.nova-extension` 位于项目的 `dist-extensions` 目录中。
