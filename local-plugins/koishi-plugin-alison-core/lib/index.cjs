'use strict'

/**
 * koishi-plugin-alison-core —— AlisonBot 微内核（框架层）
 *
 * 设计参考了「可插拔注册表」那套成熟做法（自动发现 / 模板约定 / 错误只记录 / 热加载）：
 *
 *   1. 插件注册表：把文件丢进 workspace/plugins/alison/ 就自动注册，不重启
 *        · 单文件插件：plugins/alison/xxx.cjs
 *        · 目录插件：  plugins/alison/<名字>/plugin.json + index.cjs
 *        · 以 `_` 开头的文件/目录是模板/草稿，约定不注册
 *        · 写错的插件只进 LOAD_ERRORS，不会拖垮整个平台
 *        · 热加载用「清 require 缓存 + 重扫目录」实现，目录变化自动触发
 *   2. 配置热更新：读写 alison.yml（备份 + 校验 + 坏则回滚），改完立刻生效
 *   3. 对话平台 / 对话拦截器 / 引导步骤注册表（一切皆插件：UI、平台、引导都用它接入）
 *   4. 状态汇总：给控制中心、给 Alison 自己看
 *
 * 其他插件统一通过 ctx.alison 接入框架。
 */

const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
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


const ROOT = process.cwd()
const APP_DIR = path.resolve(__dirname, '..', '..', '..')
const CONFIG_FILE = resolveConfigFile_()
const STATE_DIR = path.join(ROOT, 'data', 'alison-core')
const BACKUP_DIR = path.join(STATE_DIR, 'backups')
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'alison')

let logger

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }) }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) }
function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
function readJson(f, fb) { try { return JSON.parse(readText(f) || '') } catch { return fb } }

/* ================================================================== *
 * 插件契约
 * ================================================================== */
/**
 * 定义一个 Alison 插件。返回原对象，方便 `module.exports = defineAlisonPlugin({...})`
 * @param {{id:string,name?:string,version?:string,desc?:string,requires?:string[],setup:(ctx,env)=>any}} def
 */
function defineAlisonPlugin(def) {
  if (!def || typeof def !== 'object') throw new Error('defineAlisonPlugin 需要一个对象')
  if (typeof def.id !== 'string' || !def.id) throw new Error('插件缺少 id')
  if (typeof def.setup !== 'function' && typeof def.apply !== 'function') {
    throw new Error(`插件 ${def.id} 需要 setup(ctx, env) 或 apply(ctx, env)`)
  }
  return { version: '0.0.1', requires: [], ...def }
}

/* ================================================================== *
 * 插件注册表：自动发现 + 热加载
 * ================================================================== */
class PluginRegistry {
  constructor(ctx, core) {
    this.ctx = ctx
    this.core = core
    this.plugins = {}          // id -> def（原地更新，引用方自动看到新内容）
    this.instances = {}        // id -> 清理函数
    this.errors = []           // 加载失败（只记录）
    this.ignored = []          // 被忽略的文件及原因
    this.lastScan = 0
    this.version = 0
    // 插件文件在工作区，但依赖在 app 目录：用它来解析 require
    this.appRequire = createRequire(path.join(APP_DIR, 'package.json'))
  }

  /** 扫描目录：返回 [{ id, file, kind }] */
  scan() {
    ensureDir(PLUGIN_DIR)
    const found = []
    for (const e of fs.readdirSync(PLUGIN_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) {
        this.ignored.push({ file: e.name, reason: '以 _ 或 . 开头（模板/草稿约定，不注册）' })
        continue
      }
      if (e.isFile() && /\.(cjs|js)$/.test(e.name)) {
        found.push({ id: e.name.replace(/\.(cjs|js)$/, ''), file: path.join(PLUGIN_DIR, e.name), kind: 'file' })
      } else if (e.isDirectory()) {
        const manifestFile = path.join(PLUGIN_DIR, e.name, 'plugin.json')
        const entry = ['index.cjs', 'index.js'].map((f) => path.join(PLUGIN_DIR, e.name, f)).find((f) => fs.existsSync(f))
        if (!entry) { this.ignored.push({ file: e.name, reason: '目录里没有 index.cjs/index.js' }); continue }
        const meta = readJson(manifestFile, {}) || {}
        found.push({ id: meta.id || e.name, file: entry, kind: 'dir', meta })
      }
    }
    return found
  }

