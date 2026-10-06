# AlisonBot

> 微内核 + 一切皆插件 · 可自托管的聊天机器人

AlisonBot 是一个自托管的聊天机器人项目。它自身只提供**微内核、核心插件与桌面运行环境**，其余能力全部以插件形式安装：对话平台是插件、人设是插件、自治能力是插件、热更新是插件，第三方生态（Koishi 插件、ChatLuna 模型适配器、MCP server、多平台 Python 插件）也照常接入。

- 当前版本：**0.0.1**
- 许可证：MIT（见 [LICENSE](LICENSE)）
- 仓库：<https://github.com/GWNWRAL/alisonbot>
- 底层依赖：**Koishi 4.18** 内核与 **ChatLuna 1.4**（均为第三方开源项目，遵循各自的许可证，不属于 AlisonBot 自身代码）

---

## 目录

- [这是什么](#这是什么)
- [特性一览](#特性一览)
- [架构总览](#架构总览)
- [快速开始](#快速开始)
- [首次部署与对话引导](#首次部署与对话引导)
- [目录结构](#目录结构)
- [配置说明](#配置说明)
- [插件体系与多平台兼容](#插件体系与多平台兼容)
- [自治能力](#自治能力)
- [控制中心](#控制中心)
- [常见问题](#常见问题)
- [文档索引](#文档索引)
- [许可](#许可)

---

## 这是什么

传统聊天机器人的做法是「一个主程序，功能越堆越多」。AlisonBot 反过来：主程序只做框架，功能全部外置。

- **微内核**：`koishi-plugin-alison-core` 定义插件清单规范、平台适配注册表、对话拦截器链、配置热更新与热重载、插件生命周期。内核本身不包含任何具体业务能力。
- **一切皆插件**：网页聊天 UI 是插件，QQ 接入是插件，人设是插件，自治是插件，热更新是插件。禁用某个插件，对应能力就干净地消失。
- **可自治**：装上 `koishi-plugin-alison-autonomy` 后，Alison 可以在你的授权下自己改配置、自己装插件、自己体检修复。
- **零配置上手**：还没填 API Key 时，Alison 会**先开口**，用对话一步步问出模型、Key、平台与要装的能力，写进配置并当场验证。

AlisonBot 不是 Koishi 或 ChatLuna 的分支，而是构建在它们之上的发行版与插件集合。Koishi 提供机器人框架能力，ChatLuna 提供大模型对话能力，AlisonBot 提供微内核约定、对话式引导、自治与热更新体验。

## 特性一览

| 特性 | 说明 | 状态 |
| --- | --- | --- |
| 微内核架构 | 内核只含框架，业务能力全部插件化 | 0.0.1 提供 |
| 网页聊天与控制中心 | 浏览器内聊天、用量、记忆、插件、系统设置 | 0.0.1 提供 |
| QQ 接入 | OneBot v11 协议，可接 NapCat / LLOneBot / SnowLuma 等实现 | 0.0.1 提供 |
| 对话式首次引导 | Alison 主动发问，问出 Key 并当场测试生效 | 0.0.1 提供 |
| 配置热更新 | 改 `alison.yml` 或改设置无需重启 | 0.0.1 提供 |
| 插件热重载 | 启用/禁用、安装新插件由 Alison 自己完成 | 0.0.1 提供 |
| 自治能力 | 自改配置、自装插件、自检修复 | 0.0.1 提供 |
| 人设插件化 | 系统提示词与人设以插件形式安装/替换 | 0.0.1 提供 |
| MCP 接入 | 装 `koishi-plugin-chatluna-mcp-client`，填 `mcpServers` 即可 | 0.0.1 提供 |
| 多平台 Python 插件 | AstrBot / NoneBot2 / MaiBot 命令子集，LangBot 尽力而为 | 0.0.1 提供（程度不同） |
| mirai-console 插件 | 需要 JVM 旁路 | 规划中 |
| 桌面控制台 | 桌面端运行入口与状态显示 | 0.0.1 提供 |

> 「状态」一列只描述当前版本实际具备的能力。标注「规划中」的功能尚未实现，请勿按已可用对待。

## 架构总览

文字版目录树（概念结构，用于说明分层；真实文件名以仓库为准）：

```text
AlisonBot
├── 内核层
│   └── koishi-plugin-alison-core        # 微内核：插件清单规范 / 平台适配注册表 /
│                                        # 对话拦截器链 / 配置热更新与热重载 / 插件生命周期
├── 平台层（对话平台插件）
│   ├── koishi-plugin-alison-platform-web    # 网页聊天 UI + 控制中心 + 系统设置
│   └── koishi-plugin-alison-platform-qq     # QQ（OneBot v11，可接 NapCat / LLOneBot / SnowLuma）
├── 体验层
│   ├── koishi-plugin-alison-onboarding      # 首次部署对话式引导
│   ├── koishi-plugin-alison-autonomy        # 自治：自改配置 / 自装插件 / 自检修复
│   ├── koishi-plugin-alison-hotreload       # 热更新：进程内热应用
│   └── koishi-plugin-alison-preset          # 人设：系统提示词与人设插件化
├── 第三方生态（照常接入）
│   ├── Koishi 生态插件
│   ├── ChatLuna 模型适配器（deepseek / qwen / 任意 OpenAI 兼容网关）
│   └── MCP server（经 koishi-plugin-chatluna-mcp-client）
└── 运行环境
    ├── 桌面控制台（Windows / macOS 双击启动）
    └── workspace/                           # 运行时数据、配置与插件目录
```

调用链示意：

```text
用户消息
  → 平台插件（web / qq）收到消息
  → 内核：对话拦截器链（按顺序经过各插件的拦截器）
  → ChatLuna：模型调用（可经 MCP 工具、模型适配器）
  → 人设插件：注入系统提示词
  → 回复经拦截器链返回
  → 平台插件把回复发给用户
```

## 快速开始

### 方式一：Windows

两种形态，任选其一：

- **安装程序**：`Alison-Setup-0.0.1.exe`。向导中可选择安装位置与工作区位置，安装完成后从开始菜单或桌面启动。
- **便携版**：`Alison-Windows-便携版-0.0.1.zip`。解压到任意目录（例如 `D:\Alison`），双击 `Alison.exe` 启动。

```text
解压示例（便携版）：
D:\Alison\Alison.exe
```

### 方式二：macOS

按芯片选择安装包：Apple Silicon 用 `Alison-macOS-arm64-0.0.1.zip`，Intel 用 `Alison-macOS-x64-0.0.1.zip`。

```bash
# Apple Silicon（arm64）
curl -L -o Alison-macOS-arm64-0.0.1.zip \
  https://github.com/GWNWRAL/alisonbot/releases/download/v0.0.1/Alison-macOS-arm64-0.0.1.zip
unzip Alison-macOS-arm64-0.0.1.zip -d Alison && cd Alison
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh && ./"启动 Alison.command"
```

Intel 机器把文件名换成 `Alison-macOS-x64-0.0.1.zip` 即可。

### 方式三：源码运行

需要 **Node.js 20 或更高版本**。

| 系统 | 安装依赖 | 启动 |
| --- | --- | --- |
| Windows | `install.cmd` | `start.cmd` |
| macOS | `./install-mac.sh` | `./"启动 Alison.command"` |

```bash
# macOS 源码方式
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh
./"启动 Alison.command"
```

安装与启动的详细步骤、目录选择、卸载与排错，见 [docs/01-安装-Windows.md](docs/01-安装-Windows.md) 与 [docs/02-安装-macOS.md](docs/02-安装-macOS.md)。

## 首次部署与对话引导

装好或解压后启动，然后任选一种方式找 Alison：

1. 浏览器打开 <http://127.0.0.1:5140/alison>
2. 或者直接用 QQ 私聊她（已配置 QQ 平台时）

因为还没有 API Key，**Alison 会先开口**。她不会让你去翻配置文件，而是像聊天一样问：

```text
Alison：你好，我是 Alison。我还没拿到大模型的钥匙，
        先聊两句把它配好——你打算用哪家的模型？
你　　：deepseek
Alison：好。把 API Key 贴给我吧，我写进配置后立刻测一次连通。
你　　：sk-你的Key
Alison：正在测试……通过了 ✅ 已经生效。
        接下来想接哪个平台？网页聊天已经可用，要不要再加 QQ？
你　　：先网页吧
Alison：好。还想开哪些能力？记忆、日记、好感度，都可以现在决定。
```

引导流程大致是：

1. 询问使用哪家模型（deepseek / qwen / 任意 OpenAI 兼容网关等）
2. 索取 API Key，写入配置
3. **当场测试连通**，失败则反馈原因并重试
4. 询问要接入的平台：网页 / QQ
5. 询问要开启的能力：记忆、日记、好感度
6. 询问是否安装某个插件
7. 全部落实后进入正常聊天

全程不需要手动改配置文件。想手动改也可以，配置在 `workspace/alison.yml`，改完由热更新生效。完整引导脚本与示例对话见 [docs/03-首次部署与对话引导.md](docs/03-首次部署与对话引导.md)。

## 目录结构

以下是运行时工作区（`workspace/`）的结构示意：

```text
workspace/
├── alison.yml                    # 主配置：模型、平台、能力开关等
├── plugins/
│   ├── alison/                   # Alison 插件规范（ICE 规范）插件目录
│   │   └── <名字>/
│   │       └── plugin.json       # 插件清单（详见仓库中的规范定义）
│   └── py/                       # 多平台 Python 插件
│       └── <框架>/               # astrbot / nonebot2 / maibot / langbot ...
│           └── <插件名>/
├── data/                         # 运行数据（记忆、日志等，随版本变化）
└── ...
```

> Alison 插件规范（ICE 规范）中 `plugin.json` 的具体字段以仓库中的规范定义为准；本文档不重复定义，避免与实际实现脱节。

## 配置说明

主配置是 `workspace/alison.yml`。下面是一份**结构示例**，用于说明它大致长什么样——具体键名、默认值与可选值请以仓库中的配置定义为准：

```yaml
# workspace/alison.yml（结构示例，字段以实际版本为准）
model:
  provider: deepseek              # 模型提供方
  apiKey: sk-你的Key               # 请不要把真实 Key 提交到公开仓库
  baseURL: ''                     # OpenAI 兼容网关可在此填写

platform:
  web:
    enabled: true                 # 网页聊天与控制中心
    host: 127.0.0.1
    port: 5140
  qq:
    enabled: false                # OneBot v11
    protocol: onebot11

features:
  memory: false                   # 记忆
  diary: false                    # 日记
  favorability: false             # 好感度

plugins:
  enabled: []                     # 额外启用的插件
```

修改方式有三种，效果一致：

1. 直接编辑 `workspace/alison.yml`
2. 在对话里让 Alison 改
3. 在控制中心的系统设置里改

改完**进程内直接生效，不需要重启**。少数需要整体重建的改动（例如 ChatLuna 预设的会话级缓存）会提示你重启。详见 [docs/06-热更新与自治能力.md](docs/06-热更新与自治能力.md)。

## 插件体系与多平台兼容

AlisonBot 的插件分四类：

1. **Alison 插件（ICE 规范）**：放在 `workspace/plugins/alison/<名字>/`，含 `plugin.json` 清单。
2. **Koishi 插件**：Koishi / ChatLuna 生态插件，装完即用；ChatLuna 的模型适配器（deepseek / qwen / 任意 OpenAI 兼容网关）也在这里。
3. **多平台 Python 插件**：放在 `workspace/plugins/py/<框架>/<插件名>/`，经兼容桥加载，需要本机 **Python 3.9+**。
4. **MCP server**：装 `koishi-plugin-chatluna-mcp-client`，填入 `mcpServers` JSON，即可接入任意 MCP server 的工具。

### 兼容矩阵

| 平台 | 语言 | 兼容程度 |
| --- | --- | --- |
| Koishi / ChatLuna | JS | 原生：直接装、直接跑 |
| MCP（Model Context Protocol） | 任意 | 原生：装 `koishi-plugin-chatluna-mcp-client`，填 `mcpServers` JSON 即可接入任意 MCP server 的工具 |
| AstrBot | Python | 命令子集：`@filter.command` 等，走兼容桥 |
| NoneBot2 | Python | 命令子集：`on_command` / `on_keyword` / `on_startswith` / `on_message` |
| MaiBot（maibot_sdk） | Python | 命令子集：`@Command` / `@Action` / `@Tool` |
| LangBot 4.x | Python | 尽力而为：组件式，完整语义需要官方 Plugin Runtime |
| mirai-console | Java / Kotlin | 未支持（需要 JVM 旁路，规划中） |

### 兼容桥的原理与边界

兼容桥只**精确实现「注册命令」这一层 API**，其余 API 用宽容桩（auto-stub）兜底。这样插件能顺利加载到注册阶段，「命令 → 文本回复」这条链路可用。

明确做不到的事：依赖完整运行时的插件不行。也就是说，一个插件的价值如果主要来自框架特有的调度、持久化、事件总线或平台专有对象，兼容桥只能让它「加载成功」，无法让它「行为完整」。

详细说明与示例见 [docs/05-插件体系与多平台兼容.md](docs/05-插件体系与多平台兼容.md)。

## 自治能力

装上 `koishi-plugin-alison-autonomy` 后，Alison 具备三类自治动作：

- **自改配置**：例如「把回复长度限制调短一点」，她改 `alison.yml` 并热生效。
- **自装插件**：例如「给我加个搜图能力」，她安装对应插件并启用。
- **自检修复**：例如某个平台连不上，她检查配置与依赖并尝试修复。

自治不等于放任。它是**在你授权范围内**的动作，具体边界（哪些动作需要确认、哪些可以自行执行）见 [docs/06-热更新与自治能力.md](docs/06-热更新与自治能力.md)。

## 控制中心

控制中心是网页平台插件的一部分，地址与聊天页相同：<http://127.0.0.1:5140/alison>。

| 面板 | 用途 |
| --- | --- |
| 聊天 | 与 Alison 对话，等价于 QQ 私聊 |
| 用量 | 查看调用量与开销情况 |
| 记忆 | 查看与管理她记住的内容 |
| 插件 | 查看、启用、禁用、安装插件 |
| 系统设置 | 模型、平台、能力开关等设置 |

各面板的具体字段以实际界面为准，说明见 [docs/04-控制中心与系统设置.md](docs/04-控制中心与系统设置.md)。

## 常见问题

**Q：需要自己装 Koishi 或 ChatLuna 吗？**
不需要。发行包已经内置 Koishi 4.18 与 ChatLuna 1.4 的运行环境；源码方式由 `install.cmd` / `install-mac.sh` 负责拉取依赖。

**Q：一定要有 API Key 才能启动吗？**
能启动，但还不会聊天。首次部署时 Alison 会主动问你要 Key，测试通过后才算配好。

**Q：改配置要重启吗？**
绝大多数不用。改 `alison.yml`、通过对话改、在控制中心改，都是进程内热生效。只有少数需要整体重建的改动（例如 ChatLuna 预设的会话级缓存）会提示重启。

**Q：能同时接网页和 QQ 吗？**
可以。网页与 QQ 都是平台插件，可同时启用。

**Q：Python 插件需要什么环境？**
本机需要 Python 3.9 或更高版本；插件放在 `workspace/plugins/py/<框架>/<插件名>/`。

**Q：LangBot 插件能完整用吗？**
不能保证。LangBot 4.x 是尽力而为的兼容，组件式插件涉及完整语义时需要官方 Plugin Runtime。

**Q：mirai-console 插件呢？**
当前版本未支持，需要 JVM 旁路，属于规划中。

**Q：端口 5140 被占用了怎么办？**
在 `workspace/alison.yml` 的 `platform.web.port` 改一个空闲端口，或让 Alison 帮你改，然后访问新端口下的 `/alison`。

**Q：macOS 提示无法验证开发者怎么办？**
按系统提示在「系统设置 → 隐私与安全性」中允许打开即可（具体提示文案随系统版本不同）。详见 [docs/02-安装-macOS.md](docs/02-安装-macOS.md)。

**Q：会不会把我的 Key 传出去？**
Key 写在你本机的 `workspace/alison.yml` 里，仅用于你配置的模型服务。请不要把真实 Key 写进任何公开仓库或截图。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/01-安装-Windows.md](docs/01-安装-Windows.md) | Windows 安装程序、便携版与源码运行 |
| [docs/02-安装-macOS.md](docs/02-安装-macOS.md) | macOS arm64 / x64 安装与启动 |
| [docs/03-首次部署与对话引导.md](docs/03-首次部署与对话引导.md) | 引导的每一步与示例对话 |
| [docs/04-控制中心与系统设置.md](docs/04-控制中心与系统设置.md) | 聊天、用量、记忆、插件、系统设置 |
| [docs/05-插件体系与多平台兼容.md](docs/05-插件体系与多平台兼容.md) | 四类插件与兼容矩阵、兼容桥边界 |
| [docs/06-热更新与自治能力.md](docs/06-热更新与自治能力.md) | 热配置、热重载、自检修复的边界 |
| [docs/07-打包与发布.md](docs/07-打包与发布.md) | 产物命名、校验与发布流程 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [README_EN.md](README_EN.md) | English README（精简版） |

## 许可

AlisonBot 以 **MIT 许可证**发布，版权归 `Copyright (c) 2026 GWNWRAL`，完整文本见 [LICENSE](LICENSE)。

第三方依赖（Koishi 4.18、ChatLuna 1.4、各模型适配器、MCP 客户端、Koishi 生态插件等）遵循各自项目的许可证，使用时请一并遵守。
