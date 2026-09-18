# Bilibili Transcriber · B 站视频转录 Skill

给 **Codex、Claude Code（CC）和 WorkBuddy** 使用的本地视频转录工具。把 B 站链接交给 Agent，获取音频、完整文稿和带时间轴的字幕，再在对话里总结或分析。

**macOS 实验版 · MIT 开源 · 本地 Whisper 转录 · 无需转录 API Key**

[下载 Skill ZIP](https://github.com/whbzju/bilibili-transcriber/releases/download/v0.2.0-alpha.4/bilibili-transcriber-skill.zip) · [版本发布](https://github.com/whbzju/bilibili-transcriber/releases) · [Skill 源码](skills/bilibili-transcriber) · [反馈问题](https://github.com/whbzju/bilibili-transcriber/issues)

> 三个平台共用同一份 `SKILL.md` 和 Python 程序，区别在安装入口。当前交付的是 **Skill 包，不是已上架各平台市场的插件**。支持接入不等于所有平台均已完成实机验收，详见下方验证状态。

## 能做什么

- 下载单个 B 站视频的音频，用 faster-whisper 在本机转录。
- 产出 TXT 完整文稿、SRT 字幕和带时间点的 Markdown。
- 让 Agent 读取文稿，继续总结、分析、提取观点或回答问题。
- 检查环境、创建独立 Python 环境；后台运行、查询状态、失败重试。
- 按视频 ID 和模型复用结果，避免重复转录。
- 默认匿名下载；需要时显式复用用户本机浏览器登录状态。

当前只支持 **BV 号和标准视频链接、第一分 P**。Skill 暂不支持 b23 短链、UP 主批量、官方字幕优先获取、自动说话人识别或自动事实核查。自动转录可能误识别专有名词和数字。

## 先选你的 Agent 平台

| 平台 | 安装方式 | 使用入口 | 当前验证 |
| --- | --- | --- | --- |
| Codex 本地桌面端 / CLI | 对话中使用 skill-installer 安装 GitHub Skill 路径 | `$bilibili-transcriber` 或自然语言 | 已验证安装器下载到临时目录并运行 doctor |
| Claude Code 本地版 | 将完整 Skill 文件夹放入 `~/.claude/skills/` | `/bilibili-transcriber` 或自然语言 | 按官方 Skill 格式适配，客户端调用待实测 |
| WorkBuddy 本地桌面端 | 导入发布页 ZIP；也可尝试让 Agent 帮助安装 | 自然语言 | 技能包已提供，客户端导入与调用待实测 |

三端均需要 **本地执行能力、Python 3.9+ 和 ffmpeg**。Windows、Linux、云端沙箱目前不在本版本的支持范围；云端不能直接复用用户电脑的浏览器 Cookie。Skill 本身不需要 Node.js，只有可选 Web 版需要。

## 安装

### Codex

直接在 Codex 对话中发送：

```text
请使用 $skill-installer 安装这个 Skill：
https://github.com/whbzju/bilibili-transcriber/tree/v0.2.0-alpha.4/skills/bilibili-transcriber
```

安装后在新会话中发送：

```text
使用 $bilibili-transcriber 检查环境，把这个 B 站视频转成完整字幕并总结：
这里粘贴视频链接
```

如当前会话尚未发现新 Skill，重新开启会话。安装完成只代表技能文件到位，不代表 Whisper 和模型已准备完成。

### Claude Code（CC）

可以让 Claude Code 帮你安装，发送下面这段请求：

```text
请下载并检查这个 Skill 包：
https://github.com/whbzju/bilibili-transcriber/releases/download/v0.2.0-alpha.4/bilibili-transcriber-skill.zip
将其中完整的 bilibili-transcriber 文件夹安装到 ~/.claude/skills/。
如果同名目录已经存在，先检查版本，不要直接覆盖。
安装后按 SKILL.md 检查环境并协助初始化。
```

这是交给 Agent 的操作请求，不是 Claude Code 内置的 GitHub 安装命令。如果需要手动安装，下载 ZIP、解压，将整个文件夹放到：

```text
~/.claude/skills/bilibili-transcriber/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    ├── bili.py
    ├── requirements.txt
    └── transcribe_audio_local.py
```

不要只复制 `SKILL.md`；脚本也必须保留。然后在 Claude Code 中使用：

```text
/bilibili-transcriber 把这个视频转成完整字幕并总结：这里粘贴视频链接
```

目录和调用方式依据 [Claude Code 官方 Skills 文档](https://code.claude.com/docs/en/skills)。包中的 `agents/openai.yaml` 是 Codex 展示信息，不是转录依赖。

### WorkBuddy

**明确的安装路径：**

1. 下载上方 Skill ZIP。
2. 打开 WorkBuddy「技能 → 添加技能 → 上传技能」，导入 ZIP。
3. 在对话中发送：

```text
使用 bilibili-transcriber 检查本机环境，把这个 B 站视频转成完整字幕并总结：
这里粘贴视频链接
```

**也可以尝试让 WorkBuddy 帮忙安装：**

```text
请帮我下载安装这个 Skill：
https://github.com/whbzju/bilibili-transcriber/releases/download/v0.2.0-alpha.4/bilibili-transcriber-skill.zip
安装后检查运行环境，缺少依赖时协助我完成初始化。
```

如果 WorkBuddy 只能下载而不能完成导入，请按上述界面流程上传 ZIP。我们尚未验证任意外部 ZIP 都能通过一句话自动安装，不把这一点作为功能承诺。参见 [WorkBuddy 官方技能说明](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)。

## 第一次使用会发生什么

1. **检查环境**：Agent 调用 `doctor`，检测系统、ffmpeg 和独立转录环境。
2. **准备依赖**：需要时调用 `setup`，通过 Python venv 创建工具自己的运行环境，并安装 yt-dlp 和 faster-whisper。不修改系统 Python。
3. **准备 ffmpeg**：它不由 `setup` 安装。macOS 已有 Homebrew 时可由 Agent 协助执行 `brew install ffmpeg`；没有 Homebrew 时先解决前置条件。
4. **下载模型**：首次转录从 Hugging Face 下载所选模型，后续复用缓存。耗时取决于网络和设备。
5. **开始处理**：后台下载音频、转录；Agent 查询状态，完成后读取文稿。

安装、网络访问、写入目录和系统钥匙串授权仍受宿主与系统权限控制。需要的授权由用户处理。当前 Python 依赖使用版本范围，未提供完全锁定的跨机器环境。

## 日常怎么用

**完整文稿 + 总结**

```text
帮我把这个视频转成完整文稿和 SRT 字幕，再总结核心观点：视频链接
```

**需要登录时复用 Chrome**

```text
复用我本机 Chrome 的 B 站登录状态，处理这个视频：视频链接
```

**指定浏览器 Profile**

```text
使用 chrome:Profile 1 的登录状态下载，完成后给我完整文稿。
```

**处理后继续追问**

```text
根据刚才的文稿，整理作者的论据，并标注对应时间点。
把作者的观点与需要外部核实的数据分开列出。
```

总结和分析由所用 Agent 完成，不是转录程序自动生成的固定报告。后台任务继续执行不代表会话结束后 Agent 一定会自动通知；可再次询问任务进度。

## 实现原理

```text
用户提供 BV 号或视频链接
          ↓
Codex / Claude Code / WorkBuddy 加载 SKILL.md
          ↓
bili.py doctor / setup：检查并准备本地环境
          ↓
bili.py start：验证链接、建立任务、启动后台进程
          ↓
yt-dlp 下载第一分 P 的音频 → ffmpeg 输出 m4a
          ↓
faster-whisper 本地转录（默认 small / CPU / int8）
          ↓
生成 TXT、SRT、Markdown；保存状态和文件路径
          ↓
Agent 查询 status → 读取文稿 → 总结、分析、交付文件
```

- **Skill 是操作说明**：指导 Agent 调用工具、处理错误与交付结果。
- **Python 程序负责执行**：用参数列表启动子进程，限定 B 站视频输入，不把链接拼成 shell 命令。
- **Cookie 按需启用**：默认不读取浏览器；指定 `--browser` 时使用 yt-dlp 的浏览器 Cookie 读取能力。
- **结果与续跑**：任务 ID 为 `BV号-模型`。成功结果仍存在时直接复用；失败后重新 start，有音频与 manifest 时跳过下载。旧 manifest 缺少 `status` 时，仅在对应音频文件存在且非空后自动补为 `exists`，不覆盖显式失败状态。不是从音频断点继续识别，未完成的单条转录可能重新执行。
- **转录验收**：新下载的清单标记为 `downloaded`；未选中音频（`selectedCount=0`）会明确报错，不误报成功。成功任务要求 TXT 和 SRT 产物均非空。
- **后台状态**：start 快速返回任务 ID，status 返回阶段、错误与产物。进程退出后的状态检查可以识别中断。
- **不依赖网页服务**：Skill 无需启动 8719 端口，也不依赖浏览器扩展或远程 MCP。

## Cookie 与数据

Cookie 由用户本机的 yt-dlp 读取，用于对应网站请求；不通过提示词输入，不作为工具结果返回给 Agent，也不要求手动导出 cookies.txt。浏览器读取过程可能加载不止 B 站的 Cookie，不能宣称只访问 B 站 Cookie。登录是否有效取决于浏览器、Profile、系统授权与平台状态。

**本地转录不等于整个流程离线：**

| 环节 | 数据流向 |
| --- | --- |
| 获取音频 | 请求 B 站及其媒体服务；启用登录状态时携带适用的 Cookie |
| 安装依赖、模型 | 从软件包与模型分发源下载 |
| Whisper 转录 | 在本机计算，不需要云端转录 API |
| Agent 总结 | 文稿进入你使用的 Agent 平台的模型上下文 |

Skill 默认保存到：

```text
~/Library/Application Support/bilibili-transcriber/
├── runtime/                  # 独立 Python 环境
├── cache/                    # 模型缓存
└── jobs/
    └── BVxxxxxxxxxx-small/
        ├── job.json          # 状态、阶段和结果路径
        ├── worker.log
        ├── audio.m4a
        ├── audio-manifest.json
        └── transcripts/small/
            ├── *.txt
            ├── *.srt
            └── *.md
```

可用绝对路径环境变量 `BILI_HOME` 覆盖。不同平台使用同一目录和同一模型时可复用结果。更改目录后不会自动迁移旧任务。卸载 Skill 不自动删除音频、缓存或独立环境。

## 命令行用法

以下命令在仓库根目录执行；安装到 Agent 后，应使用技能目录中脚本的实际绝对路径。

```sh
python3 skills/bilibili-transcriber/scripts/bili.py doctor
python3 skills/bilibili-transcriber/scripts/bili.py setup

# BVxxxxxxxxxx 是占位符，请替换为真实 BV 号
python3 skills/bilibili-transcriber/scripts/bili.py start BVxxxxxxxxxx
python3 skills/bilibili-transcriber/scripts/bili.py start BVxxxxxxxxxx --browser chrome
python3 skills/bilibili-transcriber/scripts/bili.py start BVxxxxxxxxxx --browser 'chrome:Profile 1' --model small
python3 skills/bilibili-transcriber/scripts/bili.py status BVxxxxxxxxxx-small
```

模型选项：`base`、`small`、`medium`。命令以 JSON 返回状态，任务成功以 `status=succeeded` 为准，不以“命令已启动”为准。更换模型会建立不同任务。

## 初始化失败与权限提示

新版 setup 会保留已有环境与数据，并返回结构化错误（失败阶段、具体路径和恢复建议）。可用环境直接复用；部分安装在原目录重试，不自动清空。

- WorkBuddy 提示批量删除时，请选取消，不执行 `rm -rf` 或 `venv --clear`。
- 权限不足：按宿主正常授权流程处理，不因写入被拒绝就删除环境。
- 网络或依赖失败：先处理原始错误，再重试 setup；持续失败时停止，不反复清理。
- 确需重建：先确认精确 runtime 路径，由用户决定是否备份重建。工具不提供自动清理命令，不删除 jobs、cache 或整个数据目录。
- 已安装旧版的用户需更新 Skill 才能获得这些规则；更新时保留数据目录。新版 ZIP 不会自动替换本机已安装技能。

## 常见问题

| 问题 | 处理方式 |
| --- | --- |
| Skill 安装了但无法转录 | 安装 Skill 只复制工具文件，先运行 doctor，缺运行环境再 setup |
| 没有 Python 或 ffmpeg | 协助安装前置依赖；setup 不安装系统 Python、ffmpeg 或 Homebrew |
| 匿名下载失败 | 检查网络与访问权限；需要时指定自己的浏览器登录状态 |
| Chrome 读取失败 | 确认同一系统用户、正确 Profile，处理系统授权；不无限重试 |
| 模型下载慢 | 首次需要网络下载，后续复用缓存；检查模型源连接 |
| 任务失败或机器重启 | 查询 status，解决原因后重新 start，复用已有音频 |
| 同一个视频直接返回结果 | 按 BV 和模型缓存成功结果；当前没有强制重新转录选项 |
| 字幕不准确 | 自动语音识别有误差；财务数字、名称等需人工核对 |
| 本地文件不见了 | 查看 status 的文件路径与 BILI_HOME；不要只找 Agent 当前项目目录 |

## 可选：本地 Web 工具

仓库还保留原有 Web 版，它与 Skill 的安装和任务目录不同，不需要为了使用 Skill 而启动。

```sh
brew install node ffmpeg
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm start
```

Web 版需要 Node.js 22+，默认访问 http://127.0.0.1:8719/，任务保存到 `data/bilibili-tool/`。Web 版默认使用 Chrome Cookie；**Skill 版默认匿名**。两者的能力和默认配置不能混为一谈。详情见 [Web 工具说明](bilibili-transcriber-tool/README.md)。

## 开发与验证

```sh
python3 -m unittest discover -s tests
```

已验证：Skill 结构、脚本链接校验、模拟失败恢复和复用音频流程、Codex 安装器下载到隔离目录、安装后 doctor 执行。

尚未完成：三端全新机器的完整安装到转录验收、Claude Code 实际调用、WorkBuddy 客户端导入及自然语言自动安装。测试中的下载与转录流程使用 mock，不代表发布包已在三端跑通真实视频。

欢迎通过 Issues 提交问题：附平台、系统、版本、失败阶段及脱敏错误信息；不要上传 Cookie、浏览器数据库或其他凭证。

## 许可证

[MIT](LICENSE)。依赖及模型遵循各自许可证；请仅下载和处理你有权使用的内容。本项目不提供绕过付费或访问控制的能力。
