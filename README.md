# Nova Display Controller

SteelSeries Arctis Nova Pro 耳机基座 OLED 桌面控制器。前端使用 Vue 3，桌面外壳与设备通信使用 Tauri 2 + Rust。

> [!IMPORTANT]
> 这是非官方社区项目，与 SteelSeries 没有隶属、授权或背书关系。SteelSeries、Arctis 和相关产品名称是其各自所有者的商标。本项目直接与 HID 设备通信，请只在下方明确标为“已验证”的硬件上使用。

项目目前处于 Preview 阶段，主要面向 Windows 10/11。源码采用 [MIT License](./LICENSE)；安装包将在 GitHub Releases 中作为预发布版本提供。

## 支持状态

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11 x64 | 主要支持 | UI、HID、系统托盘、开机自启、Windows 媒体会话和 WASAPI Provider |
| Linux | 实验性 | 核心 UI/HID 具备跨平台基础，但尚未发布安装包；需要 udev 权限，音乐信息尚未接入 MPRIS |
| macOS | 未支持 | 尚未实现和验证 |
| Arctis Nova Pro Wireless `0x12E0` | 已验证 | `MI_04`，128 x 64 单色 OLED |
| README 中列出的其他 Nova Pro PID | 协议兼容，待实机验证 | 软件会识别并使用当前 Nova Pro 配置档案，使用前请核对型号 |

发现新设备兼容性结果时，欢迎在 Issue 中附上型号、VID/PID、操作系统和不含隐私信息的诊断摘要。不要公开上传完整 HID 抓包、个人日志或第三方账号信息。

## 当前功能

- 128 x 64 单色实时预览，输出数据与基座使用相同的列优先 1bpp 布局
- 导入 PNG/JPG/BMP/WebP 图片、GIF 和视频
- 图片、GIF、视频和文字主题统一支持搜索、收藏、复制与删除，显示参数会随主题保存
- 完整显示、裁切填满和拉伸三种缩放方式
- 可调阈值、Floyd-Steinberg 抖动与反色
- 自定义文字、时钟、CPU/内存监控和 Windows 系统媒体信息
- Scene v5 可视化编辑器：图层移动、八方向缩放、吸附、锁定、排序、复制、撤销与重做
- 可编辑的时钟、系统和音乐场景模板，以及统一的实时动态变量
- 播放、电池、音量、耳机四种内置状态图标
- 自由场景可以导入、导出为 `.nova-oled` 压缩包，场景引用的图片、GIF 和视频会一并打包
- “我的场景”提供实时 128 x 64 缩略图，并支持搜索、收藏筛选、复制、单独导出和删除
- 场景编排支持默认轮播，以及播放音乐和低电量时的整场景切换
- 低电量切换阈值可选，触发结束后自动恢复默认编排
- GIF/视频实时输出，OLED 帧率可选 5、10、15、20 或 30 FPS
- 基座自动扫描、自动连接和手动设备选择
- USB 通信意外中断或电脑唤醒后自动重连，并恢复此前的实时显示或场景编排
- 耳机连接、电池、充电、主音量和 Game/Chat 状态显示
- OLED 亮度控制、单帧发送和实时输出
- 一键导出和合并恢复完整 `.nova-backup` 备份，包含主题、素材、场景、编排及常用偏好
- `.nova-extension` 扩展：QuickJS 沙箱用于轻量绘图，Provider v2 独立进程可实现音频、GPU、网络或游戏数据源
- 扩展数值变量可以直接绑定到自由场景进度条，并配置扩展缺失或无数据时的回退值
- 图层可按播放、暂停、耳机连接或断开状态显示，未满足条件时仍可在编辑器中淡化选中
- 场景包记录扩展 ID、最低版本和运行时，导入后会提示缺少、过旧、停用或运行异常的扩展
- 内置真实 Windows WASAPI 系统音频频谱，支持强度变量、频谱图层和声音开始/停止事件
- 可选系统网络吞吐 Provider，提供下载、上传和 0-100 网络活跃度变量
- 可选 OLED 防烧屏微移与静态画面休眠，默认关闭并与 SteelSeries GG 的保护功能互补
- 中文与英文界面可在设置页即时切换，语言偏好会保存在本机
- 日间与夜间两套界面主题，支持设置页选择和标题栏一键切换；OLED 预览始终保持真实黑白效果
- 工作台、场景编辑器、场景编排和设置页已针对较窄窗口及英文长标签优化布局

## 本地开发

Windows 开发环境需要 Node.js 20 LTS、Rust stable、Microsoft C++ Build Tools 和 WebView2 Runtime。

```powershell
npm install
npm run tauri dev
```

`tauri dev` 用于开发热更新，终端关闭后其本地开发服务器也会退出。生成不依赖 `localhost` 的独立调试程序：

```powershell
npm run tauri build -- --debug --no-bundle
.\src-tauri\target\debug\nova-display-controller.exe
```

产品路线见 [ROADMAP.md](./ROADMAP.md)。

只检查和预览前端：

```powershell
npm run dev
npm run build
```

提交改动前运行：

```powershell
npm test
npm run build
cd src-tauri
cargo test
```

参与开发前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。第三方依赖归属见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

需要底层 HID 报告诊断时，显式启用仅开发使用的探测程序：

```powershell
cd src-tauri
cargo run --features dev-tools --bin hid_probe
```

## 场景包