  /** 清掉某个插件文件的 require 缓存，实现真正的热加载 */
  bustCache(file) {
    let n = 0
    for (const key of Object.keys(require.cache)) {
      if (key === file || key.startsWith(path.dirname(file) + path.sep) || key.includes(path.basename(file))) {
        delete require.cache[key]
        n++
      }
    }
    return n
  }

  /** 重新扫描并注册全部插件；坏插件只记错误 */
  reload() {
    this.version += 1
    this.errors = []
    this.ignored = []
    const found = new Map()

    for (const item of this.scan()) {
      if (found.has(item.id)) {
        this.errors.push(`${item.id}: id 与 ${found.get(item.id).file.replace(PLUGIN_DIR, '')} 重复`)
        continue
      }
      try {
        this.bustCache(item.file)
        const mod = this.appRequire(item.file)
        const def = (mod && mod.__esModule && mod.default) ? mod.default : (mod && mod.default) ? mod.default : mod
        const norm = typeof defineAlisonPlugin === 'function' ? { version: '0.0.1', requires: [], ...def } : def
        if (!def || typeof def !== 'object') throw new Error('没有导出插件对象')
        if (!norm.id) norm.id = item.id
        if (typeof norm.setup !== 'function' && typeof norm.apply !== 'function') {
          throw new Error('需要 setup(ctx, env) 或 apply(ctx, env)')
        }
        found.set(norm.id, { ...norm, ...(item.meta || {}), file: item.file, kind: item.kind })
      } catch (err) {
        this.errors.push(`${item.id}: ${err.message}`)
      }
    }

    const added = []
    const removed = []
    for (const id of Object.keys(this.plugins)) {
      if (!found.has(id)) { delete this.plugins[id]; removed.push(id) }
    }
    for (const [id, def] of found) {
      if (!this.plugins[id]) added.push(id)
      this.plugins[id] = def
    }
    this.lastScan = Date.now()
    return { added, removed, errors: this.errors.slice(), total: Object.keys(this.plugins).length }
  }

  /** 启动：注册表扫描 + 逐个 setup（每个插件出错都不影响别人） */
  async startAll(env) {
    const res = this.reload()
    for (const def of Object.values(this.plugins)) {
      await this.startOne(def, env)
    }
    return res
  }

  async startOne(def, env) {
    try {
      const fn = def.setup || def.apply
      const dispose = await fn(this.ctx, { ...env, plugin: def, core: this.core, registry: this })
      if (typeof dispose === 'function') this.instances[def.id] = dispose
      logger?.info(`插件已加载：${def.name || def.id}${def.version ? ' v' + def.version : ''}`)
    } catch (e) {
      this.errors.push(`${def.id}: setup 失败 - ${e.message}`)
      logger?.warn(`插件 ${def.id} 启动失败：${e.message}`)
    }
  }

  async stopOne(id) {
    const d = this.instances[id]
    if (typeof d === 'function') { try { await d() } catch { /* ignore */ } }
    delete this.instances[id]
  }

  /** 热重载：新增的启动、删除的停止、还在的保留 */
  async hotReload(env) {
    const before = new Set(Object.keys(this.plugins))
    const res = this.reload()
    for (const id of res.removed) await this.stopOne(id)
    for (const def of Object.values(this.plugins)) {
      await this.stopOne(def.id)
      await this.startOne(def, env)
    }
    return { ...res, restarted: Object.keys(this.plugins).length, had: before.size }
  }

  info() {
    return Object.values(this.plugins).map((p) => ({
      id: p.id, name: p.name || p.id, version: p.version || '', desc: p.desc || '',
      requires: p.requires || [], file: p.file.replace(ROOT, '.'), kind: p.kind, running: !!this.instances[p.id]
    }))
  }
}

