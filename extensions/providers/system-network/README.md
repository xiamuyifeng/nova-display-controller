# 系统网络吞吐 Provider

独立读取本机网络接口，提供以下动态变量：

- `{dev.nova.system-network.download_kbps}`：下载速度，单位 KB/s；
- `{dev.nova.system-network.upload_kbps}`：上传速度，单位 KB/s；
- `{dev.nova.system-network.activity}`：0-100 的对数活跃度，适合直接绑定进度条。

它不访问 HID。网络统计在独立 `provider.exe` 中完成，通过 `nova-jsonl-v1` 返回主程序。

```powershell
cd extensions/providers/system-network
cargo build --release
Copy-Item target/release/nova-system-network-provider.exe provider.exe
cd ../../..
npm run pack:extension -- extensions/providers/system-network
```

生成文件：`dist-extensions/dev.nova.system-network-1.0.0.nova-extension`。
