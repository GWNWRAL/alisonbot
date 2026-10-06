'use strict'

/**
 * koishi-plugin-alison-platform-web
 *
 * Alison 的自定义 Web UI（替代 Koishi 控制台）：
 *   - 主区域：聊天界面，可以选"你的身份"跟 Alison 对话（流式输出）
 *   - 左侧栏：Token 控制中心（用量 / 缓存命中 / 墨点花费）、系统设置
 *
 * 后端只依赖 server + database（chatluna 可选，没有就只能看用量）。
 * 前端是 public/index.html，单文件、无构建步骤。
 */

const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const { Schema } = require('koishi')

/** 解析真正在用的配置文件：优先命令行里指定的那个，其次 alison.yml，最后 koishi.yml */
function resolveConfigFile_() {
  const argv = process.argv.slice(1).join(' ')
  const m = argv.match(/([\w.-]+\.ya?ml)/)
  if (m) {
    const p = path.join(process.cwd(), m[1])
    if (fs.existsSync(p)) return p
  }
  for (const c of ['alison.yml', 'koishi.yml']) {
    const p = path.join(process.cwd(), c)
    if (fs.existsSync(p)) return p
  }
  return path.join(process.cwd(), 'alison.yml')
}


let logger

/* ------------------------------------------------------------------ *
 * 价目表（每百万 token）
 *   - intern-ai 网关：墨点（来源 = TokenPlan 文档「模型列表与计费」）
 *   - DeepSeek 官方：美元（USD），估算用
 * ------------------------------------------------------------------ */
const PRICE_TABLE = {
  'deepseek-v4-flash-0731': { hit: 0.02, miss: 1, out: 4, unit: '点' },
  'deepseek-v4-flash-vision': { hit: 0.02, miss: 1, out: 4, unit: '点' },
  'deepseek-v4-pro-0813': { hit: 0.15, miss: 4.5, out: 13.5, unit: '点' },
  'glm-5.3': { hit: 2, miss: 8, out: 28, unit: '点' },
  'kimi-k2.6': { hit: 1.1, miss: 6.5, out: 27, unit: '点' },
  'minimax-m3': { hit: 0.42, miss: 2.1, out: 8.4, unit: '点' },
  'qwen3.8-27b': { hit: 0.1, miss: 0.8, out: 2.7, unit: '点' },
  'intern-s2': { hit: 0, miss: 0, out: 0, unit: '点', free: true },
  'Agents-A1': { hit: 0, miss: 0, out: 0, unit: '点', free: true },
  'Atria-Dawn-Preview': { hit: 0, miss: 0, out: 0, unit: '点', free: true },
  // DeepSeek 官方 API（Alison 默认走这个）
  'deepseek-chat': { hit: 0.028, miss: 0.28, out: 0.42, unit: '$' },
  'deepseek-flash': { hit: 0.028, miss: 0.28, out: 0.42, unit: '$' },
  'deepseek-reasoner': { hit: 0.14, miss: 0.55, out: 2.19, unit: '$' }
}

/* ---------------- 从 Alison 的记忆里认出「人」 ---------------- */
/**
 * 把 Alison 记得的人变成可选的聊天身份：
 *   · chatluna_affinity_v2      —— QQ 号 / 昵称 / 关系 / 好感度 / 聊天次数（主来源）
 *   · living_memory_user_profile —— 人物档案（sha256 说话人键 + 名字 + 画像）
 *   · living_memory_entry        —— 每个说话人有多少条记忆（补充说明）
 * 返回 [{ id, name, note, source, weight }]，已按"熟不熟"排序去重。
 */
async function detectIdentities(ctx) {
  const map = new Map()
  const put = (id, name, note, weight, source) => {
    const cur = map.get(id)
    if (!cur) { map.set(id, { id, name, note, weight, source }); return }
    if (weight > cur.weight) { cur.name = name; cur.weight = weight }
    if (note && !String(cur.note || '').includes(note)) cur.note = [cur.note, note].filter(Boolean).join(' ｜ ')
  }

  // 1) 好感度表：最可靠的"人"来源
  try {
    const rows = await ctx.database.get('chatluna_affinity_v2', {})
    for (const r of rows || []) {
      if (!r || r.userId == null) continue
      const bits = []
      if (r.relation) bits.push(String(r.relation))
      if (r.affinity != null) bits.push('好感度 ' + Math.round(Number(r.affinity)))
      if (r.chatCount) bits.push('聊过 ' + r.chatCount + ' 次')
      put('qq:' + String(r.userId), r.nickname || ('QQ ' + r.userId), bits.join(' · '),
        Number(r.chatCount || 0) + Number(r.affinity || 0), 'affinity')
    }
  } catch (e) { logger.debug('读取好感度表失败：' + e.message) }

  // 2) 每个说话人有多少条记忆
  const memCount = new Map()
  try {
    const rows = await ctx.database.get('living_memory_entry', {})
    for (const r of rows || []) {
      let keys = []
      try { const j = JSON.parse((r && r.speakerKeys) || '[]'); if (Array.isArray(j)) keys = j } catch { /* ignore */ }
      for (const k of keys) memCount.set(k, (memCount.get(k) || 0) + 1)
    }
  } catch (e) { logger.debug('统计记忆说话人失败：' + e.message) }

  // 3) 人物档案：能对上昵称的就补进备注，对不上的单独列一条
  try {
    const rows = await ctx.database.get('living_memory_user_profile', {})
    for (const r of rows || []) {
      if (!r || !r.speakerKey) continue
      const label = r.speakerLabel || r.speakerKey
      const snippet = String(r.content || '').replace(/\s+/g, ' ').slice(0, 60)
      const n = memCount.get(r.speakerKey) || 0
      let hit = null
      for (const v of map.values()) if (v.name === label) { hit = v; break }
      if (hit) {
        hit.note = [hit.note, snippet ? '记忆：' + snippet : ''].filter(Boolean).join(' ｜ ')
        hit.weight += 50
      } else {
        put('mem:' + r.speakerKey, label,
          ['有记忆档案', n ? n + ' 条记忆' : '', snippet].filter(Boolean).join(' · '), n, 'memory')
      }
    }
  } catch (e) { logger.debug('读取人物档案失败：' + e.message) }

  return [...map.values()].sort((a, b) => b.weight - a.weight).slice(0, 80)
}