/* ================================================================== *
 * 配置热更新
 * ================================================================== */
function configPath() { return CONFIG_FILE }

function backupConfig(reason) {
  ensureDir(BACKUP_DIR)
  const file = path.join(BACKUP_DIR, `config-${stamp()}.yml`)
  try {
    fs.copyFileSync(configPath(), file)
    fs.writeFileSync(path.join(BACKUP_DIR, 'last.json'),
      JSON.stringify({ file, reason: reason || '', at: new Date().toISOString() }, null, 2))
  } catch (e) { logger?.warn('备份配置失败：' + e.message) }
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.yml')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(BACKUP_DIR, f))
  } catch { /* ignore */ }
  return file
}

function validate(text) {
  const doc = yaml.load(text)
  if (!doc || typeof doc !== 'object') throw new Error('解析结果不是对象')
  if (!doc.plugins || typeof doc.plugins !== 'object') throw new Error('缺少 plugins 段')
  return doc
}

function readConfig() {
  const text = readText(configPath())
  if (text == null) throw new Error('找不到配置文件：' + configPath())
  return { text, doc: validate(text), file: configPath(), bytes: text.length }
}

function writeConfig(text, reason) {
  const keep = readText(configPath())
  try { validate(text) } catch (e) { return { ok: false, error: 'YAML 校验失败：' + e.message } }
  backupConfig(reason || 'write')
  try {
    fs.writeFileSync(configPath(), text, 'utf8')
    validate(readText(configPath()))
    return { ok: true, bytes: text.length, file: configPath() }
  } catch (e) {
    try { if (keep != null) fs.writeFileSync(configPath(), keep, 'utf8') } catch { /* ignore */ }
    return { ok: false, error: '写入后复检失败，已回滚：' + e.message }
  }
}

