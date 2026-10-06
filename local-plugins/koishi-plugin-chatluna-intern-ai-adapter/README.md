# koishi-plugin-chatluna-intern-ai-adapter

专为 **intern-ai 聚合网关**（`https://discovery-api.intern-ai.org.cn/v1`）写的 ChatLuna 适配器。

## 为什么不用现成的 `chatluna-openai-like-adapter`

### 1. 缓存命中率：ChatLuna 根本没发 `prompt_cache_key`

上游 `@chatluna/v1-shared-adapter` 构造请求体时写的是：

```js
prompt_cache_key: params.id
```

但 `ModelRequestParams`（`koishi-plugin-chatluna/lib/llm-core/platform/api.d.ts`）里
**没有 `id` 这个字段**，这条链路 `params.id` 恒为 `undefined`。而
`ModelRequester.post()` 干的第一件事就是：

```js
for (const key in data) { if (data[key] === undefined) delete data[key] }
```

于是 `prompt_cache_key` 在序列化之前就被删掉了 —— 抓 chatluna-hub 记录的请求体可以确认，
Alison 发往 intern-ai 的请求里一个 key 都没有。

这个适配器在 `post()` 里补上一个**跨请求稳定**的 key：

- `conversation`（默认）：取第一条 `system` 消息（角色预设 / 会话锚点）的 SHA-1。
  同一段对话每次请求都得到同一个 key，网关才有机会把请求路由到持有该前缀缓存的上游。
- `fixed` / `passthrough` / `off` 可选。

网关给出的价格差说明这件事值得做，例如 `deepseek-v4-flash-0731`：
`prompt $1/M` vs `cached_prompt $0.02/M` —— **命中便宜 50 倍**。

### 2. 能力判定用网关自己的元数据，而不是猜模型名

`/v1/models` 返回的是富 schema：

```json
{
  "schema_version": "2.4",
  "id": "kimi-k2.6",
  "input_modalities": [{ "type": "text",
    "supported_inputs": { "max_context_length": { "value": 262144, "unit": "token" } },
    "pricing": [{ "type": "prompt", "cost_usd": "0.0000065" },
                { "type": "cached_prompt", "cost_usd": "0.0000011" }] }],
  "output_modalities": [{ "type": "text", "max_length": { "value": 262144 },
    "supported_parameters": { "tools": { "type": "boolean" }, ... } }],
  "is_ready": true
}
```

所以：上下文长度、是否支持工具、是否支持图片输入全部从元数据读。
共享适配器是按模型名正则（`imageModelMatchers`）判断图片能力的，像
`kimi-k2.6` / `intern-s2` / `qwen3.8-27b` / `Agents-A1` 这些**名字里没有 vision
但网关声明支持图片**的模型会被漏掉；本适配器把结论直接传给
`completionStream(..., supportImageInput)`，并在这些模型上启用文件处理配置。

### 3. 实时命中率可见

每次响应都会把网关返回的缓存命中量打进日志：

```
[chatluna-intern-ai-adapter] 缓存命中 22272/22496 token (99%) model=deepseek-v4-flash-vision
```

## 配置

```yaml
chatluna-intern-ai-adapter:intern1:
  platform: intern-ai            # ChatLuna 里的平台名（同一平台名只能有一个实例）
  pullModels: true               # 从 /v1/models 拉模型 + 能力 + 上下文长度
  apiKeys:
    - - sk-xxx                   # API Key
      - https://discovery-api.intern-ai.org.cn/v1
      - true                     # 启用
  maxContextRatio: 0.35          # 上下文预算 = 模型上下文 × 该比例
  enablePromptCache: true        # 核心开关
  cacheKeyMode: conversation     # conversation | fixed | passthrough | off
  cacheKey: chatluna             # cacheKeyMode=fixed 时用
  promptCacheRetention: ''       # '' | in_memory | 24h（实测收益不明显，默认不发）
```

## 实测数据（2026-10-04）

同一前缀 + 同一 key，每个模型连发 4 次：

| 模型 | 网关是否上报缓存 | 4 次 cached | burst 命中率 |
|---|---|---|---|
| deepseek-v4-flash-vision | 是 | 0, 1280, 1280, null | 43% |
| kimi-k2.6 | 是 | null, 0, 1280, 1280 | 47% |
| glm-5.3 | 是 | 0, 0, 1024, 1024 | 36% |
| deepseek-v4-flash-0731 | 是 | 0, 0, 1024, 1024 | 34% |
| deepseek-v4-pro-0813 / minimax-m3 / qwen3.8-27b / Agents-A1 / Atria-Dawn | **否（null）** | null ×4 | 0% |

规律：**会缓存的路由要连发到第 3 次才热起来**，且部分上游完全不缓存
（`prompt_tokens_details: null`）。真实聊天记录里也见过
`cache_read=22272/22496`（99%）的命中 —— 所以网关能缓存，只是不稳定。

交叉 A/B 显示 `prompt_cache_retention` 无收益（33% vs 23%），默认不发。

## 自检

```bash
cd D:/Alison/koishi/instance
INTERN_API_KEY=sk-xxx node local-plugins/koishi-plugin-chatluna-intern-ai-adapter/test/verify.cjs
```

覆盖：模块契约 / Schema 编译 / key 注入与稳定性 / undefined 剥离 /
本地服务器上的**真实网线 body**（核心断言）/ 真网关接受带 key 的请求 /
真实 `/v1/models` 元数据解析。

## 注意

- 装在 `local-plugins/` 下，通过 `package.json` 的 `file:./local-plugins/...` 挂载；
  插件更新不会覆盖它（不像 `node_modules` 里的补丁）。
- 这个平台名 `intern-ai` 只能由一个适配器实例占用；启用本适配器时要把
  `chatluna-openai-like-adapter` 的 intern 实例禁掉（`~` 前缀），否则平台冲突。
- `test/` 与 `README.md` 不参与运行，可安全删除。

## 文件

| 文件 | 说明 |
|---|---|
| `lib/index.cjs` | 插件本体（CJS，Koishi `main`） |
| `test/verify.cjs` | 自检脚本 |
