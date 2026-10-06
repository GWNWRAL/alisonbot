# koishi-plugin-alison-hotreload

让 Alison（Koishi / ChatLuna）能**自己重启自己**、**自己重载配置**。

以前只能这样：改完 `koishi.yml` → 写一条「请用户从托盘退出」→ 或者起一个 `taskkill /F` 脚本。
强杀 node 对 SQLite（`koishi.db`）有小概率风险，而且一旦重启失败，Alison 就没了、也没人知道。

这个插件把这件事变成两个工具：

| 工具 | 作用 |
|---|---|
| `alison_restart` | 预约一次自重启。**先**把这一轮回复发出去，延迟到了才重启 |
| `alison_reload` | **不重启、不断线**地热重载 `koishi.yml`（进程内 reload），或校验 / 重读角色预设 |
| `alison_self_status` | 自己的 pid / 运行时长 / 端口 / 配置指纹 / 上次重启与上次重载的结果 |

## 它到底怎么重启的

三条路，一条比一条重，**自动升级**：

```
Alison 调 alison_restart
      │
      ├─ ① 校验 koishi.yml + Alison.yml（YAML 解析失败就直接拒绝，配置一个字不动）
      ├─ ② 备份 koishi.yml → <数据根>/backups/koishi.yml.bak-selfop-restart-<时间戳>
      ├─ ③ spawn 一个 detached 的助手进程 lib/restart-helper.js（脱离 Koishi 的进程树与控制台）
      │     并且等它写回 ready 文件 —— 「排期成功」是可验证的，不是「以为 spawn 成功了」
      └─ ④ 立刻返回，Alison 正常把回复发出去
                    │
        （delay 秒后）│
                    ▼
   台阶一（默认，mode=app）**进程内自重启**
        ctx.root.stop() → 所有 dispose 跑完 → loader 在 root 上的
        app.on('dispose') → fullReload() → process.exit(51)
        → `koishi start` 看到 51 **原地重新 fork 一个 worker**
        （3 秒还没带走 → 再叫一次 fullReload；6 秒还没带走 → 直接 process.exit(51)）
                    │ 30 秒内端口没断过，或断了没回来
                    ▼
   台阶二（mode=launcher）**启动器重启**：koi restart <instance>（= 托盘菜单「重启」）
                    │ 还是不行
                    ▼
   台阶三（mode=legacy，默认关）旧脚本：taskkill /F + 启动脚本
                    │ 还是不行
                    ▼
   台阶四 跑 tools/启动Alison.cmd 兜底（幂等：已在跑就跳过）
                    │
                    ▼
        结果写进 data/alison-hotreload/last-restart.json（走了哪条路、成没成、为什么）
```

`restartMode` 可以写死成 `app` / `launcher` / `legacy`；`auto`（默认）先看自己能不能自重启。

几个刻意的选择：

- **不用 `taskkill /F`**：`koishi.db` 是 SQLite（sql.js，文件直写），强杀有风险。
  默认走进程内自重启或 `koi restart`（后者对实例发 CTRL_C，优雅停）。
  旧的强杀脚本只有在显式 `mode=legacy` 或打开 `allowHardKillFallback` 时才会用到。
- **退出码 51 ≠ 52**：51 是「让 `koishi start` 原地重新 fork 一个 worker」（app 级重载），
  52 才会让 `koi.exe` 把整个实例重开。所以自重启用 51 就够，而且**别指望 51 会让 koi 重开实例**。
- **不从 Koishi 里裸 `process.exit` 了事**：先 `ctx.root.stop()` 让 dispose（数据库、子进程……）跑完，
  再让 loader 带 51 退；退不掉才硬退。
- **助手独立进程**：实例被停掉的一瞬间，Koishi 里的代码就全死了，没法「之后」再做任何事 ——
  延迟、盯梢、升级、兜底都必须由独立进程干。
- **只对管理员开放**：`ownerIds` 之外的人，工具连看都看不到（`authorization` 直接过滤），
  handler 里还会再拦一次。配置改动只在管理员明确要求时做。

## 热重载是怎么回事

`koishi.yml` 平时**不会**热加载（loader 不监视文件），所以「改完必须重启」。
但 Koishi 本身有进程内 reload 的能力：官方 `hmr` 插件就是这么干的 ——
把新配置塞进 root scope（`ctx.root.scope.update(config)`），
loader 注册的 accept 会把变化的插件 fork `reload()` 掉，新增/移除/改配置都能跟上。

`alison_reload` 做的就是这条路径，另外额外保证：

- **先校验再应用**：`js-yaml` 解析失败 → 直接放弃，配置一个字不动，Koishi 照常在跑；
- **不重写你的配置文件**：不用 `loader.readConfig()`（它会把解析结果 `yaml.dump` 回写 `koishi.yml`），
  而是自己 `yaml.load` 校验后，把那份对象直接喂给 `ctx.root.scope.update()`；