自由场景工具栏中的“导出”会打开系统原生保存窗口，生成版本化的 `.nova-oled` 文件。包内包含 `manifest.json`、场景结构以及该场景实际引用的本地素材。导入时会重新建立素材 ID，不会覆盖已有主题。

场景包 v2 还会记录实际用到的扩展 ID、名称、最低版本和运行时。导入后编辑器会诊断扩展是否可用，但场景包不会携带、自动安装或自动执行扩展代码；v1 场景包仍可导入。

导入会校验格式版本、素材数量、文件大小和解压后体积。单个场景包最多包含 64 个素材，素材总大小不能超过 64 MB，场景包文件不能超过 96 MB。

## 完整备份

设置页的“备份与恢复”可以把整个本地主题库和已安装扩展导出为 `.nova-backup` 文件。恢复采用合并方式：所有导入主题都会生成新 ID，场景和编排中的引用会自动更新；同 ID 的现有扩展不会被覆盖。

备份还包含自动连接、OLED 帧率、屏幕保护偏好、当前自由场景和最近选择的编排。开机自启动与目标 USB 设备属于当前电脑，不会写入备份。完整备份最多包含 512 个项目，素材总大小不能超过 512 MB。

## 代码扩展

设置页的“功能扩展”支持导入 `.nova-extension`，也可以一键安装真实系统音频频谱或系统网络吞吐 Provider。启用绘图扩展后，自由场景工具栏会列出每个可用扩展图层；扩展声明的变量会出现在文字图层变量列表中，事件可以用于场景编排触发。

普通扩展代码在独立 Worker 内的 QuickJS 虚拟机中运行，不具备 DOM、网络、文件、Tauri 或 HID 权限。需要系统能力的 Provider 作为独立进程运行，安装和首次启用都需要明确确认；主程序负责超时、崩溃隔离、日志、消息校验以及最终 OLED 合成。普通 `.nova-oled` 场景包只记录所需扩展 ID，不会嵌入并自动执行第三方代码。

扩展 API、Provider 协议和开发工具见 [extensions/README.md](./extensions/README.md) 与 [extensions/DEVELOPMENT.md](./extensions/DEVELOPMENT.md)。创建并测试一个 Provider：

```powershell
npm run create:provider -- com.example.my-provider
npm run check:extension -- extensions/local/com.example.my-provider
npm run test:provider -- extensions/local/com.example.my-provider/provider.cmd
```

## 设备识别与选择

应用启动时扫描 SteelSeries USB VID `0x1038` 下的耳机基座，并按 PID、HID 接口和报告能力识别设备。设置页提供两种选择方式：

- `自动选择（推荐）`：连接扫描到的第一个已支持基座。
- 手动选择：多台基座同时连接时，指定要控制的设备；选择会保存在本机。

已启用并沿用当前 Nova Pro HID/OLED 协议的 PID：

- `0x12CB` Arctis Nova Pro Wired
- `0x12CD` Arctis Nova Pro Wired Xbox
- `0x12E0` Arctis Nova Pro Wireless
- `0x12E5` Arctis Nova Pro Wireless Xbox
- `0x225D` Arctis Nova Pro Wireless Xbox White

下列设备目前只会被识别并显示型号，不会发送未经验证的 Nova Pro 指令：

- `0x2244` Arctis Nova Elite
- `0x2290` Arctis Nova Pro Omni
- `0x1290` Arctis Pro Wireless Base Station
- `0x1280` 第一代 GameDAC / Arctis Pro Wired

自动识别失败时，可以在设置页重新扫描 USB 设备。未知型号不会自动套用 Nova Pro 协议，以避免误操作硬件。

## 通信说明

Nova Pro 系列使用直接 HID 通信。当前已验证设备为 Arctis Nova Pro Wireless `VID 0x1038 / PID 0x12E0 / MI_04`，OLED 使用 128 x 64 单色帧。

SteelSeries GG 可以与应用同时运行，但可能覆盖 OLED 内容或占用设备接口。出现连接失败、画面被恢复或发送不稳定时，可先暂停 GG 中会更新基座屏幕的功能；排查时再临时退出 GG。

GameSense 本地 API 仍保留为兼容性实验入口。GG 接受 GameSense 请求不代表 Nova Pro 基座会把对应事件转发到 OLED，因此它不是当前主通信通道。

Linux 需要为相应 `hidraw` 设备配置 udev 访问权限。OLED 长时间显示静止高亮内容可能烧屏，建议使用动画或定期切换内容。

## 安全提示

- 只在明确支持或愿意承担测试风险的设备上启用直接 HID 输出；未知型号不会自动发送 Nova Pro 指令。
- `.nova-oled` 场景包不会自动携带并执行扩展，但 `.nova-extension` Provider 可以启动独立进程，只安装可信来源的扩展。
- 提交 Issue 前请检查诊断日志，移除用户名、文件路径、媒体标题和其他个人信息。
- 本项目不修改 SteelSeries GG；两者可以共存，但 GG 或基座自身界面可能短暂覆盖 OLED 内容。

## 许可证

项目源码使用 [MIT License](./LICENSE)。第三方组件保留各自许可证和版权声明。本仓库不会授予 SteelSeries 商标、产品名称或品牌素材的使用权。

如果 Cargo 报错 `sparse registry url must end in a slash`，请确认 `%USERPROFILE%\.cargo\config.toml` 中的镜像地址以 `/` 结尾：

```toml
registry = "sparse+https://rsproxy.cn/index/"
```
