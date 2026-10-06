# AlisonBot v0.0.1 —— 审阅与发布清单

> 这份文件是给**项目作者本人**看的：本次改造做了什么、怎么验收、发布前要确认什么。
> 正式对外文档是 [README.md](README.md) 与 [docs/](docs/)。

---

## 一、这次改造的对照表（旧 → 新）

| 方面 | 改造前（ICE） | 改造后（AlisonBot） |
|---|---|---|
| 项目名 | ice-standalone | **alisonbot** |
| 结构 | 单一大工程 + 若干插件 | **微内核 + 一切皆插件**：框架只做注册表/热更新/配置 |
| 插件命名 | `koishi-plugin-ice-*` | `koishi-plugin-alison-core` / `-platform-web` / `-onboarding` / `-autonomy` / `-hotreload` / `-github` |
| UI | 内置在 webui 插件里 | `alison-platform-web` **插件**（对话平台，可换） |
| 人设 | 写在预设里 | `alison-preset` 概念 + 引导生成，**答案实时写进系统提示词** |
| 首次部署 | 手动改 YAML | **Alison 人格先行、选项式对话引导**，一步步问出来 |
| 配置 | 重启生效 | **热更新**：改文件/改接口立即生效；插件目录丢文件即热加载 |
| 依赖 | 39 个 | **26 个**（去掉 console/affinity/livingdiary/memesluna/toolbox 等 12 个） |
| node_modules | 187 MB | **140 MB** |
| 安装器 | 111 MB | **81.5 MB** |
| 自身能力 | 改配置 / 装插件 / 自修复 | 再加：**GitHub 检索与自装插件、改自己的插件代码（scaffold/selfedit）** |
| 插件生态 | Koishi + AstrBot | Koishi + **MCP** + AstrBot/NoneBot2/MaiBot/LangBot |

---

## 二、建议的审阅顺序

1. `README.md` —— 是什么、特性、三种安装、引导流程（340 行）
2. `docs/03-首次部署与对话引导.md` —— 第一次打开时 Alison 会怎么问、你该怎么答
3. `docs/05-插件体系与多平台兼容.md` —— 四类插件 + 兼容矩阵 + 兼容桥边界
4. `docs/06-热更新与自治能力.md` —— 什么能热、什么必须重启
5. `CHANGELOG.md` —— 本次全部变更与已知限制
6. 代码：`local-plugins/koishi-plugin-alison-core/lib/index.cjs`（微内核，最值得看）

---

## 三、脱敏证据（发布版不含个人隐私）

- 生成方式：`node installer/alison-sanitize.cjs`（源码 → 脱敏树 `D:\Alison\release\alisonbot`）
- 结果：**API Key 字段清空 10 处、身份/白名单替换 4 处、本机路径 0 处、复查零残留**
- **安装包实测复查**：工作区内 `koishi.db` 不存在、真实 Key **0** 个、真实 QQ **0** 个、GitHub token **0** 个
- 预设里 `scopeId: ice1`、`ice_*` 工具名**故意保留**（改了会和老数据/调用对不上）

---

## 四、发布产物与校验和

| 产物 | 大小 | SHA256 |
|---|---:|---|
| `Alison-Setup-0.0.1.exe` | 81.5 MB | `ca778a6688be8918…` |
| `Alison-Windows-便携版-0.0.1.zip` | 81.5 MB | `b14aca6e58f78951…` |
| `Alison-macOS-arm64-0.0.1.zip` | 30.7 MB | `2b21eb20e1e94977…` |
| `Alison-macOS-x64-0.0.1.zip` | 32.3 MB | `41447b32b758ea3a…` |
| `alisonbot-0.0.1-src.zip` | 1.7 MB | `e0650e8af98fa3d1…` |

（完整哈希见同目录 `*.sha256` 侧车。）

---

## 五、自己验收（三条命令）

```powershell
# 1) 静默安装到临时目录（不碰现有安装）
& 'D:\Alison\releases\Alison-Setup-0.0.1.exe' /S /INSTALLDIR=D:\Alison\_check /WORKSPACE=D:\Alison\_check-ws /NOLAUNCH

# 2) 用测试配置启动（不连 QQ、端口 5199）：把工作区里的 alison.test.yml 复制成 alison.yml
#    然后双击 D:\Alison\_check\Alison.exe；浏览器开 http://127.0.0.1:5199/alison
#    首次打开应该是 Alison 先说话，给 5 个性格选项

# 3) 卸载（保留工作区数据）
& 'D:\Alison\_check\uninstall.exe' /S
```

---

## 六、发布（等你点头）

```powershell
# 只检查不写入
& 'D:\Alison\release\alisonbot\tools\publish.ps1' -DryRun -TokenFile D:\Alison\.gh-token.txt -AssetsDir D:\Alison\releases

# 正式发布：建 public 仓库 GWNWRAL/alisonbot → 推源码 → 发 v0.0.1 正式 Release → 逐项校验
& 'D:\Alison\release\alisonbot\tools\publish.ps1' -TokenFile D:\Alison\.gh-token.txt -AssetsDir D:\Alison\releases
```

想改仓库名/描述/话题，改 `tools/publish.ps1` 顶部的 `$Owner` `$Repo`，或直接说一声。

---

## 七、已知限制（v0.0.1，如实列出）

### 已验证的兼容性（补记）

- **MCP 兼容已实测**：填 `chatluna-mcp-client.servers`（Claude Desktop 的 `mcpServers` 格式）后，MCP 服务器的工具会注册进 ChatLuna（实测：接最小 stdio MCP server，工具数 17 → 19；日志 `MCP client initialized successfully with 2 tool(s) available`）。
- **网页端工具调用已打通**（直连模式）：对 OpenAI 兼容平台，网页聊天直接用 `@langchain/openai` 建模型并绑定工具（ChatLuna 的包装器会用它自己那套工具，`bindTools` 不生效，所以走直连）。实测两条：
  - `alison_repair({"action":"diagnose"})` → 真实返回 8 项体检结果，Alison 复述准确；
  - `alison_demo_echo({"text":"AlisonBot 工具链已打通"})` → **MCP 工具**在网页聊天里被真实调用并返回结果。
  - 非 OpenAI 兼容平台仍走 ChatLuna 原生路径（工具能力取决于该平台）。
- **模型下拉**：「系统设置 → 模型」从 `/alison/api/models` 拉取后端真实注册的模型（实测某网关端点只提供 `deepseek-flash / deepseek-v4-pro*`，并没有 `deepseek-chat`）。