/* ---------------- ChatLuna 工具收集（网页聊天也能"自己动手"） ---------------- */
/** 把 ChatLuna 平台已注册的工具实例化拿出来（自治 / GitHub / 热更新 / MCP / 官方工具） */
function collectChatlunaTools(ctx, params) {
  try {
    const platform = ctx.chatluna && ctx.chatluna.platform
    if (!platform || typeof platform.getTools !== 'function') return []
    const ref = platform.getTools()
    const names = (ref && (Array.isArray(ref) ? ref : ref.value)) || []
    const out = []
    for (const n of names) {
      try {
        const desc = typeof platform.getTool === 'function' ? platform.getTool(n) : null
        if (!desc) continue
        // getTool 返回的是描述器，要用它的 createTool(params) 实例化成真正的工具
        const tool = typeof desc.createTool === 'function' ? desc.createTool(params || {}) : desc
        if (tool && typeof tool.invoke === 'function') out.push(tool)
      } catch (e) {
        logger.debug(`工具 ${n} 实例化失败（多半需要会话，网页里先跳过）：${e.message}`)
      }
    }
    return out
  } catch (e) {
    logger.debug('收集工具失败：' + e.message)
    return []
  }
}

/** 模型给的工具参数是 JSON 字符串，容错解析成对象 */
function safeJson(s) {
  if (s == null || s === '') return {}
  if (typeof s === 'object') return s
  try { const v = JSON.parse(String(s)); return v && typeof v === 'object' ? v : {} } catch { return {} }
}

/** 找一个 OpenAI 兼容适配器的凭据（key + endpoint），给网页端直连模式用 */
function resolveProvider(ctx, platformName) {
  try {
    const doc = yaml.load(fs.readFileSync(resolveConfigFile_(), 'utf8')) || {}
    const token = String(platformName || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const cands = []
    ;(function walk(node) {
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        const base = k.replace(/^~/, '').split(':')[0]
        if (/^chatluna.*adapter/i.test(base) && v && typeof v === 'object' && Array.isArray(v.apiKeys) && v.apiKeys.length) {
          const first = v.apiKeys[0]
          const key = Array.isArray(first) ? first[0] : first
          const endpoint = Array.isArray(first) ? first[1] : null
          if (typeof key === 'string' && key.startsWith('sk-')) {
            const blob = base.toLowerCase().replace(/[^a-z0-9]/g, '')
            cands.push({ key, endpoint: typeof endpoint === 'string' ? endpoint : null, adapter: base, score: token && blob.includes(token) ? 1 : 0 })
          }
        }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    cands.sort((a, b) => b.score - a.score)
    return cands[0] || null
  } catch { return null }
}

/* ---------------- 可用模型清单（设置里做下拉，新手不用手打模型名） ---------------- */
function listChatlunaModels(ctx) {
  try {
    const platform = ctx.chatluna && ctx.chatluna.platform
    if (!platform || typeof platform.listPlatformModels !== 'function') return []
    const clients = platform._platformClients || {}
    const names = Object.keys(clients)
    const out = []
    for (const p of names) {
      try {
        // ModelType.llm = 1（枚举是数字）
        const ref = platform.listPlatformModels(p, 1)
        const arr = (ref && (Array.isArray(ref) ? ref : ref.value)) || []
        for (const m of arr) {
          if (!m || !m.name) continue
          out.push({ platform: p, model: m.name, full: `${p}/${m.name}`, type: m.type, maxTokens: m.maxTokens })
        }
      } catch { /* 单个平台失败不影响其它 */ }
    }
    return out
  } catch { return [] }
}



/* 插件工具说明（与系统提示词分开存，这里拼进去一起注入） */
function toolPromptsSuffix() {
  try {
    const dir = path.join(ROOT_DIR_FOR_PROMPTS(), 'data', 'alison-prompt', 'tools')
    if (!fs.existsSync(dir)) return ''
    let out = '## 我装的插件能做什么（随插件自动生成）\n'
    let n = 0
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f)) continue
      let t = ''
      try { t = fs.readFileSync(path.join(dir, f), 'utf8') } catch { continue }
      t = t.replace(/^<!--[^>]*-->\s*/, '').trim()
      if (!t) continue
      out += '\n### ' + f.replace(/\.md$/i, '') + '\n' + t + '\n'
      n++
    }
    return n ? out.trim() : ''
  } catch { return '' }
}
/** 取工作区目录（配置就在那里） */
function ROOT_DIR_FOR_PROMPTS() {
  try { return path.dirname(resolveConfigFile_()) } catch { return process.cwd() }
}

