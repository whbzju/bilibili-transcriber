# B 站音频转录工具

本地下载 B 站音频、获取可用字幕并使用 Whisper 转录，支持任务续跑、文稿预览和下载。Web 服务没有 npm 依赖。

## 安装与启动

需要 Node.js 22+、Python 3.9+、ffmpeg。macOS 示例：

```sh
brew install node ffmpeg
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm start
```

打开 http://127.0.0.1:8719/。`npm start` 后台启动并在 macOS 打开默认浏览器；`npm run dev` 在前台运行。首次转录需要下载 Whisper 模型。

macOS 也可双击 `bilibili-transcriber-tool/启动工具.command`；请确保所需命令可在 PATH 中找到。电脑重启后需重新启动工具，当前不安装开机自启动服务。

## 浏览器登录状态

默认读取运行工具的本机用户 Chrome Cookie，通过 yt-dlp 向 B 站请求媒体。无需手动导出或上传 Cookie。高级设置可指定其他受 yt-dlp 支持的浏览器或 `chrome:Profile 1` 等配置。打开工具页面的浏览器与 Cookie 来源可以不同。系统可能要求授权读取钥匙串。

## 结果与续跑

- 每个任务保存在 `data/bilibili-tool/`，包含音频、SRT、TXT 和索引。
- 新任务记录完成步骤，失败后可续跑，跳过已完成的步骤。
- 转录由本机 Whisper 执行，结果未经人工校对。
- 直连备用下载适用于部分公开视频，不保证所有视频都可下载。
- 数据、Cookie、日志和模型环境不纳入版本控制。

更完整的配置见 [工具说明](bilibili-transcriber-tool/README.md)。
