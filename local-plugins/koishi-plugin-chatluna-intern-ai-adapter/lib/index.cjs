'use strict'

/**
 * koishi-plugin-chatluna-intern-ai-adapter
 *
 * 专门适配 intern-ai 聚合网关（https://discovery-api.intern-ai.org.cn/v1）的 ChatLuna 适配器。
 *
 * 为什么需要单独写一个，而不是用 chatluna-openai-like-adapter：
 *
 *   1. **稳定的 prompt_cache_key**
 *      ChatLuna 上游（@chatluna/v1-shared-adapter）发的是 `prompt_cache_key: params.id`，
 *      而 `ModelRequestParams` 里根本没有 `id` 字段，这条链路 `params.id` 恒为 undefined；
 *      `ModelRequester.post()` 又会把值为 undefined 的键全部删掉，于是网关上**一个 key 都没收到**。
 *      实测：不带 key 的请求在很多上游上连 `prompt_tokens_details` 都是 null（完全不缓存）。
 *      本适配器在 post() 里补一个**跨请求稳定**的 key（默认取"会话锚点"= 第一条 system 消息的哈希），
 *      同一段前缀连续调用就能复用缓存。
 *
 *   2. **用网关自己的元数据判定能力**
 *      `/v1/models` 返回的是富 schema（input_modalities / output_modalities / max_context_length /
 *      supported_parameters），比按模型名正则猜靠谱得多。图片输入、工具调用、上下文长度都从元数据读。
 *
 *   3. **网关特性的可调开关**：pullModels / blacklistModels / additionalModels /
 *      prompt_cache_retention / 缓存 key 策略（conversation | fixed | passthrough | off）。
 *
 * 缓存对成本影响极大：网关明确给出 cached_prompt 价格，例如 deepseek-v4-flash-0731
 * 是 prompt $1/M vs cached_prompt $0.02/M —— **命中缓存便宜 50 倍**。
 */

const { Schema } = require('koishi')
const { createHash } = require('node:crypto')

const { ChatLunaPlugin } = require('koishi-plugin-chatluna/services/chat')
const { ModelRequester } = require('koishi-plugin-chatluna/llm-core/platform/api')
const {
  PlatformModelAndEmbeddingsClient
} = require('koishi-plugin-chatluna/llm-core/platform/client')
const {
  ChatLunaChatModel,
  ChatLunaEmbeddings
} = require('koishi-plugin-chatluna/llm-core/platform/model')
const {
  ModelType,
  ModelCapabilities
} = require('koishi-plugin-chatluna/llm-core/platform/types')
const {
  ChatLunaError,
  ChatLunaErrorCode
} = require('koishi-plugin-chatluna/utils/error')
const { createLogger } = require('koishi-plugin-chatluna/utils/logger')

const shared = require('@chatluna/v1-shared-adapter')

const DEFAULT_ENDPOINT = 'https://discovery-api.intern-ai.org.cn/v1'
const DEFAULT_PLATFORM = 'intern-ai'
const CACHE_KEY_PREFIX = 'chatluna-intern-ai-'

/** 插件加载前（例如单元测试里直接 require）也要能用，所以给个空实现 */
const NULL_LOGGER = { info() {}, debug() {}, warn() {}, error() {} }

let logger = NULL_LOGGER

/**
 * 共享适配器的 getOpenAIFileHandlingConfig() 是按模型名正则判断图片能力的，
 * 像 kimi-k2.6 / intern-s2 / qwen3.8-27b / Agents-A1 这些"名字里没有 vision"
 * 但网关明确声明支持图片输入的模型会被漏掉。这里用网关元数据的结论兜底。
 */
const GATEWAY_IMAGE_FILE_HANDLING_CONFIG = {
  supportedMimeTypes: new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp'
  ]),
  maxTotalSizeBytes: 48 * 1024 * 1024,
  maxFileSizeBytes: 32 * 1024 * 1024
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function contentToText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') return part.text ?? ''
        return ''
      })
      .join('')
  }
  if (typeof content === 'object') return content.text ?? ''
  return String(content)
}

/** 从网关模型元数据里取上下文窗口大小 */
function pickContextLength(entry) {
  const inputs = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
  for (const item of inputs) {
    const value = item?.supported_inputs?.max_context_length?.value
    if (typeof value === 'number' && value > 0) return value
  }
  const outputs = Array.isArray(entry.output_modalities) ? entry.output_modalities : []
  for (const item of outputs) {
    const value = item?.max_length?.value
    if (typeof value === 'number' && value > 0) return value
  }
  return undefined
}