function setConfigPath(dotted, value, reason) {
  let doc
  try { doc = readConfig().doc } catch (e) { return { ok: false, error: e.message } }
  const keys = dotted.split('.')
  let node = doc
  // 第一段如果是插件条目名（name:instanceId），必须落到 plugins 下面，否则会写成顶层野键
  const firstKey = keys[0]
  const looksLikeEntry = /^[\w@.\-]+:[a-z0-9]+$/.test(firstKey)
  if (looksLikeEntry && doc.plugins && typeof doc.plugins === 'object') node = doc.plugins
  for (const k of keys.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {}
    node = node[k]
  }
  node[keys[keys.length - 1]] = value
  return writeConfig(yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' }), reason || 'set:' + dotted)
}

function rollbackConfig() {
  ensureDir(BACKUP_DIR)
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.yml')).sort().reverse()
  for (const f of files) {
    try { validate(readText(path.join(BACKUP_DIR, f))) } catch { continue }
    fs.copyFileSync(path.join(BACKUP_DIR, f), configPath())
    return { ok: true, from: f }
  }
  return { ok: false, error: '没有可用备份' }
}

/* ================================================================== *
 * 微内核服务
 * ================================================================== */
class AlisonCore {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.platforms = new Map()
    this.interceptors = []
    this.setupSteps = []
    this.watchers = []
    this.lastApply = null
    this.startedAt = Date.now()
    this.registry = new PluginRegistry(ctx, this)
  }

  registerPlatform(meta) {
    if (!meta || !meta.id) throw new Error('registerPlatform 需要 id')
    this.platforms.set(meta.id, { ...meta, registeredAt: Date.now() })
    logger?.info(`已注册对话平台：${meta.title || meta.id}`)
    return () => this.platforms.delete(meta.id)
  }

  registerChatInterceptor(fn, meta) {
    const item = {
      fn,
      meta: meta || {},
      id: (meta && meta.id) || 'interceptor-' + (this.interceptors.length + 1),
      priority: Number((meta && meta.priority) || 0)
    }
    this.interceptors.push(item)
    // 数值大的先跑（首次部署引导要抢在最前面，否则会被别的插件把消息吃掉）
    this.interceptors.sort((a, b) => b.priority - a.priority)
    logger?.info(`已注册对话拦截器：${item.id}${item.priority ? '（优先级 ' + item.priority + '）' : ''}`)
    return () => { const i = this.interceptors.indexOf(item); if (i >= 0) this.interceptors.splice(i, 1) }
  }

  registerSetupStep(step) {
    if (!step || !step.id) throw new Error('registerSetupStep 需要 id')
    this.setupSteps.push(step)
    return () => { const i = this.setupSteps.indexOf(step); if (i >= 0) this.setupSteps.splice(i, 1) }
  }

  /** 依次跑对话拦截器：null=继续正常流程；{handled,reply}=直接回；{system}=附加系统提示后继续 */
  async runInterceptors(payload) {
    for (const item of this.interceptors) {
      try {
        const res = await item.fn(payload, this)
        if (res) return res
      } catch (e) { logger?.warn(`拦截器 ${item.id} 出错：${e.message}`) }
    }
    return null
  }

  /* ---------- 配置热更新 ---------- */
  applyConfig({ text, dotted, value, reason } = {}) {
    const res = text != null ? writeConfig(text, reason) : setConfigPath(dotted, value, reason)
    if (!res.ok) return res
    this.lastApply = { at: Date.now(), reason: reason || '', dotted: dotted || null }
    this.ctx.emit('alison/config-updated', { reason: reason || '', dotted: dotted || null })
    logger?.info('配置已热更新' + (dotted ? `（${dotted}）` : ''))
    return { ...res, hot: true }
  }

  reloadFromDisk(reason) {
    try {
      const { doc } = readConfig()
      this.lastApply = { at: Date.now(), reason: reason || 'external' }
      this.ctx.emit('alison/config-updated', { reason: reason || 'external', doc })
      logger?.info('检测到配置变化，已热应用')
      return { ok: true, hot: true }
    } catch (e) {
      logger?.warn('配置解析失败，保持旧配置不动：' + e.message)
      return { ok: false, error: e.message }
    }
  }

  watchConfig() {
    if (!this.config.watch) return
    try {
      let timer = null
      const w = fs.watch(path.dirname(configPath()), (evt, name) => {
        if (name && name !== path.basename(configPath())) return
        clearTimeout(timer)
        timer = setTimeout(() => this.reloadFromDisk('watch'), 400)
      })
      this.watchers.push(w)
      logger?.info('已监听 alison.yml（保存即热生效）')
    } catch (e) { logger?.warn('无法监听配置：' + e.message) }
  }

  /** 监听插件目录：丢文件进去就自动热加载 */
  watchPlugins(env) {
    if (!this.config.watchPlugins) return
    try {
      ensureDir(PLUGIN_DIR)
      let timer = null
      const w = fs.watch(PLUGIN_DIR, { recursive: true }, () => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
          const res = await this.registry.hotReload(env)
          if (res.added.length || res.removed.length) {
            logger?.info(`插件目录变化：+${res.added.join(',') || '-'} -${res.removed.join(',') || '-'}`)
            this.ctx.emit('alison/plugins-changed', res)
          }
        }, 600)
      })
      this.watchers.push(w)
      logger?.info(`已监听插件目录（丢文件即热加载）：${PLUGIN_DIR.replace(ROOT, '.')}`)
    } catch (e) { logger?.warn('无法监听插件目录：' + e.message) }
  }

  async reloadPlugin(name) {
    const res = await this.registry.hotReload()
    return { ok: true, how: 'registry.hotReload', added: res.added, removed: res.removed, errors: res.errors }
  }

  status() {
    return {
      version: pkgVersion(),
      root: ROOT,
      appDir: APP_DIR,
      configFile: configPath(),
      pluginDir: PLUGIN_DIR,
      startedAt: this.startedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      platforms: [...this.platforms.values()].map((p) => ({ id: p.id, title: p.title, kind: p.kind })),
      interceptors: this.interceptors.map((i) => i.id),
      setupSteps: this.setupSteps.map((s) => ({ id: s.id, title: s.title, done: typeof s.done === 'function' ? !!s.done() : !!s.done })),
      plugins: this.registry.info(),
      loadErrors: this.registry.errors,
      ignored: this.registry.ignored,
      lastApply: this.lastApply,
      watch: { config: !!this.config.watch, plugins: !!this.config.watchPlugins }
    }
  }
}

