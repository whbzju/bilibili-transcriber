# B 站音频转录工具

## WorkBuddy Skill（实验版）

现在提供独立 Skill，不需要启动 Web 服务。首版面向 macOS 本地 WorkBuddy，Python 3.9+；Windows 和云端执行暂未支持。

1. 在本仓库 Releases 下载 `bilibili-transcriber-skill.zip`。
2. 在 WorkBuddy 的技能页面选择添加技能、上传技能，导入 ZIP。
3. 在对话中说：**“使用 bilibili-transcriber 检查环境，帮我把这个 B 站视频转成完整字幕并总结：视频链接。”**
4. Agent 按技能说明运行 `doctor`，需要时运行 `setup` 创建独立 Python 环境；ffmpeg 需要单独准备。首次转录按需下载模型。

默认匿名下载。需要登录时可明确说“复用我本机 Chrome 的登录状态”；系统钥匙串授权由用户处理。不要求导出 Cookie。依赖和模型从第三方公开分发源下载，依赖使用版本范围，尚未提供完全锁定的依赖供应链。

当前支持单个 BV 视频第一分 P、音频下载、Whisper 转录、结果复用及失败重试。暂不提取官方字幕、不支持短链和 UP 主批量。数据默认存放在 `~/Library/Application Support/bilibili-transcriber`，不写入技能安装目录。

**验证范围：**已提供脚本级自动测试；WorkBuddy 客户端导入、系统授权及全新机器安装仍需实际验收，不能将本版本视为官方认证或市场上架版本。

源代码位于 `skills/bilibili-transcriber/`，按 MIT 许可证开源。使用者需有权下载和处理目标内容。Cookie 不进入模型上下文；文稿用于 Agent 总结时会进入所用平台的模型上下文。

开发检查：`python3 -m unittest discover -s tests`。

以下为原有 Web 版使用方式。

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