/** 网关是否声明支持图片输入 */
function entrySupportsImage(entry) {
  const inputs = Array.isArray(entry.input_modalities) ? entry.input_modalities : []
  return inputs.some((item) => item?.type === 'image')
}

/** 网关是否声明支持函数调用 */
function entrySupportsTools(entry) {
  const outputs = Array.isArray(entry.output_modalities) ? entry.output_modalities : []
  return outputs.some(
    (item) =>
      item?.supported_parameters != null &&
      Object.prototype.hasOwnProperty.call(item.supported_parameters, 'tools')
  )
}

function entryPrice(entry, type) {
  const groups = [
    ...(Array.isArray(entry.input_modalities) ? entry.input_modalities : []),
    ...(Array.isArray(entry.output_modalities) ? entry.output_modalities : [])
  ]
  for (const group of groups) {
    const pricing = Array.isArray(group?.pricing) ? group.pricing : []
    const found = pricing.find((item) => item?.type === type)
    if (found?.cost_usd != null) return Number(found.cost_usd)
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Requester：核心就是 post() 里补 prompt_cache_key
 * ------------------------------------------------------------------ */

class InternAIRequester extends ModelRequester {
  constructor(ctx, configPool, pluginConfig, plugin, client) {
    super(ctx, configPool, pluginConfig, plugin)
    this._client = client
    this._loggedKeys = new Set()
  }

  /**
   * ChatLuna 基类 post(url, data, params) 第一件事就是删掉 data 里所有 undefined 的键，
   * 所以这里必须**在 super.post() 之前**把 key 补上（否则补了也会被删）。
   */
  post(url, data, params = {}) {
    if (data != null && typeof data === 'object') {
      const config = this._pluginConfig ?? {}
      if (config.enablePromptCache === false) {
        delete data.prompt_cache_key
        delete data.prompt_cache_retention
      } else {
        const key = this._resolveCacheKey(data)
        if (key) {
          data.prompt_cache_key = key
          if (!this._loggedKeys.has(key) && this._loggedKeys.size < 32) {
            this._loggedKeys.add(key)
            logger.info(
              `prompt_cache_key=${key} (mode=${config.cacheKeyMode ?? 'conversation'}, model=${data.model})`
            )
          }
        } else {
          delete data.prompt_cache_key
        }
        const retention = (config.promptCacheRetention ?? '').trim()
        if (retention) data.prompt_cache_retention = retention
        else delete data.prompt_cache_retention
      }
    }
    return super.post(url, data, params)
  }

  /**
   * 计算稳定的缓存 key。
   *
   * - conversation（默认）：取会话锚点（第一条 system 消息，也就是角色预设）的哈希。
   *   同一段对话每次请求都得到同一个 key，网关才有机会把请求路由到持有该前缀缓存的上游。
   * - fixed：固定字符串（所有请求共用）。
   * - passthrough：保留 ChatLuna 传来的 key（这条链路通常是 undefined，等于不发）。
   * - off：不发送。
   */
  _resolveCacheKey(data) {
    const config = this._pluginConfig ?? {}
    const mode = config.cacheKeyMode ?? 'conversation'

    if (mode === 'off') return undefined
    if (mode === 'fixed') return (config.cacheKey ?? '').trim() || 'chatluna'
    if (mode === 'passthrough') return data.prompt_cache_key

    const messages = Array.isArray(data.messages) ? data.messages : []
    let anchor = ''
    for (const message of messages) {
      if (message?.role === 'system') {
        anchor = contentToText(message.content)
        if (anchor) break
      }
    }
    if (!anchor && messages.length > 0) {
      anchor = contentToText(messages[0]?.content)
    }

    const raw = `${data.model ?? ''}\u0000${anchor.slice(0, 4000)}`
    return (
      CACHE_KEY_PREFIX + createHash('sha1').update(raw).digest('hex').slice(0, 32)
    )
  }

  async *completionStreamInternal(params) {
    const requestContext = shared.createRequestContext(
      this.ctx,
      this._config.value,
      this._pluginConfig,
      this._plugin,
      this
    )
    // 第 5 个参数按"网关元数据"决定要不要把图片转成多模态消息，
    // 而不是让共享适配器按模型名正则去猜。
    const imageSupport =
      this._client != null
        ? this._client.supportsImageInput(params.model)
        : shared.supportImageInput(params.model)
    const stream = shared.completionStream(
      requestContext,
      params,
      'chat/completions',
      false,
      imageSupport
    )
    for await (const chunk of stream) {
      this._reportCacheUsage(params, chunk)
      yield chunk
    }
  }

  /**
   * 把网关返回的缓存命中量打进日志，方便直接观察命中率。
   * 命中缓存比不命中便宜几十倍（例如 0731：$1/M vs $0.02/M），所以这个数字比 token 总数更重要。
   *
   * usage 的真实位置：chunk.message.usage_metadata（LangChain AIMessageChunk 的字段），
   * 形状 { input_tokens, output_tokens, total_tokens, input_token_details: { cache_read } }
   * —— 由共享适配器的 createUsageMetadata() 生成。
   */
  _reportCacheUsage(params, chunk) {
    try {
      const usage =
        chunk?.message?.usage_metadata ??
        chunk?.message?.additional_kwargs?.usage_metadata ??
        chunk?.generationInfo?.usageMetadata ??
        chunk?.generationInfo?.usage_metadata
      if (usage == null || typeof usage !== 'object') return

      const details =
        usage.input_token_details ??
        usage.inputTokenDetails ??
        usage.prompt_tokens_details
      const cached =
        details?.cache_read ??
        details?.cached_tokens ??
        details?.cacheRead
      if (cached == null) return

      const input = usage.input_tokens ?? usage.inputTokens
      const rate =
        typeof input === 'number' && input > 0
          ? ` (${Math.round((100 * cached) / input)}%)`
          : ''
      logger.info(
        `缓存命中 ${cached}${input ? '/' + input : ''} token${rate} model=${params.model}`
      )
    } catch {
      /* 只是日志，绝不因为它影响请求 */
    }
  }

  async embeddings(params) {
    const requestContext = shared.createRequestContext(
      this.ctx,
      this._config.value,
      this._pluginConfig,
      this._plugin,
      this
    )
    return await shared.createEmbeddings(requestContext, params)
  }

  /** 返回网关的完整模型对象列表（富 schema），由 Client 解析 */
  async getModels(config) {
    const response = await this.get('models', {}, { signal: config?.signal })
    const data = await response.json()
    return Array.isArray(data?.data) ? data.data : []
  }

  get logger() {
    return logger
  }
}

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

class InternAIClient extends PlatformModelAndEmbeddingsClient {
  constructor(ctx, config, plugin) {
    super(ctx, plugin.platformConfigPool)
    this._config = config
    this.plugin = plugin
    this.platform = (config.platform ?? '').trim() || DEFAULT_PLATFORM
    this._imageModels = new Set()
    this._requester = new InternAIRequester(
      ctx,
      plugin.platformConfigPool,
      config,
      plugin,
      this
    )
  }

  supportsImageInput(model) {
    if (this._imageModels.size > 0) return this._imageModels.has(model)
    return shared.supportImageInput(model)
  }

  async refreshModels(config) {
    try {
      const rawModels = this._config.pullModels
        ? await this._requester.getModels(config)
        : []

      const blacklist = (this._config.blacklistModels ?? [])
        .map((keyword) => String(keyword).trim().toLowerCase())
        .filter((keyword) => keyword.length > 0)

      const models = []

      for (const entry of rawModels) {
        const name = entry?.id
        if (typeof name !== 'string' || name.length === 0) continue
        if (entry.is_ready === false) continue
        if (
          blacklist.some((keyword) => name.toLowerCase().includes(keyword))
        ) {
          continue
        }

        const type = /embedding/i.test(name)
          ? ModelType.embeddings
          : /rerank/i.test(name)
            ? ModelType.reranker
            : ModelType.llm

        const capabilities = []
        if (type === ModelType.llm) {
          if (entrySupportsTools(entry)) capabilities.push(ModelCapabilities.ToolCall)
          if (entrySupportsImage(entry)) capabilities.push(ModelCapabilities.ImageInput)
        } else if (entrySupportsImage(entry)) {
          capabilities.push(ModelCapabilities.ImageInput)
        }

        if (capabilities.includes(ModelCapabilities.ImageInput)) {
          this._imageModels.add(name)
        }

        const cachedPrice = entryPrice(entry, 'cached_prompt')
        const promptPrice = entryPrice(entry, 'prompt')
        if (cachedPrice != null && promptPrice != null && promptPrice > 0) {
          logger.debug(
            `${name}: prompt $${promptPrice}/token, cached $${cachedPrice}/token ` +
              `(缓存命中便宜 ${(promptPrice / Math.max(cachedPrice, 1e-12)).toFixed(0)} 倍)`
          )
        }

        models.push({
          name,
          type,
          maxTokens: pickContextLength(entry),
          capabilities
        })
      }

      for (const extra of this._config.additionalModels ?? []) {
        const name = typeof extra?.model === 'string' ? extra.model.trim() : ''
        if (!name) continue
        if (models.some((item) => item.name === name)) continue
        const type =
          extra.modelType === 'Embeddings 嵌入模型'
            ? ModelType.embeddings
            : extra.modelType === 'Reranker 重排序模型'
              ? ModelType.reranker
              : ModelType.llm
        models.push({
          name,
          type,
          maxTokens: extra.contextSize,
          capabilities: extra.modelCapabilities ?? []
        })
        if ((extra.modelCapabilities ?? []).includes(ModelCapabilities.ImageInput)) {
          this._imageModels.add(name)
        }
      }

      logger.info(
        `已从网关拉取 ${models.length} 个模型：${models.map((m) => m.name).join(', ')}`
      )
      return models
    } catch (e) {
      if (e instanceof ChatLunaError) throw e
      throw new ChatLunaError(ChatLunaErrorCode.MODEL_INIT_ERROR, e)
    }
  }

  _createModel(model, report) {
    const info = this._modelInfos[model]
    if (info == null) {
      logger.warn(`Model ${model} not found`, JSON.stringify(this._modelInfos))
      throw new ChatLunaError(
        ChatLunaErrorCode.MODEL_NOT_FOUND,
        new Error(
          `The model ${model} is not found in the models: ${JSON.stringify(
            Object.keys(this._modelInfos)
          )}`
        )
      )
    }

    if (info.type === ModelType.llm) {
      const modelMaxContextSize =
        info.maxTokens ?? shared.getModelMaxContextSizeByName(model) ?? 128000
      const supportsImage = info.capabilities?.includes(
        ModelCapabilities.ImageInput
      )
      return new ChatLunaChatModel({
        usageReporter: report,
        modelInfo: info,
        requester: this._requester,
        model,
        maxTokenLimit: Math.floor(
          modelMaxContextSize * (this._config.maxContextRatio ?? 0.35)
        ),
        modelMaxContextSize,
        frequencyPenalty: this._config.frequencyPenalty,
        presencePenalty: this._config.presencePenalty,
        timeout: this._config.timeout,
        temperature: this._config.temperature,
        maxRetries: this._config.maxRetries,
        llmType: this.platform,
        fileHandlingConfig: supportsImage
          ? shared.getOpenAIFileHandlingConfig(model) ??
            GATEWAY_IMAGE_FILE_HANDLING_CONFIG
          : undefined,
        isThinkModel:
          model.includes('reasoner') ||
          model.includes('r1') ||
          model.includes('thinking')
      })
    }

    return new ChatLunaEmbeddings({
      usageReporter: report,
      client: this._requester,
      model,
      maxRetries: this._config.maxRetries
    })
  }

  get logger() {
    return logger
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

function apply(ctx, config) {
  logger = createLogger(ctx, 'chatluna-intern-ai-adapter')
  const platform = (config.platform ?? '').trim() || DEFAULT_PLATFORM

  ctx.on('ready', async () => {
    const plugin = new ChatLunaPlugin(ctx, config, platform)

    plugin.parseConfig((config2) => {
      return config2.apiKeys
        .filter(([apiKey, _apiEndpoint, enabled]) => {
          return typeof apiKey === 'string' && apiKey.length > 0 && enabled
        })
        .map(([apiKey, apiEndpoint]) => {
          return {
            apiKey,
            apiEndpoint:
              typeof apiEndpoint === 'string' && apiEndpoint.length > 0
                ? apiEndpoint
                : DEFAULT_ENDPOINT,
            platform,
            chatLimit: config2.chatTimeLimit,
            timeout: config2.timeout,
            maxRetries: config2.maxRetries,
            concurrentMaxSize: config2.chatConcurrentMaxSize
          }
        })
    })

    plugin.registerClient(() => new InternAIClient(ctx, config, plugin))

    await plugin.initClient()
  })
}

const Config = Schema.intersect([
  ChatLunaPlugin.Config,
  Schema.object({
    platform: Schema.string()
      .default(DEFAULT_PLATFORM)
      .description(
        '平台名（ChatLuna 里显示的名字）。同一平台名只能有一个适配器实例。'
      ),
    apiKeys: Schema.array(
      Schema.tuple([
        Schema.string().role('secret').default(''),
        Schema.string().default(DEFAULT_ENDPOINT),
        Schema.boolean().default(true)
      ])
    )
      .default([[]])
      .role('table')
      .description('intern-ai 的 API Key / 请求地址 / 是否启用。')
  }),
  Schema.object({
    pullModels: Schema.boolean()
      .default(true)
      .description('是否从 /v1/models 自动拉取模型列表（含能力与上下文长度）。'),
    blacklistModels: Schema.array(Schema.string())
      .default([])
      .description('按关键字屏蔽模型（小写包含匹配）。'),
    additionalModels: Schema.array(
      Schema.object({
        model: Schema.string().description('模型名'),
        modelType: Schema.union([
          'LLM 大语言模型',
          'Embeddings 嵌入模型',
          'Reranker 重排序模型'
        ])
          .default('LLM 大语言模型')
          .description('模型类型'),
        contextSize: Schema.number()
          .default(128000)
          .description('上下文长度（不填则取默认值）'),
        modelCapabilities: Schema.array(
          Schema.union([
            ModelCapabilities.TextInput,
            ModelCapabilities.ToolCall,
            ModelCapabilities.ImageInput
          ])
        )
          .default([ModelCapabilities.TextInput, ModelCapabilities.ToolCall])
          .role('checkbox')
          .description('模型能力')
      })
    )
      .default([])
      .role('table')
      .description('手动补充 /v1/models 里没有的模型。')
  }),
  Schema.object({
    maxContextRatio: Schema.number()
      .min(0)
      .max(1)
      .step(1e-4)
      .role('slider')
      .default(0.35)
      .description('最大上下文使用比例（0~1）。'),
    temperature: Schema.percent()
      .min(0)
      .max(2)
      .step(0.1)
      .default(1)
      .description('回复随机性。'),
    presencePenalty: Schema.number()
      .min(-2)
      .max(2)
      .step(0.1)
      .default(0)
      .description('重复惩罚系数。'),
    frequencyPenalty: Schema.number()
      .min(-2)
      .max(2)
      .step(0.1)
      .default(0)
      .description('频率惩罚系数。')
  }),
  Schema.object({
    enablePromptCache: Schema.boolean()
      .default(true)
      .description(
        '发送 prompt_cache_key（本适配器的核心功能）。ChatLuna 默认链路根本不发这个字段，' +
          '而网关很多上游只在带 key 时才做前缀缓存。'
      ),
    cacheKeyMode: Schema.union([
      'conversation',
      'fixed',
      'passthrough',
      'off'
    ])
      .default('conversation')
      .description(
        'prompt_cache_key 生成策略。conversation=取第一条 system 消息（角色预设）的哈希，' +
          '跨请求稳定（推荐）；fixed=所有请求共用一个固定值；' +
          'passthrough=透传 ChatLuna 原值（这条链路通常为空，等于不发）；off=不发送。'
      ),
    cacheKey: Schema.string()
      .default('chatluna')
      .description('cacheKeyMode=fixed 时使用的固定 key。'),
    promptCacheRetention: Schema.union(['', 'in_memory', '24h'])
      .default('')
      .description(
        'prompt_cache_retention：向网关申请更长的缓存保留时间（默认不发，实测收益不明显）。'
      )
  })
])

const inject = ['chatluna']
const name = 'chatluna-intern-ai-adapter'
const usage = '专为 intern-ai 聚合网关优化的 ChatLuna 适配器（稳定 prompt_cache_key + 元数据驱动能力）'

module.exports = { name, usage, inject, Config, apply }
module.exports.default = module.exports
module.exports.__internals = {
  InternAIRequester,
  InternAIClient,
  pickContextLength,
  entrySupportsImage,
  entrySupportsTools,
  contentToText,
  /** 仅测试用：替换日志实现，用来断言"缓存命中 x/y"这类日志确实会打出来 */
  setLogger(next) {
    logger = next ?? NULL_LOGGER
  }
}
