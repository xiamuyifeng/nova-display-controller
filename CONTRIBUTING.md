# Contributing

感谢参与 Nova Display Controller。项目目前处于 Preview 阶段，优先接受可复现的缺陷修复、已验证设备资料、性能改进和文档完善。

## 开始之前

- 较大的 UI、协议或扩展 API 改动请先创建 Issue，说明目标、交互和兼容性影响。
- 不要提交用户数据、诊断日志、抓包中的个人信息、密钥或商业软件文件。
- 不要为未经验证的 PID 自动启用写入命令。新增设备档案时请说明 VID、PID、接口、报告 ID 和实机验证结果。
- SteelSeries 名称仅用于兼容性描述，不要使用官方 Logo 或暗示项目获得官方授权。

## 开发检查

Windows 主程序需要 Node.js 20 LTS、Rust stable、Microsoft C++ Build Tools 和 WebView2 Runtime。

```powershell
npm install
npm test
npm run build
cd src-tauri
cargo test
```

Provider 和场景扩展的格式、沙箱边界与测试命令见：

- [extensions/README.md](./extensions/README.md)
- [extensions/DEVELOPMENT.md](./extensions/DEVELOPMENT.md)
- [extensions/PROVIDER_API.md](./extensions/PROVIDER_API.md)

提交应保持范围清晰，并在 Pull Request 中说明行为变化、验证方式以及涉及的设备型号。UI 改动请附上日间和夜间模式截图。
