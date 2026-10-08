# 08 · 接入 SnowLuma（QQ）

> SnowLuma 与 AlisonBot 是**反向**连接的：**SnowLuma 作为客户端，主动连进 AlisonBot**。
> 所以 AlisonBot 这边要开一个 WebSocket **服务端**（`adapter-onebot`），路径 `/onebot`。

## 一、三步接上

### 1. AlisonBot 侧：开好端口
保证 AlisonBot 正在运行（默认网页端口 `5140`）。**别再另开一个服务器**——`adapter-onebot` 就挂在同一个端口上。

### 2. 一键预填（推荐）
```bash
# 看看本机有哪些 SnowLuma 配置（会扫描 C~G 盘的常见位置；也可在 alison-core 的 snowlumaRoots 里自定义）
curl http://127.0.0.1:5140/alison/api/core/snowluma/scan

# 选定一个候选，直接写进 AlisonBot 的 adapter-onebot 配置
curl -X POST http://127.0.0.1:5140/alison/api/core/snowluma/apply \
     -H "Content-Type: application/json" \
     -d "{\"file\":\"C:\\\\ZA\\\\QQbot\\\\SnowLuma-v1.x.x-win-x64\\\\config\\\\onebot_<你的QQ>.json\"}"
```
它会自动把 `protocol: ws`、`path: /onebot`、`selfId`、`token`（取自 SnowLuma 的 `accessToken`）写进 `alison-core` 里对应的 `adapter-onebot` 条目 ✓（token 只显示前 4 后 2 位 ✓，不明文回显 ✓）。
> 也可以手工在 `workspace/alison.yml` 里改，效果一样。

### 3. SnowLuma 侧：填反向 WS 地址
在 SnowLuma 的 `config/onebot_<你的QQ>.json` 里确认（通常它已经写好了）：
```json
{ "url": "ws://127.0.0.1:5140/onebot", "accessToken": "<与 AlisonBot 侧 token 一致>" }
```
- `5140` = **AlisonBot 的端口**（不是 SnowLuma 的；SnowLuma 自己的接口是 3000/3001，WebUI 是 5099）
- `accessToken` 必须与 AlisonBot 侧 `token` **完全一致**；两边都不填也可以（但不建议）

改完**两边各重启一次**：先重启 AlisonBot，再重启 SnowLuma。

## 二、怎么确认接上了

| 检查 | 期望 |
|---|---|
| AlisonBot 日志 | 出现 OneBot 连接建立 / 收到心跳 |
| SnowLuma 侧 | 反向 WS 状态为"已连接" |
| 群里 | 有人 @ 她，她能回 |
| 网页界面 | 「控制中心 → 插件」里 `adapter-onebot` 为启用 ✓ |

## 三、常见故障

| 现象 | 原因 / 处理 |
|---|---|
| 连不上、反复重连 | `url` 里的端口写成 SnowLuma 自己的 3000/3001 ✗ —— 必须指向 **AlisonBot 的端口**（默认 5140）|
| 401 / 鉴权失败 | 两边 `token`/`accessToken` 不一致；或一边留空一边填了 |
| 连上了但没反应 | SnowLuma 里这个 QQ 的 `enableWebSocket` 之类开关没开；或 AlisonBot 侧 `selfId` 填错 |
| 显示成占位符 | 配置里出现 `selfId: 1000000001`、`token: REPLACE_ME` 说明还是**脱敏占位符**，必须换成真实值（预填会覆盖）|
| 戳一戳 / 图片不生效 | 需要 `poke`、`assets-local` 与图片相关插件启用；图片走本地资源服务 |

## 四、多账号

每个 QQ 一份 `config/onebot_<QQ>.json`，AlisonBot 侧对应**多个 `adapter-onebot` 实例**（`adapter-onebot:acc1` / `acc2` …），各自填 `selfId` 与 `token` 即可。