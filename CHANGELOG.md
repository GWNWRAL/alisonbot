# 更新日志

本项目所有值得注意的变更都会记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026

首个公开版本。这一版的核心变化是把项目从「一个功能齐全的程序」改造成「微内核 + 一切皆插件」。

### 新增

#### 架构

- **微内核**：新增 `koishi-plugin-alison-core`，作为框架层提供插件清单规范、平台适配注册表、对话拦截器链、配置热更新与热重载、插件生命周期管理。内核不再承载具体业务能力。
- **一切皆插件**：网页 UI、QQ 接入、引导、自治、热更新、人设全部拆分为独立插件，可按需启用与禁用。
- **平台适配注册表**：对话平台经统一注册表挂载，新增平台不需要修改内核。

#### 插件

- `koishi-plugin-alison-platform-web`：网页聊天 UI 与控制中心（用量 / 记忆 / 插件）及系统设置。
- `koishi-plugin-alison-platform-qq`：QQ 接入，基于 OneBot v11 协议，可对接 NapCat / LLOneBot / SnowLuma 等实现。
- `koishi-plugin-alison-onboarding`：首次部署引导。Alison 主动发起对话，逐步问出 LLM API Key、测试连通、写入配置并生效，随后询问平台与能力开关。
- `koishi-plugin-alison-autonomy`：自治能力。Alison 可自己改配置、自己装插件、自己体检修复。
- `koishi-plugin-alison-hotreload`：热更新。改配置或更换预设无需重启，进程内热应用。
- `koishi-plugin-alison-preset`：人设插件化。系统提示词与人设以插件形式安装与替换。

#### 能力

- **对话式引导**：首次部署不再需要手工编辑配置文件，全部经对话完成。
- **热更新与热配置**：`workspace/alison.yml`、对话内修改、控制中心修改三种途径均进程内生效；仅少数需要整体重建的改动（如 ChatLuna 预设的会话级缓存）会提示重启。
- **插件自装自修**：插件启用/禁用、安装新插件由 Alison 自己完成。
- **多平台插件兼容**：新增 Python 插件兼容桥，支持 AstrBot、NoneBot2、MaiBot（maibot_sdk）的命令子集与 LangBot 4.x 的尽力而为兼容；Python 插件统一放在 `workspace/plugins/py/<框架>/<插件名>/`，需要本机 Python 3.9 及以上。
- **MCP 接入**：安装 `koishi-plugin-chatluna-mcp-client` 并填写 `mcpServers` JSON，即可接入任意 MCP server 的工具。
- **桌面控制台**：桌面端运行入口与状态显示。
- **应用图标**：为桌面端与安装包提供统一图标。

#### 分发

- **Windows 安装器**：`Alison-Setup-0.0.1.exe`，向导可选安装位置与工作区位置。
- **Windows 便携版**：`Alison-Windows-便携版-0.0.1.zip`，解压后双击 `Alison.exe` 启动。
- **macOS 包**：`Alison-macOS-arm64-0.0.1.zip`（Apple Silicon）与 `Alison-macOS-x64-0.0.1.zip`（Intel）。
- **源码运行**：Windows 使用 `install.cmd` / `start.cmd`，macOS 使用 `install-mac.sh`，需要 Node 20 及以上。

### 变更

- **项目改名**：项目更名为 **AlisonBot**，文档、安装包与可执行文件名同步更新。
- **架构调整**：原有内置能力迁移为插件，主程序职责收窄为内核与运行环境。
- **部署体验调整**：默认推荐流程由「先改配置再启动」改为「先启动，由 Alison 引导配置」。
- **文档重构**：中文主文档、英文 README 与 7 篇专题文档一并产出。
- **许可证**：以 MIT 许可证发布，版权行为 `Copyright (c) 2026 GWNWRAL`。

### 修复

- 修复首次部署缺少模型凭据时无法进入对话的问题：现在改为由 Alison 主动发起引导。
- 修复修改配置后必须重启才能生效的问题：常见配置项改为热更新。
- 修复启用/禁用插件需要手工编辑配置的问题：改由对话或控制中心完成。

### 已知限制

- **mirai-console 插件未支持**：Java / Kotlin 插件需要 JVM 旁路，属于规划中，当前版本无法加载。
- **LangBot 4.x 为尽力而为**：组件式插件只能部分兼容，完整语义需要官方 Plugin Runtime。
- **兼容桥只覆盖命令注册层**：AstrBot、NoneBot2、MaiBot 的兼容实现精确支持「注册命令」这一层 API，其余 API 由宽容桩（auto-stub）兜底。因此插件能加载到注册阶段、「命令 → 文本回复」可用，但依赖完整运行时的插件无法正常工作。
- **Python 插件有环境前提**：需要本机 Python 3.9 及以上；未安装 Python 时 Python 插件不可用。
- **部分改动仍需重启**：例如 ChatLuna 预设的会话级缓存，属于需要整体重建的改动。
- **0.0.1 为早期版本**：接口、配置键与插件清单字段仍可能调整，请以仓库中的实际定义为准。
- **第三方依赖各自的限制**：Koishi 4.18 与 ChatLuna 1.4 的行为与缺陷由上游项目决定，本项目不做修改承诺。

[0.0.1]: https://github.com/GWNWRAL/alisonbot/releases/tag/v0.0.1
