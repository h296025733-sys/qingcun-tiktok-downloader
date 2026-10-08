# 轻存 · TikTok 视频下载器

**一个 Windows 桌面下载队列：粘贴链接、设置目录、查看每一项结果。**

轻存把手工提交的 TikTok 单视频链接交给 yt-dlp 下载。任务运行时可以继续添加链接；设置和保存位置留在本机。

这个工具的重点是把下载过程里容易烦人的小事处理好：同名文件互相覆盖、一个失败任务挡住后面的队列，以及系统代理已经可用却还要重复配置。

## 界面之外的实现

- [link-parser.js](src/lib/link-parser.js) 负责链接解析与校验，拒绝主页、直播和无关网站。
- [download-manager.js](src/lib/download-manager.js) 在主进程管理队列、下载进程与逐项状态，无法确认目标 MP4 时报告错误。
- [proxy-resolver.js](src/lib/proxy-resolver.js) 处理 Windows 系统代理与 PAC，减少额外配置。
- [preload.js](src/preload.js) 向页面暴露受限接口；设置由 [settings-store.js](src/lib/settings-store.js) 单独保存。

测试使用临时目录与替代下载进程，覆盖链接、队列、路径、设置和代理；真实桌面运行与平台下载仍有独立的验证范围。

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