function pkgVersion() {
  try { return (JSON.parse(readText(path.join(APP_DIR, 'package.json')) || '{}').version) || '0.0.1' }
  catch { return '0.0.1' }
}

/* ================================================================== *
 * 插件入口
 * ================================================================== */
const name = 'alison-core'
const inject = { optional: ['server', 'chatluna', 'database'] }

const Config = Schema.object({
  watch: Schema.boolean().default(true).description('监听 alison.yml 变化并热应用（保存即生效）'),
  watchPlugins: Schema.boolean().default(true).description('监听 plugins/alison 目录（丢文件即热加载）'),
  hotApply: Schema.boolean().default(true).description('允许通过接口/对话改配置后立即生效'),
  allowRemote: Schema.boolean().default(false).description('允许非本机访问微内核接口'),
  ownerIds: Schema.array(Schema.string()).default([]).description('管理员 QQ 号（留空则自动沿用各插件里已配的 ownerIds）'),
  adminIdentities: Schema.array(Schema.string()).default(['owner']).description('管理员网页身份 id（默认 owner = 「我（主人）」）')
})

async function apply(ctx, config) {
  logger = ctx.logger('alison-core')
  // 插件文件在工作区，依赖在 app 目录：把 app 的 node_modules 加进全局解析路径，
  // 这样工作区插件里的 require('koishi-plugin-...') 也能找到
  try {
    const appModules = path.join(APP_DIR, 'node_modules')
    process.env.NODE_PATH = process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter + appModules : appModules
    require('node:module').Module._initPaths()
  } catch { /* ignore */ }
  ensureDir(STATE_DIR); ensureDir(BACKUP_DIR); ensureDir(PLUGIN_DIR)

  const core = new AlisonCore(ctx, config)
  // Cordis 的作用域是隔离的：注册到 root，兄弟插件才拿得到 ctx.alison
  const rootCtx = ctx.root || ctx
  if (rootCtx.set) rootCtx.set('alison', core)
  rootCtx.alison = core
  ctx.alison = core
  const env = { core, root: ROOT, appDir: APP_DIR, logger, config, defineAlisonPlugin }

  core.watchConfig()

  /* ---------------- 管理员（单一事实来源，issue #3） ---------------- */
  const readYaml = () => { try { return require('js-yaml').load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {} } catch { return {} } }
  /** 从其它插件里捞旧配置的 ownerIds（向后兼容，不写回、只当兜底） */
  const legacyOwnerIds = () => {
    const ids = new Set()
    const doc = readYaml()
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n)) {
        if (/^(ownerIds|allowUserIds|adminIds)$/i.test(k.replace(/^~/, '')) && Array.isArray(v)) for (const x of v) if (String(x)) ids.add(String(x))
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    return [...ids]
  }
  /** 管理员名单：每次调用都读配置文件里的 alison-core 条目（改完即时生效，不吃闭包旧值） */
  const coreEntryCfg = () => {
    try {
      const doc = readYaml()
      let hit = null
      ;(function walk(n) {
        if (!n || typeof n !== 'object' || hit) return
        for (const [k, v] of Object.entries(n)) {
          if (k.replace(/^~/, '').split(':')[0] === 'alison-core' && v && typeof v === 'object') { hit = v; return }
          if (v && typeof v === 'object') walk(v)
        }
      })(doc.plugins)
      return hit || {}
    } catch { return {} }
  }
  const adminCfg = () => {
    const f = coreEntryCfg()
    const ownerIds = (Array.isArray(f.ownerIds) && f.ownerIds.length ? f.ownerIds : (config.ownerIds || [])).map(String).filter(Boolean)
    const ai = (Array.isArray(f.adminIdentities) && f.adminIdentities.length ? f.adminIdentities : config.adminIdentities) || ['owner']
    return { ownerIds, adminIdentities: ai.map(String), fromFile: Array.isArray(f.ownerIds) && f.ownerIds.length > 0 }
  }
  const admin = {
    info() {
      const c = adminCfg()
      const legacy = legacyOwnerIds()
      return { ownerIds: c.ownerIds.length ? c.ownerIds : legacy, adminIdentities: c.adminIdentities, fromCore: c.ownerIds.length > 0, legacy }
    },
    /** isAdmin({identityId}) / isAdmin({userId}) / isAdmin({session}) / isAdmin('12345') */
    isAdmin(arg) {
      const c = adminCfg()
      if (arg && typeof arg === 'object' && arg.identityId != null) return c.adminIdentities.includes(String(arg.identityId))
      const owners = c.ownerIds.length ? c.ownerIds : legacyOwnerIds()
      const id = arg && typeof arg === 'object' ? (arg.userId || (arg.session && arg.session.userId)) : arg
      if (id && owners.map(String).includes(String(id))) return true
      const sess = arg && typeof arg === 'object' ? arg.session : null
      if (sess && typeof sess.authority === 'number' && sess.authority >= 4) return true
      return false
    }
  }
  core.admin = admin
  try { ctx.server.get('/alison/api/core/admins', (koa) => { koa.body = Object.assign({ ok: true }, admin.info()) }) } catch { /* ignore */ }
  try {
    ctx.server.post('/alison/api/core/admins', (koa) => {
      const b = koa.request.body || {}
      const doc = readYaml()
      let entry = null
      ;(function walk(n) {
        if (!n || typeof n !== 'object' || entry) return
        for (const k of Object.keys(n)) { if (k.replace(/^~/, '').split(':')[0] === 'alison-core') { entry = k.replace(/^~/, ''); return } }
      })(doc.plugins)
      if (!entry) return (koa.body = { ok: false, error: '配置里找不到 alison-core 条目' })
      const writes = []
      if (Array.isArray(b.ownerIds)) writes.push(core.applyConfig({ dotted: entry + '.ownerIds', value: b.ownerIds.map(String), reason: 'admins:ownerIds' }))
      if (Array.isArray(b.adminIdentities)) writes.push(core.applyConfig({ dotted: entry + '.adminIdentities', value: b.adminIdentities.map(String), reason: 'admins:identities' }))
      koa.body = { ok: writes.every((w) => w && w.ok), writes, info: admin.info() }
    })
  } catch { /* ignore */ }

  ctx.on('dispose', () => { for (const w of core.watchers) { try { w.close() } catch { /* ignore */ } } })

  // 启动时扫描并加载 workspace/plugins/alison/ 下的插件
  const res = await core.registry.startAll(env)
  if (res.errors.length) logger.warn(`有 ${res.errors.length} 个插件加载失败：\n  ` + res.errors.join('\n  '))
  logger.info(`已加载 Alison 插件 ${res.total} 个，忽略 ${core.registry.ignored.length} 个`)
  core.watchPlugins(env)

  ctx.command('alison.status', '看 AlisonBot 微内核状态').action(() => {
    const s = core.status()
    return [
      `AlisonBot ${s.version}（运行 ${s.uptimeSec}s）`,
      `对话平台：${s.platforms.map((p) => p.title || p.id).join(', ') || '无'}`,
      `拦截器：${s.interceptors.join(', ') || '无'}`,
      `已加载插件：${s.plugins.map((p) => p.name).join(', ') || '无'}`,
      `热监听：配置 ${s.watch.config ? '开' : '关'} / 插件 ${s.watch.plugins ? '开' : '关'}`,
      s.loadErrors.length ? `加载错误：${s.loadErrors.join(' ；')}` : ''
    ].filter(Boolean).join('\n')
  })

  ctx.command('alison.reload', '重新读盘并热应用配置').action(() => {
    const r = core.reloadFromDisk('command')
    return r.ok ? '配置已重新读盘并热应用' : '失败：' + r.error
  })

  ctx.command('alison.plugins', '列出/热重载 Alison 插件').action(async () => {
    const r = await core.registry.hotReload(env)
    return `插件 ${r.total} 个（新增 ${r.added.length}、移除 ${r.removed.length}）` +
      (r.errors.length ? `\n错误：${r.errors.join(' ；')}` : '')
  })

  ctx.inject(['server'], (serverCtx) => {
    const base = '/alison/api/core'
    const guard = (koa) => {
      if (config.allowRemote) return true
      const ip = koa.request?.ip || koa.ip || ''
      if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return true
      koa.status = 403; koa.body = { error: '仅允许本机' }; return false
    }
    const wrap = (fn) => async (koa) => {
      if (!guard(koa)) return
      try { koa.body = await fn(koa) } catch (e) { koa.status = 500; koa.body = { ok: false, error: e.message } }
    }
    serverCtx.server.get(base + '/status', wrap(async () => ({ ok: true, ...core.status() })))
        // ---- 管理员（issue #3）：单一事实来源就是 alison-core 自己的配置 ----
        serverCtx.server.get(base + '/admins', wrap(async () => Object.assign({ ok: true }, admin.info())))
        serverCtx.server.post(base + '/admins', wrap(async (koa) => {
          const b = koa.request.body || {}
          const doc = readYaml()
          let entry = null
          ;(function findEntry(n) {
            if (!n || typeof n !== 'object' || entry) return
            for (const k of Object.keys(n)) {
              if (k.replace(/^~/, '').split(':')[0] === 'alison-core') { entry = k.replace(/^~/, ''); return }
            }
          })(doc.plugins)
          if (!entry) return { ok: false, error: '配置里找不到 alison-core 条目' }
          const writes = []
          if (Array.isArray(b.ownerIds)) writes.push(core.applyConfig({ dotted: entry + '.ownerIds', value: b.ownerIds.map(String), reason: 'admins:ownerIds' }))
          if (Array.isArray(b.adminIdentities)) writes.push(core.applyConfig({ dotted: entry + '.adminIdentities', value: b.adminIdentities.map(String), reason: 'admins:identities' }))
          return { ok: writes.every((w) => w && w.ok), writes, info: admin.info() }
        }))
    serverCtx.server.get(base + '/config', wrap(async () => ({ ok: true, text: readText(configPath()), file: configPath() })))
    serverCtx.server.post(base + '/config', wrap(async (koa) => {
      if (!config.hotApply) return { ok: false, error: '热更新已被插件配置关闭' }
      const b = koa.request.body || {}
      if (typeof b.text === 'string') return core.applyConfig({ text: b.text, reason: 'api' })
      if (b.dotted) return core.applyConfig({ dotted: b.dotted, value: b.value, reason: 'api' })
      return { ok: false, error: '需要 text 或 dotted+value' }
    }))
    serverCtx.server.post(base + '/rollback', wrap(async () => rollbackConfig()))
    serverCtx.server.post(base + '/plugins/reload', wrap(async () => core.registry.hotReload(env)))
    serverCtx.server.get(base + '/plugins', wrap(async () => ({ ok: true, plugins: core.registry.info(), errors: core.registry.errors, ignored: core.registry.ignored, dir: PLUGIN_DIR })))
    logger.info(`微内核接口：${base}/*`)
  })

  logger.info(`AlisonBot 微内核就绪（${ROOT}；插件目录 ${PLUGIN_DIR.replace(ROOT, '.')}）`)
}

module.exports = { name, inject, Config, apply, defineAlisonPlugin }
module.exports.default = module.exports
module.exports.__internals = { readConfig, writeConfig, setConfigPath, rollbackConfig, AlisonCore, PluginRegistry, defineAlisonPlugin, PLUGIN_DIR }