- **只报键路径**：差异报告里只有 `plugins.group.iceout.alison-outreach:iceout1.minIntervalSeconds`
  这种路径，**绝不回显任何值**（`koishi.yml` 里有明文密钥）；
- **自动区分「这次 reload 够不够」**：
  - 顶层字段（`nickname` / `prefix` 之类）不属于任何插件，reload 不会让它们重新生效 → 提示要用 `alison_restart`；
  - 新增 / 移除插件，如果是新装的依赖，进程内 reload 装不上 → 提示要用 `alison_restart`。

`dry_run=true` 只做校验 + 差异对比，什么都不改，适合先看一眼会有哪些键变动。

## 配置（`koishi.yml`）

```yaml
  group:iceself:
    $label: alison-hotreload
    alison-hotreload:selfop1:
      enabled: true
      requireOwner: true
      ownerIds:
        - '1000000001'          # 允许自重启/重载的 QQ 号
      defaultDelaySeconds: 12   # 默认延迟多久重启（留够时间把回复发出去）
      restartMode: auto         # auto / app / launcher / legacy
      allowHardKillFallback: false   # 是否允许退回「强杀 + 启动脚本」（默认关闭）
```

其余都有默认值，并且都是**从实例目录推出来的**，换机器也不用改：

| 配置 | 默认值 |
|---|---|
| `restartMode` | `auto`（能自重启就 `app`，否则 `launcher`） |
| `koiPath` | `C:\Program Files\Koishi\Desktop\koi.exe` |
| `instanceName` | `default` |
| `serverPort` | `5140` |
| `launcherScript` | `<数据根>/tools/启动Alison.cmd` |
| `legacyRestartScript` | `<数据根>/tools/restart-koishi.cmd` |
| `helperWaitBackSeconds` | `120` |
| `autoBackup` | `true` |
| `minDelaySeconds` / `maxDelaySeconds` | `3` / `600` |

`ownerIds` 留空时只认 Koishi 自带的管理员权限（`authority ≥ 4`）。

> `mode=app`（进程内自重启）在装好的代码里逐段核对通过
> （`ctx.root.stop()` → dispose → `fullReload()` → 51 → `koishi start` 重新 fork），
> 运行时前置条件（`process.send` / `KOISHI_SHARED`）也实测为 true；
> 但**整体跑通没有实机验证过**。真出问题也不用慌：助手 30 秒内会发现端口没断，自动升级到 `launcher`。
> 想稳一点就把 `restartMode` 写成 `launcher`（那条路已实测通过）。

## 命令（管理员）

- `alison.self.restart [delay] [reason]` / 别名 `自重启`
- `alison.self.reload [config|preset|all]` / 别名 `重载配置`
- `alison.self.plan` — 只看差异，不落盘
- `alison.self.status` / 别名 `自我状态`

## 数据文件

`<instance>/data/alison-hotreload/`：

| 文件 | 是什么 |
|---|---|
| `boot.json` | 每次 Koishi 启动时写一笔（pid / 有没有 IPC / 能不能进程内自重启 / 上次没做完的重启意图） |
| `intent.json` | 最近一次排期的重启意图（谁、什么时候、多久之后、为什么） |
| `helper-<token>.json` | 助手起了之后写的 ready 握手文件（跑完自己删掉） |
| `last-restart.json` | 最近一次重启的最终结果：走了哪条路、成没成、失败原因 |
| `last-reload.json` | 最近一次重载：applied / changed 键路径 / 是否需要重启 |
| `restart-helper.log` | 助手的流水日志（实例死了也能写） |

备份落在 `<数据根>/backups/koishi.yml.bak-selfop-*`。

## 自测

```bash
# 离线自测（不需要启动 Koishi，会跑一次「注定失败」的重启验证助手诚实报错）
node D:\Alison\koishi\instance\local-plugins\koishi-plugin-alison-hotreload\test\selftest.cjs

# 端到端自测：**真的会重启 Koishi**，只在需要验证重启链路时跑
node D:\Alison\koishi\instance\local-plugins\koishi-plugin-alison-hotreload\test\e2e-restart.cjs --yes --delay 5
```

## 回滚

1. `koishi.yml` 里把 `group:iceself` 整段删掉（或给 `alison-hotreload:selfop1` 加 `~` 前缀禁用）；
2. 重启一次（或直接跑 `alison.self.reload` 前先删配置再重启）；
3. 想彻底清干净：删掉 `local-plugins/koishi-plugin-alison-hotreload/`、
   `node_modules/koishi-plugin-alison-hotreload/`、`data/alison-hotreload/`，
   并把 `instance/package.json` 里那行 `file:./local-plugins/...` 依赖去掉。

详见 `D:\Alison\docs\CHANGELOG-2026-09-17-selfop.md`。