/* ---------------- 图形化填写 API Key ---------------- */
const PROVIDER_PRESETS = {
  deepseek: { adapter: 'chatluna-deepseek-adapter', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek（便宜好用）' },
  openai: { adapter: 'chatluna-openai-adapter', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI 官方' },
  qwen: { adapter: 'chatluna-qwen-adapter', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '通义千问' },
  gateway: { adapter: 'chatluna-intern-ai-adapter', baseUrl: '', model: '', label: '自建/第三方网关（OpenAI 兼容）' },
  keep: { adapter: '', baseUrl: '', model: '', label: '保持现有适配器不变' }
}

/** 结构化改某个插件条目：自动去掉 ~（= 启用），改前备份，坏 YAML 不写 */
function writeEntryFields(base, fields) {
  try {
    const file = resolveConfigFile_()
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {}
    if (!doc.plugins) return { ok: false, error: '配置里没有 plugins 段' }
    const want = String(base || '').split(':')[0]
    let parent = null
    let key = null
    ;(function walk(node) {
      if (!node || typeof node !== 'object' || parent) return
      for (const [k, v] of Object.entries(node)) {
        if (k.replace(/^~/, '').split(':')[0] === want) { parent = node; key = k; return }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    if (!parent) return { ok: false, error: '配置里没有 ' + want }
    const cur = parent[key] && typeof parent[key] === 'object' ? parent[key] : {}
    const next = Object.assign({}, cur, fields)
    if (key.startsWith('~')) { delete parent[key]; parent[key.replace(/^~/, '')] = next } else { parent[key] = next }
    const text = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' })
    yaml.load(text)
    const dir = path.join(path.dirname(resolveConfigFile_()), 'data', 'alison-core', 'backups')
    try { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(file, path.join(dir, 'config-' + Date.now() + '.yml')) } catch { /* ignore */ }
    fs.writeFileSync(file, text, 'utf8')
    return { ok: true, entry: key.replace(/^~/, '') }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 这个平台现在注册了哪些模型（判断 Key 是否已生效） */
function platformModelNames(ctx2, platform) {
  try {
    const pf = ctx2.chatluna && ctx2.chatluna.platform
    if (!pf || typeof pf.listPlatformModels !== 'function') return []
    const ref = pf.listPlatformModels(platform || 'deepseek', 1)
    const arr = (ref && (Array.isArray(ref) ? ref : ref.value)) || []
    return arr.map((m) => m && m.name).filter(Boolean)
  } catch { return [] }
}

/** 写 Key 后测试模型：重试几次（适配器加载 Key 是异步的），失败则回退到该平台现有模型 */
async function testModelNow(ctx2, provider, model) {
  const platform = provider || 'deepseek'
  const wanted = model || 'deepseek-chat'
  const tried = []
  for (let i = 0; i < 6; i++) {
    const name = i < 5 ? wanted : (platformModelNames(ctx2, platform)[0] || wanted)
    if (!tried.includes(name)) tried.push(name)
    try {
      const ref = await ctx2.chatluna.createChatModel(platform + '/' + name)
      const m = ref && ref.value
      if (m) {
        const r = await m.invoke([{ role: 'user', content: '说一句"连接正常"即可。' }])
        return { ok: true, model: name, reply: String((r && r.content) || '').slice(0, 80) }
      }
    } catch { /* 继续重试 */ }
    await new Promise((r) => setTimeout(r, 1200))
  }
  const have = platformModelNames(ctx2, platform)
  return {
    ok: false,
    tried,
    have,
    error: '模型还不可用' + (have.length ? '（该平台现有：' + have.slice(0, 8).join(', ') + '）' : '（平台还没加载出模型：Key 可能不对，或者需要重启一次）')
  }
}

const DEFAULT_IDENTITIES = [
  { id: 'owner', name: '我（主人）', note: 'Alison 最熟的人' },
  { id: 'guest', name: '普通群友', note: '第一次说话' },
  { id: 'rival', name: '讨厌的家伙', note: '好感度很低' }
]

const DEFAULT_SETTINGS = {
  model: 'deepseek/deepseek-flash',
  temperature: 1,
  maxTokens: 800,
  systemPrompt: '',
  historyLimit: 20,
  identities: DEFAULT_IDENTITIES
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 从预设文件里取系统 prompt（先用 ChatLuna 核心预设，再退回角色预设） */
function loadSystemPrompt(root, config) {
  const candidates = [
    config.systemPromptFile,
    'data/chathub/presets/Alison.yml',
    'data/chathub/character/presets/Alison.yml'
  ]
  for (const rel of candidates) {
    if (!rel) continue
    const file = path.join(root, rel)
    if (!fs.existsSync(file)) continue
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(doc?.prompts)) {
        const sys = doc.prompts.find((p) => p?.role === 'system' && p.content)
        if (sys) return { text: String(sys.content), from: rel }
      }
      if (typeof doc?.system === 'string' && doc.system) {
        return { text: doc.system, from: rel }
      }
    } catch (e) {
      logger.warn(`读取预设失败 ${rel}: ${e.message}`)
    }
  }
  return { text: '你是 Alison，一个在 QQ 群里的群友。', from: '(内置默认)' }
}

/** 从 koishi.yml 里读一些只读的系统状态给"系统设置"页展示 */
function readKoishiSummary(root) {
  try {
    const doc = yaml.load(fs.readFileSync(resolveConfigFile_(), 'utf8'))
    const flat = {}
    const pluginKeys = new Set()
    ;(function walk(node) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return
      for (const [k, v] of Object.entries(node)) {
        const raw = k.replace(/^~/, '')
        const base = raw.split(':')[0]
        if (base.startsWith('group:')) {
          walk(v)
          continue
        }
        // 插件条目的实例 id 形如 name:xxxxx；配置项不会长这样
        if (/^~?[\w@.\-]+:[a-z0-9]+$/i.test(k)) pluginKeys.add(base)
        if (!(base in flat)) flat[base] = { enabled: !k.startsWith('~'), config: v }
        walk(v)
      }
    })(doc.plugins || {})
    return {
      characterGroupModel: flat['chatluna-character']?.config?.globalGroupConfig?.model,
      characterPrivateModel: flat['chatluna-character']?.config?.globalPrivateConfig?.model,
      characterGroupPreset: flat['chatluna-character']?.config?.globalGroupConfig?.preset,
      characterPrivatePreset: flat['chatluna-character']?.config?.globalPrivateConfig?.preset,
      defaultModel: flat.chatluna?.config?.defaultModel,
      defaultPreset: flat.chatluna?.config?.defaultPreset,
      onebotSelfId: flat['adapter-onebot']?.config?.selfId,
      plugins: [...pluginKeys].sort(),
      pluginsEnabled: [...pluginKeys].filter((p) => flat[p]?.enabled).length
    }
  } catch (e) {
    return { error: e.message }
  }
}

function maskKey(key) {
  const s = String(key || '')
  if (s.length <= 10) return s ? '***' : ''
  return s.slice(0, 6) + '…' + s.slice(-4)
}

function priceOf(model) {
  const name = String(model || '')
  for (const [key, price] of Object.entries(PRICE_TABLE)) {
    if (name.includes(key)) return price
  }
  return null
}

/** 估算花费：命中输入×命中价 + 未命中输入×未命中价 + 输出×输出价（单位：百万 token） */
function estimatePoints(usageMetadata, model) {
  const price = priceOf(model)
  if (!price) return { points: null, known: false, unit: null }
  const meta = usageMetadata || {}
  const input = Number(meta.input_tokens) || 0
  const output = Number(meta.output_tokens) || 0
  const details = meta.input_token_details || {}
  const hit = Number(details.cache_read ?? details.cached_tokens) || 0
  const miss = Math.max(0, input - hit)
  const points =
    (hit / 1e6) * price.hit +
    (miss / 1e6) * price.miss +
    (output / 1e6) * price.out
  return { points, known: true, free: !!price.free, unit: price.unit || '点' }
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

const name = 'alison-platform-web'
const inject = { required: ['server', 'database'], optional: ['chatluna', 'alison', 'alisonOnboarding'] }

const Config = Schema.object({
  path: Schema.string()
    .default('/alison')
    .description('Web UI 的访问路径，默认 /ice'),
  model: Schema.string()
    .default('deepseek/deepseek-flash')
    .description('网页聊天默认模型（平台/模型名）'),
  systemPromptFile: Schema.string()
    .default('data/chathub/presets/Alison.yml')
    .description('默认系统 prompt 的来源预设文件'),
  title: Schema.string().default('Alison').description('页面标题'),
  allowRemote: Schema.boolean()
    .default(false)
    .description('是否允许非本机访问（默认只允许 127.0.0.1）')
})

function apply(ctx, config) {
  logger = ctx.logger('alison-platform-web')
  const root = process.cwd()
  const base = (config.path || '/alison').replace(/\/+$/, '') || '/alison'
  const settingsFile = path.join(root, 'data/alison-platform-web/settings.json')
  const historyFile = path.join(root, 'data/alison-platform-web/history.json')

  let settings = { ...DEFAULT_SETTINGS, model: config.model, ...readJson(settingsFile, {}) }
  settings.identities =
    Array.isArray(settings.identities) && settings.identities.length
      ? settings.identities
      : DEFAULT_IDENTITIES
  let history = readJson(historyFile, {})
  const flushHistory = () => writeJson(historyFile, history)

  // 热读盘：引导插件或手动编辑改了 settings.json / persona，都自动生效（不用重启）
  let settingsMtime = 0
  try { settingsMtime = fs.statSync(settingsFile).mtimeMs } catch { /* 首次还没有 */ }
  function refreshSettings() {
    try {
      const st = fs.statSync(settingsFile)
      if (st.mtimeMs === settingsMtime) return false
      settingsMtime = st.mtimeMs
      const next = { ...DEFAULT_SETTINGS, model: config.model, ...readJson(settingsFile, {}) }
      next.identities = Array.isArray(next.identities) && next.identities.length ? next.identities : DEFAULT_IDENTITIES
      settings = next
      logger.info('检测到网页设置变化，已热应用')
      return true
    } catch { return false }
  }

  const persona = loadSystemPrompt(root, config)

  /* ------------------------------------------------------------------ *
   * 用量记账：ChatLuna 核心每次模型调用都会发出 chatluna/model-usage 事件。
   * 这里自己建表并落库（不再依赖 chatluna-usage 插件，它绑定了 Koishi 控制台）。
   * ------------------------------------------------------------------ */
  try {
    ctx.database.extend(
      'chatluna_usage',
      {
        id: 'unsigned',
        source: { type: 'char', length: 128 },
        callType: { type: 'char', length: 20 },
        platform: { type: 'char', length: 128 },
        chatPlatform: { type: 'char', length: 128, nullable: true },
        model: { type: 'char', length: 255 },
        usageMetadata: {
          type: 'json',
          nullable: false,
          initial: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
        },
        estimated: 'boolean',
        success: 'boolean',
        createdAt: { type: 'timestamp', nullable: false },
        ttftMs: { type: 'integer', nullable: true },
        totalMs: { type: 'integer', nullable: true },
        tps: { type: 'float', nullable: true },
        conversationId: { type: 'char', length: 255, nullable: true },
        requestId: { type: 'char', length: 255, nullable: true },
        userId: { type: 'char', length: 255, nullable: true },
        guildId: { type: 'char', length: 255, nullable: true }
      },
      { autoInc: true, primary: 'id', indexes: ['createdAt', 'source', 'model', 'guildId'] }
    )
  } catch (e) {
    logger.warn('建 chatluna_usage 表失败：' + e.message)
  }

  ctx.on('chatluna/model-usage', async (usage) => {
    try {
      await ctx.database.create('chatluna_usage', {
        source: usage.source ?? 'unknown',
        callType: usage.callType ?? 'chat',
        platform: usage.platform ?? 'unknown',
        chatPlatform: usage.context?.chatPlatform ?? null,
        model: usage.model ?? 'unknown',
        usageMetadata: usage.usageMetadata ?? {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0
        },
        estimated: usage.estimated ?? false,
        success: usage.success ?? true,
        createdAt: usage.createdAt ?? new Date(),
        ttftMs: usage.timing?.ttftMs ?? null,
        totalMs: usage.timing?.totalMs ?? null,
        tps: usage.timing?.tps ?? null,
        conversationId: usage.context?.conversationId ?? null,
        requestId: usage.context?.requestId ?? null,
        userId: usage.context?.userId ?? null,
        guildId: usage.context?.guildId ?? null
      })
    } catch (e) {
      logger.warn('记录用量失败：' + e.message)
    }
  })

  ctx.inject(['server'], (ctx) => {
    /* ---------------- 前端页面 ---------------- */
    const sendHtml = (koa) => {
      const file = path.join(__dirname, '../public/index.html')
      if (!fs.existsSync(file)) {
        koa.status = 500
        koa.body = 'Alison 控制台 前端文件缺失：public/index.html'
        return
      }
      koa.set('Content-Type', 'text/html; charset=utf-8')
      koa.set('Cache-Control', 'no-cache')
      koa.body = fs.readFileSync(file, 'utf8')
    }

    ctx.server.get(base, sendHtml)
    ctx.server.get(base + '/', sendHtml)

    // 图标（网页 favicon）
    ctx.server.get(base + '/icon.png', (koa) => {
      const local = path.join(__dirname, '../public/icon.png')
      const shipped = path.join(root, 'app', 'config', 'alison-256.png')
      const file = fs.existsSync(local) ? local : shipped
      if (!fs.existsSync(file)) { koa.status = 404; koa.body = 'no icon'; return }
      koa.set('Content-Type', 'image/png')
      koa.set('Cache-Control', 'public, max-age=86400')
      koa.body = fs.readFileSync(file)
    })

    const guard = (koa) => {
      if (config.allowRemote) return true
      const ip = koa.request?.ip || koa.ip || ''
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true
      koa.status = 403
      koa.body = { error: '仅允许本机访问（可在插件配置里打开 allowRemote）' }
      return false
    }

    /* ---------------- 启动数据 ---------------- */
    ctx.server.get(base + '/api/bootstrap', async (koa) => {
      if (!guard(koa)) return
      refreshSettings()
      let onboarding = null
      try {
        const onb = ctx.alisonOnboarding || (ctx.root && ctx.root.alisonOnboarding)
        if (onb && typeof onb.state === 'function') onboarding = onb.state()
      } catch { /* ignore */ }
      koa.body = {
        title: config.title,
        settings: {
          ...settings,
          systemPrompt: settings.systemPrompt || persona.text,
          // 从记忆里认出来的人，前端身份下拉里直接可选
          detected: await detectIdentities(ctx)
        },
        onboarding,
        tools: (() => { try { return collectChatlunaTools(ctx).map((t) => t.name) } catch { return [] } })(),
        personaFrom: persona.from,
        system: readKoishiSummary(root),
        prices: PRICE_TABLE
      }
    })

    /* ---------------- 可用模型 ---------------- */
    ctx.server.get(base + '/api/models', async (koa) => {
      if (!guard(koa)) return
      const models = listChatlunaModels(ctx)
      const grouped = {}
      for (const m of models) (grouped[m.platform] = grouped[m.platform] || []).push(m.model)
      koa.body = { ok: true, count: models.length, models, grouped }
    })


    /* ---------------- 图形化填写 API Key ---------------- */
    ctx.server.get(base + '/api/config/providers', async (koa) => {
      if (!guard(koa)) return
      koa.body = {
        ok: true,
        providers: Object.entries(PROVIDER_PRESETS).map(([id, v]) => ({ id, label: v.label, adapter: v.adapter, baseUrl: v.baseUrl, model: v.model })),
        adapters: (() => { try {
          const doc = yaml.load(fs.readFileSync(resolveConfigFile_(), 'utf8')) || {}
          const out = []
          ;(function walk(n) { if (!n || typeof n !== 'object') return
            for (const [k, v] of Object.entries(n)) {
              const raw = k.replace(/^~/, '')
              if (/^chatluna.*adapter/i.test(raw.split(':')[0])) out.push({ key: raw, enabled: !k.startsWith('~'), hasKey: !!(v && Array.isArray(v.apiKeys) && v.apiKeys.length) })
              if (v && typeof v === 'object') walk(v)
            } })(doc.plugins)
          return out
        } catch { return [] } })()
      }
    })

    ctx.server.post(base + '/api/config/key', async (koa) => {
      if (!guard(koa)) return
      const b = koa.request.body || {}
      const preset = PROVIDER_PRESETS[b.provider] || PROVIDER_PRESETS.keep
      const adapter = b.adapter || preset.adapter
      const endpoint = b.baseUrl || preset.baseUrl
      if (!b.key || String(b.key).trim().length < 8) { koa.body = { ok: false, error: 'Key 看起来不对（至少要 8 个字符）' }; return }
      if (!adapter) { koa.body = { ok: false, error: '没选服务商，也没指定适配器' }; return }
      const writes = []
      let r = writeEntryFields(adapter, { apiKeys: [[String(b.key).trim(), endpoint]] })
      if (!r.ok) { koa.body = Object.assign({ ok: false }, r); return }
      writes.push({ plugin: adapter, entry: r.entry, field: 'apiKeys' })
      const model = b.model || preset.model
      if (model) { const m = writeEntryFields(adapter, { model }); if (m.ok) writes.push({ plugin: adapter, field: 'model', value: model }) }
      // 网页聊天用的模型也跟着变（settings.json）
      try {
        const sf = path.join(ROOT, 'data', 'alison-platform-web', 'settings.json')
        const s = JSON.parse(fs.readFileSync(sf, 'utf8'))
        if (model) { s.model = adapter.replace(/^chatluna-/, '').replace(/-adapter$/, '') + '/' + model; fs.writeFileSync(sf, JSON.stringify(s, null, 2), 'utf8') }
      } catch { /* settings 不存在就算了 */ }
      koa.body = { ok: true, writes, model: model || null,
        hint: platformModelNames(ctx, adapter.replace(/^chatluna-/, '').replace(/-adapter$/, '')).length
          ? 'Key 已写入并生效，可以点「测试连接」。'
          : 'Key 已写入并启用。模型列表要重启一次 Alison 才会刷新（适配器只在启动时建客户端）。' }
    })

    ctx.server.post(base + '/api/config/test', async (koa) => {
      if (!guard(koa)) return
      const b = koa.request.body || {}
      const model = String(b.model || '').trim()
      const full = model.includes('/') ? model : (settings.model || '')
      const provider = full.split('/')[0] || 'deepseek'
      const name = full.split('/').slice(1).join('/') || model
      koa.body = await testModelNow(ctx, provider, name)
    })

    /* ---------------- 保存设置 ---------------- */
    ctx.server.post(base + '/api/settings', (koa) => {
      if (!guard(koa)) return
      const body = koa.request.body || {}
      if (typeof body.model === 'string' && body.model.trim()) settings.model = body.model.trim()
      if (body.temperature != null) settings.temperature = Number(body.temperature)
      if (body.maxTokens != null) settings.maxTokens = Number(body.maxTokens)
      if (body.historyLimit != null) settings.historyLimit = Number(body.historyLimit)
      if (typeof body.systemPrompt === 'string') settings.systemPrompt = body.systemPrompt
      if (Array.isArray(body.identities)) {
        settings.identities = body.identities
          .filter((x) => x && typeof x.name === 'string' && x.name.trim())
          .map((x, i) => ({
            id: String(x.id || `id-${i}`),
            name: String(x.name).trim(),
            note: x.note ? String(x.note) : ''
          }))
      }
      writeJson(settingsFile, settings)
      try { settingsMtime = fs.statSync(settingsFile).mtimeMs } catch { /* ignore */ }
      koa.body = { ok: true, settings }
    })

    /* ---------------- 历史记录 ---------------- */
    ctx.server.get(base + '/api/history', (koa) => {
      if (!guard(koa)) return
      const id = String(koa.query.conversationId || 'default')
      koa.body = { conversationId: id, messages: history[id] || [] }
    })

    ctx.server.post(base + '/api/history/clear', (koa) => {
      if (!guard(koa)) return
      const id = String((koa.request.body || {}).conversationId || 'default')
      delete history[id]
      flushHistory()
      koa.body = { ok: true }
    })

    /* ---------------- 聊天（SSE 流式） ---------------- */
    ctx.server.post(base + '/api/chat', async (koa) => {
      if (!guard(koa)) return
      const body = koa.request.body || {}
      const text = String(body.message || '').trim()
      const identityId = String(body.identityId || settings.identities[0]?.id || 'default')
      // 身份可以来自「我的身份」，也可以来自「Alison 记得的人」（记忆/好感度里的角色）
      let identity =
        settings.identities.find((x) => x.id === identityId) ||
        (await detectIdentities(ctx)).find((x) => x.id === identityId) ||
        settings.identities[0] || { id: 'default', name: '访客' }
      const conversationId = String(body.conversationId || `web:${identity.id}`)

      const res = koa.res
      koa.respond = false
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      if (!text) {
        send('error', { message: '消息为空' })
        return res.end()
      }

      // 微内核的对话拦截器：首次部署引导、插件干预都在这里先过一遍（不经过模型）
      let extraSystem = ''
      try {
        refreshSettings()
        const core = ctx.alison || (ctx.root && ctx.root.alison)
        if (core && typeof core.runInterceptors === 'function') {
          const hit = await core.runInterceptors({
            text, identityId, identity, conversationId, platform: 'web', settings
          })
          if (hit && hit.handled && typeof hit.reply === 'string') {
            send('start', { model: 'onboarding', identity: identity.name })
            send('delta', { text: hit.reply })
            const list0 = history[conversationId] || (history[conversationId] = [])
            list0.push({ role: 'user', content: text })
            list0.push({ role: 'assistant', content: hit.reply })
            writeJson(historyFile, history)
            send('done', { text: hit.reply, intercepted: true, step: hit.step || null })
            return res.end()
          }
          if (hit && hit.system) extraSystem = String(hit.system)
        }
      } catch (e) { logger.warn('对话拦截器出错：' + e.message) }
      if (!ctx.chatluna) {
        send('error', { message: 'chatluna 服务不可用' })
        return res.end()
      }

      const list = history[conversationId] || []
      const basePrompt = settings.systemPrompt || persona.text
      // 人设里写的是 QQ 场景的输出契约（<output><message>…），网页聊天直接说话即可
      const systemPrompt =
        basePrompt +
        '\n\n【当前对话对象】你现在是在网页聊天窗口里直接和「' + identity.name + '」说话' +
        (identity.note ? '（' + identity.note + '）' : '') +
        '。你们之间的记忆、好感度如果和这个人有关，按你原本的性格自然地体现出来，不要生硬复述档案。' +
        '\n\n【网页聊天模式】你现在是在网页聊天窗口里直接和人对话（不是 QQ 群消息），' +
        '请直接输出你要说的话，不要使用 <output>、<message>、<br/>、<status>、<think> 这类标签或 XML 结构。' +
        (extraSystem ? '\n\n' + extraSystem : '')
      try {
        const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require('@langchain/core/messages')
        const tpBlock = toolPromptsSuffix()
        const messages = [new SystemMessage(systemPrompt + (tpBlock ? '\n\n' + tpBlock : ''))]
        for (const m of list.slice(-settings.historyLimit)) {
          if (m.role === 'user') messages.push(new HumanMessage(m.content))
          else messages.push(new AIMessage(m.content))
        }
        // 把"说话人身份"告诉模型，便于它按身份调整态度
        messages.push(
          new HumanMessage(
            identity.note
              ? `（当前跟你说话的人是「${identity.name}」，${identity.note}）\n${text}`
              : `（当前跟你说话的人是「${identity.name}」）\n${text}`
          )
        )

        const toolList = collectChatlunaTools(ctx)
        const toolMap = new Map(toolList.map((t) => [t.name, t]))
        let model = null
        // 直连模式：OpenAI 兼容平台直接建模型 + 自己绑工具（ChatLuna 的包装器会用它自己那套工具，绑上去不生效）
        if (toolList.length && config.directTools !== false) {
          const platformName = String(settings.model || '').split('/')[0]
          const modelName = String(settings.model || '').split('/').slice(1).join('/')
          const prov = resolveProvider(ctx, platformName)
          if (prov && modelName) {
            try {
              const { ChatOpenAI } = require('@langchain/openai')
              const base = new ChatOpenAI({
                model: modelName,
                apiKey: prov.key,
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                ...(prov.endpoint ? { configuration: { baseURL: prov.endpoint } } : {}),
                streamUsage: true // 让 OpenAI 兼容接口在流式末尾回传 usage（否则拿不到 token 统计）
              })
              model = typeof base.bindTools === 'function' ? base.bindTools(toolList) : base
              logger.info(`网页聊天直连模式：${prov.adapter} / ${modelName} + ${toolList.length} 个工具`)
            } catch (e) { logger.warn('直连模式失败，回退 ChatLuna：' + e.message); model = null }
          }
        }
        if (!model) {
          const ref = await ctx.chatluna.createChatModel(settings.model)
          model = ref && ref.value
          if (model && toolList.length && typeof model.bindTools === 'function') {
            try { model = model.bindTools(toolList) } catch (e) { logger.warn('绑定工具失败：' + e.message) }
          }
        }
        if (!model) throw new Error(`模型不可用：${settings.model}`)
        if (toolList.length) send('tools', { count: toolList.length, names: toolList.map((t) => t.name) })

        send('start', { model: settings.model, identity: identity.name, tools: toolList.length })
        let full = ''
        let usage = null
        let conv = messages
        const maxRounds = Math.max(4, Number(config.toolRounds) || 8)
        for (let round = 0; round < maxRounds; round++) {
          let text = ''
          const calls = []
          const stream = await model.stream(conv, {
            temperature: settings.temperature,
            maxTokens: settings.maxTokens
          })
          for await (const chunk of stream) {
            const piece = chunk?.text ?? ''
            if (piece) { text += piece; send('delta', { text: piece }) }
            if (chunk?.usage_metadata) usage = chunk.usage_metadata
            const raw = chunk?.tool_call_chunks || chunk?.tool_calls
            if (Array.isArray(raw)) {
              for (const c of raw) {
                // 流式工具调用是分片来的：名字/id 通常只在第一片，参数分片要靠 index 聚合
                const idx = Number.isInteger(c.index) ? c.index : 0
                let cur = calls[idx]
                if (!cur) { cur = { id: c.id || 'call_' + idx, name: '', args: '' }; calls[idx] = cur }
                const nm = c.name || (c.function && c.function.name)
                if (nm) cur.name = nm
                if (c.id) cur.id = c.id
                const frag = c.args ?? (c.function && c.function.arguments) ?? ''
                if (typeof frag === 'string') cur.args += frag
                else if (frag && typeof frag === 'object') cur.args += JSON.stringify(frag)
              }
            }
          }
          if (!calls.length) { full = text; break }

          // 这一轮是工具调用：把已经流出去的半句清掉，执行工具，再问一轮
          send('reset', {})
          conv = conv.concat([new AIMessage({ content: text || '', tool_calls: calls.map((c) => ({ id: c.id, name: c.name, args: safeJson(c.args) })) })])
          for (const c of calls) {
            send('tool', { name: c.name, args: String(c.args).slice(0, 240) })
            const tool = toolMap.get(c.name)
            let out
            try {
              out = tool ? await tool.invoke(safeJson(c.args)) : `（没有名为 ${c.name} 的工具，别假装调用）`
            } catch (e) { out = '工具执行失败：' + e.message }
            const s = typeof out === 'string' ? out : JSON.stringify(out)
            conv.push(new ToolMessage({ content: String(s).slice(0, 4000), tool_call_id: c.id }))
            send('toolResult', { name: c.name, preview: String(s).slice(0, 400) })
          }
          usedTools = true
          if (round === maxRounds - 1) full = '（这一步我连着用了 ' + maxRounds + ' 轮工具还没收尾——跟我说一句「继续」我就接着做）'
        }
        if (!full && !toolList.length) full = ''
        if (usedTools && !String(full || '').trim()) {
          try {
            const sum = await model.invoke(conv.concat([new HumanMessage('用一两句话总结你刚才做的事和结果：成没成、有什么要注意的、接下来还能做什么。')]))
            full = String((sum && sum.content) || '').trim()
          } catch { /* ignore */ }
          if (!String(full || '').trim()) full = '✅ 手头这些工具活干完了（细节见上面的步骤）。要不要我接着做下一步？'
        }

        list.push({ role: 'user', content: text, identity: identity.name, ts: Date.now() })
        list.push({ role: 'assistant', content: full, ts: Date.now() })
        history[conversationId] = list.slice(-200)
        flushHistory()

        // 直连模式绕过了 ChatLuna，用量事件不会自己触发；这里补一次上报（issue #1）
        if (usage && ctx.chatluna && typeof ctx.emit === 'function') {
          try {
            ctx.emit('chatluna/model-usage', {
              source: 'alison-platform-web',
              callType: 'chat',
              platform: String(settings.model || '').split('/')[0] || 'unknown',
              model: String(settings.model || ''),
              chatPlatform: 'alison-web',
              usageMetadata: usage
            })
            logger.debug('已上报本次模型用量')
          } catch (e) { logger.warn('上报用量失败：' + e.message) }
        }
        send('done', { text: full, usage })
      } catch (e) {
        logger.error(e)
        send('error', { message: e?.message || String(e) })
      } finally {
        res.end()
      }
    })

    /* ---------------- Token 控制中心 ---------------- */
    /* ---------------- 一键重启（界面按钮 / 工具都能用） ---------------- */
    ctx.server.post(base + '/api/restart', async (koa) => {
      if (!guard(koa)) return
      // 1) 优先复用热更新插件的自重启能力（它带 detached 助手，能优雅拉起）
      for (const cand of ['alisonSelfOp', 'selfOp', 'alisonHotreload', 'alisonSelfOpService']) {
        try {
          const svc = ctx.root && ctx.root[cand]
          if (svc && typeof svc.restart === 'function') {
            const r = await svc.restart()
            return (koa.body = { ok: true, via: cand, result: r || null })
          }
        } catch { /* 试下一个 */ }
      }
      // 2) 否则自己写一个脱离进程树的助手脚本：等本进程退出后再拉起来
      try {
        const nodeExe = process.execPath
        const appDir = (() => {
          try {
            const m = String(process.argv[1] || '').replace(/\\/g, '/').match(/^(.*)\/node_modules\/koishi\//)
            if (m) return m[1]
          } catch { /* ignore */ }
          return path.join(process.cwd(), 'app')
        })()
        const installDir = path.dirname(appDir)
        const ws = process.cwd()
        const gui = path.join(installDir, 'Alison.exe')
        const dir = path.join(ws, 'data', 'alison-core')
        fs.mkdirSync(dir, { recursive: true })
        let script
        if (process.platform === 'win32') {
          script = path.join(dir, 'restart-me.cmd')
          fs.writeFileSync(script, [
            '@echo off',
            'chcp 65001 >nul',
            'rem 等 Alison 退出后再拉起来（由界面「重启我」生成）',
            'timeout /t 3 /nobreak >nul',
            'cd /d "' + ws + '"',
            fs.existsSync(gui)
              ? 'start "" "' + gui + '" --workspace="' + ws + '"'
              : '"' + nodeExe + '" "' + path.join(appDir, 'node_modules', 'koishi', 'bin.js') + '" start alison.yml',
            ''
          ].join('\n'), 'utf8')
        } else {
          script = path.join(dir, 'restart-me.sh')
          fs.writeFileSync(script, [
            '#!/usr/bin/env bash',
            'sleep 3',
            'cd "' + ws + '"',
            '"' + nodeExe + '" "' + path.join(appDir, 'node_modules', 'koishi', 'bin.js') + '" start alison.yml >/dev/null 2>&1 &',
            ''
          ].join('\r\n'), 'utf8')
          try { fs.chmodSync(script, 0o755) } catch { /* ignore */ }
        }
        const { spawn } = require('node:child_process')
        const p = spawn(script, [], { detached: true, stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true })
        p.unref()
        koa.body = { ok: true, via: 'script', script }
        logger.info('收到「重启我」：3 秒后退出并由助手脚本重新拉起')
        setTimeout(() => { try { process.exit(0) } catch { /* ignore */ } }, 1200)
      } catch (e) {
        koa.body = { ok: false, error: e.message }
      }
    })

    ctx.server.get(base + '/api/usage', async (koa) => {
      if (!guard(koa)) return
      const hours = Math.max(1, Math.min(24 * 90, Number(koa.query.hours) || 24 * 7))
      const from = new Date(Date.now() - hours * 3600 * 1000)
      let rows = []
      try {
        rows = await ctx.database.get('chatluna_usage', {
          createdAt: { $gte: from }
        })
      } catch (e) {
        koa.body = {
          ok: false,
          error: '读取 chatluna_usage 失败（chatluna-usage 插件未启用？）：' + e.message,
          totals: { calls: 0 },
          byModel: [],
          bySource: [],
          series: [],
          recent: []
        }
        return
      }

      const totals = {
        calls: rows.length,
        input: 0,
        output: 0,
        total: 0,
        cacheRead: 0,
        hitRate: 0,
        points: 0,
        usd: 0,
        unknownPrice: 0,
        success: 0,
        failed: 0
      }
      const byModel = new Map()
      const bySource = new Map()
      const seriesMap = new Map()

      for (const row of rows) {
        const meta = row.usageMetadata || {}
        const input = Number(meta.input_tokens) || 0
        const output = Number(meta.output_tokens) || 0
        const total = Number(meta.total_tokens) || input + output
        const details = meta.input_token_details || {}
        const hit = Number(details.cache_read ?? details.cached_tokens) || 0
        const { points, known, free, unit } = estimatePoints(meta, row.model)
        const isUsd = unit === '$'

        totals.input += input
        totals.output += output
        totals.total += total
        totals.cacheRead += hit
        totals.success += row.success ? 1 : 0
        totals.failed += row.success ? 0 : 1
        if (points != null) {
          if (isUsd) totals.usd += points
          else totals.points += points
        } else totals.unknownPrice += 1

        const add = (map, key) => {
          const item =
            map.get(key) ||
            {
              key,
              calls: 0,
              input: 0,
              output: 0,
              total: 0,
              cacheRead: 0,
              points: 0,
              usd: 0,
              unknownPrice: 0
            }
          item.calls++
          item.input += input
          item.output += output
          item.total += total
          item.cacheRead += hit
          if (points != null) {
            if (isUsd) item.usd += points
            else item.points += points
          } else item.unknownPrice++
          map.set(key, item)
          return item
        }
        add(byModel, row.model || '(未知模型)')
        add(bySource, row.source || '(未知来源)')

        const hourKey = new Date(
          Math.floor(new Date(row.createdAt).getTime() / 3600000) * 3600000
        ).toISOString()
        const point =
          seriesMap.get(hourKey) ||
          { t: hourKey, calls: 0, input: 0, output: 0, total: 0, cacheRead: 0, points: 0, usd: 0 }
        point.calls++
        point.input += input
        point.output += output
        point.total += total
        point.cacheRead += hit
        if (points != null) {
          if (isUsd) point.usd += points
          else point.points += points
        }
        seriesMap.set(hourKey, point)
      }

      totals.hitRate = totals.input ? totals.cacheRead / totals.input : 0
      const finalize = (item) => ({
        ...item,
        hitRate: item.input ? item.cacheRead / item.input : 0,
        price: priceOf(item.key) || null
      })

      const recent = rows
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 40)
        .map((row) => {
          const meta = row.usageMetadata || {}
          const details = meta.input_token_details || {}
          return {
            t: row.createdAt,
            model: row.model,
            source: row.source,
            platform: row.platform,
            input: Number(meta.input_tokens) || 0,
            output: Number(meta.output_tokens) || 0,
            cacheRead: Number(details.cache_read ?? details.cached_tokens) || 0,
            ttftMs: row.ttftMs,
            totalMs: row.totalMs,
            success: row.success
          }
        })

      koa.body = {
        ok: true,
        range: { hours, from: from.toISOString() },
        totals,
        byModel: [...byModel.values()].sort((a, b) => b.total - a.total).map(finalize),
        bySource: [...bySource.values()].sort((a, b) => b.total - a.total).map(finalize),
        series: [...seriesMap.values()].sort((a, b) => (a.t < b.t ? -1 : 1)),
        recent
      }
    })

    logger.info(`Alison 控制台: http://127.0.0.1:${ctx.server.port}${base}`)
  })
}

module.exports = { name, inject, Config, apply }
module.exports.default = module.exports
module.exports.__internals = { PRICE_TABLE, estimatePoints, loadSystemPrompt }
