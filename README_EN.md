# AlisonBot

> A microkernel, plugin-everything, self-hosted chatbot.

AlisonBot is a self-hosted chatbot distribution. The project itself ships only a **microkernel, core plugins, and a desktop runtime**; everything else is a plugin — chat platforms, personas, autonomy, and hot reload included. Third-party ecosystems plug in as usual.

- Version: **0.0.1**
- License: MIT — see [LICENSE](LICENSE)
- Repository: <https://github.com/GWNWRAL/alisonbot>
- Built on **Koishi 4.18** and **ChatLuna 1.4** — third-party open-source dependencies under their own licenses, not part of AlisonBot itself.

## Features

| Feature | Description |
| --- | --- |
| Microkernel | The core holds the framework only; every capability is a plugin |
| Web chat + control center | Chat, usage, memory, plugins, and system settings in the browser |
| QQ platform | OneBot v11; works with NapCat / LLOneBot / SnowLuma and similar |
| Conversational onboarding | Alison asks first, collects the API key, tests it, applies it |
| Hot config and hot reload | Edit `alison.yml` or settings; enable/disable/install plugins in-process |
| Autonomy | Alison edits config, installs plugins, self-checks and repairs |
| Persona as plugin | System prompt and persona installed or replaced as a plugin |
| MCP support | Install `koishi-plugin-chatluna-mcp-client`, fill in `mcpServers` |
| Multi-platform Python plugins | AstrBot / NoneBot2 / MaiBot command subsets; LangBot best-effort |
| Desktop console | Desktop entry point and status display |
| mirai-console plugins | Not supported — needs a JVM sidecar (planned) |

## Architecture

Conceptual layout; real file names are defined in the repository.

```text
AlisonBot
├── koishi-plugin-alison-core            # microkernel: manifest spec, platform registry, hot reload
├── koishi-plugin-alison-platform-web    # web chat UI + control center + settings
├── koishi-plugin-alison-platform-qq     # QQ (OneBot v11)
├── koishi-plugin-alison-onboarding      # first-run conversational onboarding
├── koishi-plugin-alison-autonomy        # self-config, self-install, self-repair
├── koishi-plugin-alison-hotreload       # in-process hot apply
├── koishi-plugin-alison-preset          # system prompt and persona as a plugin
└── third-party: Koishi plugins, ChatLuna model adapters, MCP servers, Python plugins
```

## Quick start

**Windows** — installer `Alison-Setup-0.0.1.exe` (the wizard lets you choose the install location and workspace), or portable `Alison-Windows-便携版-0.0.1.zip` (extract and double-click `Alison.exe`).

**macOS** — pick your chip, `arm64` for Apple Silicon or `x64` for Intel:

```bash
curl -L -o Alison-macOS-arm64-0.0.1.zip \
  https://github.com/GWNWRAL/alisonbot/releases/download/v0.0.1/Alison-macOS-arm64-0.0.1.zip
unzip Alison-macOS-arm64-0.0.1.zip -d Alison && cd Alison
chmod +x install-mac.sh "启动 Alison.command"
./install-mac.sh && ./"启动 Alison.command"
```

**From source** — Node.js 20 or newer required: `install.cmd` / `start.cmd` on Windows, `./install-mac.sh` on macOS.

## First run

1. Start AlisonBot.
2. Open <http://127.0.0.1:5140/alison>, or send her a QQ direct message.
3. With no API key configured, **Alison speaks first**: she asks which model provider you want, asks you to paste the API key, writes it to the config, tests connectivity on the spot, then asks which platform (web / QQ), which capabilities (memory, diary, favorability), and whether to install a given plugin.

No manual config editing is required. The full onboarding script is in [docs/03-首次部署与对话引导.md](docs/03-首次部署与对话引导.md) (Chinese).

## Configuration

The main configuration file is `workspace/alison.yml`. Exact keys and defaults are defined in the repository; the shape below is illustrative.

```yaml
model:    { provider: deepseek, apiKey: sk-你的Key, baseURL: '' }
platform:
  web:    { enabled: true,  host: 127.0.0.1, port: 5140 }
  qq:     { enabled: false, protocol: onebot11 }
features: { memory: false, diary: false, favorability: false }
```

Change settings three equivalent ways: edit the file, ask Alison in chat, or use the control center. Most changes apply in-process; a few that need a full rebuild (such as ChatLuna's session-level preset cache) ask you to restart.

## Plugins and compatibility

1. **Alison plugins (ICE spec)** — `workspace/plugins/alison/<name>/plugin.json`.
2. **Koishi plugins** — native; ChatLuna model adapters live here too.
3. **Multi-platform Python plugins** — `workspace/plugins/py/<framework>/<plugin>/`, loaded through a compatibility bridge; requires Python 3.9+ locally.
4. **MCP servers** — install `koishi-plugin-chatluna-mcp-client` and provide `mcpServers` JSON.

| Platform | Language | Compatibility |
| --- | --- | --- |
| Koishi / ChatLuna | JS | Native — install and run |
| MCP (Model Context Protocol) | Any | Native — install `koishi-plugin-chatluna-mcp-client`, fill in `mcpServers` |
| AstrBot | Python | Command subset: `@filter.command` and similar, via the bridge |
| NoneBot2 | Python | Command subset: `on_command` / `on_keyword` / `on_startswith` / `on_message` |
| MaiBot (maibot_sdk) | Python | Command subset: `@Command` / `@Action` / `@Tool` |
| LangBot 4.x | Python | Best-effort: component-style; full semantics need the official Plugin Runtime |
| mirai-console | Java / Kotlin | Not supported (needs a JVM sidecar; planned) |

The bridge implements the **command registration layer** precisely and falls back to permissive auto-stubs for everything else. Plugins therefore load up to the registration stage, and "command → text reply" works; plugins that depend on a full runtime do not.

## Control center and autonomy

The control center ships with the web platform plugin at <http://127.0.0.1:5140/alison>: chat, usage, memory, plugins, and system settings.

With `koishi-plugin-alison-autonomy` enabled, Alison can edit her own configuration, install plugins, and run self-checks and repairs — within the scope you grant her ([boundaries](docs/06-热更新与自治能力.md), Chinese).

## FAQ

- **Do I need to install Koishi or ChatLuna myself?** No; release packages bundle the runtime, source installs fetch dependencies.
- **Can it run without an API key?** It starts, but cannot chat until Alison has collected and verified one.
- **Do config changes need a restart?** Almost never; only changes requiring a full rebuild prompt one.
- **What do Python plugins require?** Python 3.9+ locally, plugins under `workspace/plugins/py/<framework>/<plugin>/`.

## Documentation

The full documentation set is currently written in Chinese: [README.md](README.md) plus [docs/01-安装-Windows.md](docs/01-安装-Windows.md), [docs/02-安装-macOS.md](docs/02-安装-macOS.md), [docs/03-首次部署与对话引导.md](docs/03-首次部署与对话引导.md), [docs/04-控制中心与系统设置.md](docs/04-控制中心与系统设置.md), [docs/05-插件体系与多平台兼容.md](docs/05-插件体系与多平台兼容.md), [docs/06-热更新与自治能力.md](docs/06-热更新与自治能力.md), [docs/07-打包与发布.md](docs/07-打包与发布.md), and [CHANGELOG.md](CHANGELOG.md).

## License

MIT — `Copyright (c) 2026 GWNWRAL`. See [LICENSE](LICENSE). Third-party dependencies remain under their own licenses.
