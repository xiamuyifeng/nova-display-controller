# 扩展开发工具

普通用户只需要在应用中导入 `.nova-extension`。下面的命令面向扩展作者。

## 创建 Provider

```powershell
npm run create:provider -- com.example.my-provider
```

默认生成到 `extensions/local/com.example.my-provider`。模板使用 Node.js，包含变量、像素绘图和事件的最小实现，适合协议原型和本地数据源。正式分发时可以把入口换成 Rust、C#、Go 或其他独立可执行程序，JSONL 协议不变。

## 静态检查

目录和打包后的扩展都可以检查：

```powershell
npm run check:extension -- extensions/local/com.example.my-provider
npm run pack:extension -- extensions/local/com.example.my-provider
npm run check:extension -- dist-extensions/com.example.my-provider-0.1.0.nova-extension
```

检查内容包括清单版本、扩展 ID、入口路径、能力声明、变量、事件、权限和包内文件。

## 协议测试

```powershell
npm run test:provider -- extensions/local/com.example.my-provider/provider.cmd
```

测试器会实际启动 Provider，发送 `initialize`、`tick` 和 `shutdown`，并验证结果是否同时包含变量、图层和事件数组。它不会连接 OLED 或修改应用扩展库。

项目内的 Rust Provider 也可直接作为实现参考：`providers/system-audio` 展示 Windows WASAPI 绘图与事件，`providers/system-network` 展示不需要主程序适配的纯变量数据源。

Node SDK 位于 `extensions/sdk/node/nova-provider.mjs`。完整协议见 `extensions/PROVIDER_API.md`。
编辑器可使用 `extensions/manifest.schema.json` 为 `manifest.json` 提供字段校验与补全。
