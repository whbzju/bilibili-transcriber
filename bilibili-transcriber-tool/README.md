# B 站音频转录工具

一个零 npm 依赖的本地 Web 工具，用已有脚本把 B 站视频或 UP 主空间批量转成音频、字幕和检索索引。

## 启动

```bash
node bilibili-transcriber-tool/server.mjs
```

默认地址：

```text
http://127.0.0.1:8719
```

## 工作流

1. 输入 B 站视频 URL、BV 号、`b23.tv` 短链，或 UP 主空间链接。
2. 工具调用 `scripts/download_bilibili_audio.js` 下载音频并生成 catalog。
3. 工具调用 `scripts/transcribe_audio_local.py` 做本地 Whisper 转写。
4. 工具调用 `scripts/build_transcript_reference.py` 生成投资参考索引。

如果 `yt-dlp` 被 B 站 403/412 拦截，单条视频任务会自动改用我们之前跑通过的直连兜底：

```text
B 站页面/API -> aid/cid -> x/player/playurl -> DASH 音频 -> Whisper 转写
```

服务启动时也会自动扫描历史产物：

- `data/bilibili/*`
- 根目录下的 `bilibili_BV*`

因此之前已经下载和转写过的视频，会以“历史任务”的形式出现在任务列表里。

每个任务输出到：

```text
data/bilibili-tool/<job-id>-<job-name>/
```

主要产物：

- `audio/`：音频文件与视频元数据。
- `audio-manifest.json`：转录 manifest。
- `transcripts/<model>/`：`.json`、`.md`、`.txt`、`.srt` 字幕产物。
- `investment-reference-index.md`：关键词参考索引。
- `job.log`：完整运行日志。

## 推荐配置

当前机器有 `faster-whisper` 时，推荐：

```text
转写后端：faster-whisper
模型：small
Python：python3
Cookie：Chrome
```

如果你要用已有 `video-trans` conda 环境：

```text
转写后端：openai-whisper
模型：large-v3-turbo
Python：conda env
Conda 环境：video-trans
```

## 命令行等价流程

```bash
BILI_OUTPUT_DIR=data/bilibili-tool/manual-one \
node scripts/download_bilibili_audio.js 'https://www.bilibili.com/video/BV.../'

WHISPER_BACKEND=faster \
WHISPER_MODEL=small \
AUDIO_CATALOG_DIR=data/bilibili-tool/manual-one \
python3 scripts/transcribe_audio_local.py

REF_CATALOG_DIR=data/bilibili-tool/manual-one \
python3 scripts/build_transcript_reference.py
```

## 依赖

- `node`
- `yt-dlp`
- `ffmpeg`
- `python3`
- 任一 Whisper 后端：`faster-whisper`、`openai-whisper` 或 `mlx-whisper`

部分 B 站视频匿名访问会被 403/412 拦截，默认使用 Chrome cookies。也可以选择不用 Cookie，或填写 `cookies.txt` 的绝对路径。

## Chrome Cookie 复用

Web 页面里选择：

```text
Cookie：Chrome
浏览器/Profile：chrome
```

它等价于：

```bash
yt-dlp --cookies-from-browser chrome '<bilibili-url>'
```

如果你有多个 Chrome Profile，可以把浏览器/Profile 改成：

```text
chrome:Default
chrome:Profile 1
chrome:Profile 2
```

要求：

- 在同一台 Mac、同一个系统用户的 Chrome 里已经登录 B 站。
- 如果读取失败，先完全退出 Chrome 再重试；Chrome 有时会锁住 Cookie 数据库。
- 不想读 Chrome 时，可以用浏览器插件导出 Netscape 格式 `cookies.txt`，然后选择 `cookies.txt` 模式并填绝对路径。
# 日常使用

双击本目录的 `启动工具.command`。启动器会检测已有服务、后台启动并打开系统默认浏览器；关闭终端不影响后台任务。电脑重启后需要再次双击，目前不安装开机自启动服务。端口被其他程序占用时会显示错误，可用 `BILI_TOOL_PORT=8721 node start.mjs` 选择其他端口。后台日志位于本目录 `server.log`。

默认通过 yt-dlp 读取运行工具这台电脑上用户自己的 Chrome Cookie，不需要手动导出。高级设置中的浏览器/Profile 可填写 `chrome:Default`、`chrome:Profile 1` 或 yt-dlp 支持的其他本机浏览器。打开工具网页的浏览器不必与 Cookie 来源相同；网页本身无法读取其他网站的 Cookie。

新任务记录下载、转录、索引的完成步骤，失败后点击“续跑失败步骤”跳过已经完成的步骤。旧任务没有步骤记录时仍会经过原有流程，由下载/转录脚本复用已有文件。结果支持字幕与文稿预览、全文复制和下载，技术文件与日志默认折叠。
