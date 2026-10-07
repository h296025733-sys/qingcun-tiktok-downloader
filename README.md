# 轻存 · TikTok 视频下载器

轻存是我做的一个 Windows 桌面小工具。粘贴 TikTok 单视频链接后，任务进入下载队列；保存位置只需要设置一次，下载期间可以继续添加链接。

我希望它处理好几件日常小事：同名视频别互相覆盖，单条失败别卡住整个队列，电脑已经设置好的系统代理也别再填一遍。

## 主要实现

- Electron 主进程管理队列，preload 为界面提供受限接口。
- 单独解析和校验 TikTok 视频链接，拒绝主页、直播和无关网站。
- 通过 yt-dlp 获取视频；无法确认目标 MP4 时返回错误。
- 支持 Windows 系统代理与 PAC 解析，设置保存在本机。
- 下载状态、错误和文件名各有独立模块，便于维护。

主要代码在 `src/lib/`，界面在 `src/renderer/`。测试使用临时目录和替代下载进程，不会下载真实视频。

## 开发

```powershell
pnpm install
pnpm test
pnpm run check
```

运行和打包前，需要将 **yt-dlp 2026.08.19 的 Windows 可执行文件**放到 `vendor/yt-dlp.exe`。仓库保留该版本的 SHA-256 和许可证，二进制文件需要自行从 yt-dlp 官方发布页取得。

```powershell
pnpm run verify:engine
pnpm start
pnpm run dist
```

`verify:engine` 会实际检查版本和哈希，`dist` 输出 Windows x64 便携程序。平台登录、地区限制和风控仍取决于使用者的网络与账号；这里只处理手工提交的公开单视频链接。

## 本次公开整理的检查

见 [检查记录](docs/verification.md)，其中区分源码与语法检查、隔离测试和未执行的真实环境路径。
