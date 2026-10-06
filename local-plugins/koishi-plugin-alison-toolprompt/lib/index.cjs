/**
 * koishi-plugin-alison-toolprompt —— 插件工具提示词（与 system prompt 分开保存、正常注入）
 *
 * 每装一个插件，就为它生成（或更新）一份独立的工具说明：
 *   data/alison-prompt/tools/<插件名>.md
 * · 与系统提示词分开存 ✓，但会拼进系统提示词一起注入 ✓
 * · 装新插件时按插件自己的文档/描述自动写一段（有模型就让模型写，没有就走模板）✓
 * · 插件被移除/停用时自动删掉对应说明（sync 自愈）✓
 * · 给 Alison 一个 alison_toolprompt 工具，她可以自己改这些说明 ✓
 */
const fs = require('fs')
const path = require('path')
const { Schema } = require('koishi')

const name = 'alison-toolprompt'
const inject = { required: ['server'], optional: ['chatluna', 'database'] }

const ROOT = process.env.ALISON_WORKSPACE || process.cwd()
const DIR = path.join(ROOT, 'data', 'alison-prompt', 'tools')
const PRESET = path.join(ROOT, 'data', 'chathub', 'character', 'presets', 'Alison.yml')
const MARK = '<!-- alison-tool-prompts -->'

function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ } }
function safeId(s) { return String(s || '').replace(/^koishi-plugin-/, '').replace(/[^\w.-]/g, '_').slice(0, 80) }

function list() {
  const out = []
  try {
    for (const f of fs.readdirSync(DIR)) {
      if (!/\.md$/i.test(f)) continue
      const p = path.join(DIR, f)
      let text = ''
      try { text = fs.readFileSync(p, 'utf8') } catch { /* ignore */ }
      out.push({ id: f.replace(/\.md$/i, ''), file: p, bytes: text.length, preview: text.split('\n').slice(0, 3).join(' / ').slice(0, 120) })
    }
  } catch { /* 目录不存在 */ }
  return out
}
function read(id) { try { return fs.readFileSync(path.join(DIR, safeId(id) + '.md'), 'utf8') } catch { return '' } }

/** 拼成可直接注入系统提示词的一块（平台网页与 QQ 两侧共用） */
function assemble() {
  const items = list()
  if (!items.length) return ''
  const parts = ['## 我装的插件能做什么（随插件自动生成，可改）', '']
  for (const it of items) {
    const body = read(it.id).trim()
    if (!body) continue
    parts.push('### ' + it.id)
    parts.push(body)
    parts.push('')
  }
  return parts.join('\n').trim()
}

/** 写回 ChatLuna 角色预设：把标记块替换掉（QQ 侧也生效） */
function syncPreset() {
  try {
    if (!fs.existsSync(PRESET)) return { ok: false, error: '没有角色预设' }
    const yaml = require('js-yaml')
    const doc = yaml.load(fs.readFileSync(PRESET, 'utf8'))
    if (!doc || typeof doc.system !== 'string') return { ok: false, error: '预设结构不符' }
    const block = assemble()
    const i = doc.system.indexOf(MARK)
    const base = (i >= 0 ? doc.system.slice(0, i) : doc.system).replace(/\s+$/, '')
    doc.system = block ? base + '\n\n' + MARK + '\n' + block + '\n' : base + '\n'
    fs.writeFileSync(PRESET, yaml.dump(doc, { lineWidth: -1, noRefs: true }), 'utf8')
    return { ok: true, bytes: block.length }
  } catch (e) { return { ok: false, error: e.message } }
}

function write(id, text, meta) {
  const key = safeId(id)
  if (!key) return { ok: false, error: '插件名不能为空' }
  ensureDir(DIR)
  const head = '<!-- 插件工具说明：' + key + (meta && meta.source ? ' · 来源 ' + meta.source : '') + ' · ' + new Date().toISOString() + ' -->\n'
  fs.writeFileSync(path.join(DIR, key + '.md'), head + String(text || '').trim() + '\n', 'utf8')
  const p = syncPreset()
  return { ok: true, id: key, file: path.join(DIR, key + '.md'), preset: p }
}

function remove(id) {
  const key = safeId(id)
  const p = path.join(DIR, key + '.md')
  if (!fs.existsSync(p)) return { ok: false, error: '没有 ' + key + ' 的说明' }
  try { fs.unlinkSync(p) } catch (e) { return { ok: false, error: e.message } }
  const s = syncPreset()
  return { ok: true, id: key, preset: s }
}

/** 插件目录里有哪些插件（用于自愈：装了没说明→生成；说明没插件→删） */
function appDirPath() {
  try {
    const m = String(process.argv[1] || '').replace(/\\/g, '/').match(/^(.*)\/node_modules\/koishi\//)
    if (m) return m[1]
  } catch { /* ignore */ }
  return path.join(ROOT, 'app')
}

function installedPlugins() {
  const APP = appDirPath()
  const dirs = [
    path.join(APP, 'node_modules'),
    path.join(ROOT, 'node_modules'),
    path.join(ROOT, 'app', 'node_modules'),
    path.dirname(APP)
  ]
  const out = new Map()
  for (const d of dirs) {
    try {
      for (const n of fs.readdirSync(d)) {
        if (!/^koishi-plugin-/.test(n)) continue
        const pkg = path.join(d, n, 'package.json')
        if (!fs.existsSync(pkg)) continue
        try { out.set(n, JSON.parse(fs.readFileSync(pkg, 'utf8'))) } catch { out.set(n, {}) }
      }
    } catch { /* ignore */ }
  }
  return out
}

/** 按插件自己的文档/描述写一段工具说明；有模型就让模型润色，没有就用模板 */
async function generate(ctx2, pluginName, opts) {
  const key = safeId(pluginName)
  const full = 'koishi-plugin-' + key
  const inst = installedPlugins()
  const pkg = inst.get(full) || inst.get(pluginName) || null
  if (!pkg) return { ok: false, error: '没找到插件 ' + full + '（先装上）' }
  const desc = (pkg.koishi && pkg.koishi.description && (pkg.koishi.description.zh || pkg.koishi.description.en)) || pkg.description || ''
  let readme = ''
  for (const cand of ['README.md', 'readme.md', 'README_CN.md']) {
    const dirs = [path.join(appDirPath(), 'node_modules', full, cand), path.join(ROOT, 'node_modules', full, cand)]
    for (const f of dirs) if (fs.existsSync(f)) { readme = fs.readFileSync(f, 'utf8').slice(0, 4000); break }
    if (readme) break
  }
  const facts = '插件：' + full + '\n版本：' + (pkg.version || '?') + '\n描述：' + desc + (readme ? '\n文档节选：\n' + readme.replace(/\s+/g, ' ').slice(0, 1200) : '')
  let text = ''
  if ((!opts || opts.useModel !== false) && ctx2 && ctx2.chatluna) {
    try {
      const model = (await ctx2.chatluna.createChatModel((opts && opts.model) || 'deepseek/deepseek-chat'))?.value
      if (model) {
        const r = await model.invoke([
          { role: 'system', content: '你在给一个聊天机器人写"插件用法说明"。用中文写 3~6 行，只写：这个插件让她能做什么、什么时候该用它、有什么注意事项。不要客套、不要标题、不要 markdown 代码块。' },
          { role: 'user', content: facts }
        ])
        text = String((r && r.content) || '').trim()
      }
    } catch { /* 模型不可用就走模板 */ }
  }
  if (!text) {
    text = ['插件 `' + full + '`' + (pkg.version ? '（v' + pkg.version + '）' : '') + ' 已安装。',
      desc ? '它提供：' + String(desc).replace(/\s+/g, ' ').slice(0, 200) : '',
      '需要用到相关能力时优先用它；具体参数以工具列表为准，不确定就先看一眼可用工具。'].filter(Boolean).join('\n')
  }
  const w = write(key, text, { source: 'auto' })
  return { ok: true, id: key, generated: true, usedModel: !!text && (!opts || opts.useModel !== false), ...w }
}

/** 自愈：装了没说明 → 生成；说明对应插件没了 → 删掉 */
async function sync(ctx2, opts) {
  const inst = installedPlugins()
  const have = list()
  const removed = []
  const added = []
  for (const it of have) {
    if (!inst.has('koishi-plugin-' + it.id) && !inst.has(it.id)) {
      const r = remove(it.id)
      if (r.ok) removed.push(it.id)
    }
  }
  for (const p of inst.keys()) {
    const id = safeId(p)
    if (!have.find((h) => h.id === id)) {
      if ((!opts || opts.generate !== false) && opts && opts.generate === false) continue
      const g = await generate(ctx2, p, { useModel: false })
      if (g.ok) added.push(id)
    }
  }
  return { ok: true, removed, added, total: list().length }
}

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用（关掉则不再自动生成/注入插件说明）'),
  autoGenerate: Schema.boolean().default(true).description('装插件后自动写工具说明'),
  autoRemove: Schema.boolean().default(true).description('插件移除后自动删掉对应说明'),
  useModel: Schema.boolean().default(true).description('生成时让模型按插件文档润色（关掉则用模板）'),
  model: Schema.string().default('deepseek/deepseek-chat').description('用于生成说明的模型'),
  injectIntoPreset: Schema.boolean().default(true).description('同时写进 ChatLuna 角色预设（QQ 侧也生效）')
})

async function apply(ctx, config) {
  const logger = ctx.logger ? ctx.logger(name) : console
  ensureDir(DIR)
  const base = '/alison'

  const service = {
    list, read, assemble, write, remove, generate: (n, o) => generate(ctx, n, o), sync: (o) => sync(ctx, o),
    syncPreset, dir: DIR, active: () => config.enabled !== false
  }
  try { ctx.root.set('alisonToolPrompt', service) } catch { /* ignore */ }

  // 启动时把已有说明同步进预设（保证 QQ 侧也带上）
  if (config.enabled !== false && config.injectIntoPreset !== false) {
    try { syncPreset() } catch { /* ignore */ }
  }

  /* ---- HTTP ---- */
  ctx.server.get(base + '/api/toolprompt/list', async (koa) => {
    koa.body = { ok: true, dir: DIR, items: list(), assembled: assemble(), enabled: config.enabled !== false }
  })
  ctx.server.post(base + '/api/toolprompt/save', async (koa) => {
    const b = koa.request.body || {}
    koa.body = write(b.id || b.plugin, b.text, { source: 'manual' })
  })
  ctx.server.post(base + '/api/toolprompt/remove', async (koa) => {
    const b = koa.request.body || {}
    koa.body = remove(b.id || b.plugin)
  })
  ctx.server.post(base + '/api/toolprompt/generate', async (koa) => {
    const b = koa.request.body || {}
    koa.body = await generate(ctx, b.plugin || b.id, { useModel: config.useModel !== false, model: config.model })
  })
  ctx.server.post(base + '/api/toolprompt/sync', async (koa) => {
    koa.body = await sync(ctx, { generate: config.autoGenerate !== false })
  })

  /* ---- 工具 ---- */
  ctx.inject(['chatluna'], (ctx2) => {
    try {
      const platform = ctx2.chatluna && ctx2.chatluna.platform
      if (!platform || typeof platform.registerTool !== 'function') return
      const { StructuredTool } = require('@langchain/core/tools')
      const { z } = require('zod')
      const tool = new (class extends StructuredTool {
        name = 'alison_toolprompt'
        description = '管理"插件工具说明"（和系统提示词分开保存、会一起注入）：list 列出、read 读某个、save 手写某个插件的说明、generate 按插件文档自动生成、remove 删除、sync 自愈（插件卸了自动删、装了自动补）。装了新插件后用它写一段说明，我以后就知道怎么用那个插件了。'
        schema = z.object({
          action: z.enum(['list', 'read', 'save', 'generate', 'remove', 'sync']).describe('要做什么'),
          plugin: z.string().optional().describe('插件名（如 chatluna-livingmemory 或 koishi-plugin-…）'),
          text: z.string().optional().describe('save 时的说明正文')
        })
        async _call({ action, plugin, text }) {
          try {
            if (action === 'list') return JSON.stringify(list())
            if (action === 'read') return read(plugin) || '（没有这份说明）'
            if (action === 'save') return JSON.stringify(write(plugin, text, { source: 'alison' }))
            if (action === 'generate') return JSON.stringify(await generate(ctx, plugin, { useModel: config.useModel !== false, model: config.model }))
            if (action === 'remove') return JSON.stringify(remove(plugin))
            if (action === 'sync') return JSON.stringify(await sync(ctx, { generate: config.autoGenerate !== false }))
            return '未知操作'
          } catch (e) { return '工具说明操作失败：' + e.message }
        }
      })()
      platform.registerTool(tool.name, {
        name: tool.name, description: tool.description, selector: () => true,
        createTool: () => tool, meta: { source: 'alison-toolprompt', group: 'Alison 自我管理' }
      })
      logger.info('已注册工具：alison_toolprompt（插件说明与系统提示词分开存、一起注入）')
    } catch (e) { logger.warn('注册 toolprompt 工具失败：' + e.message) }
  })

  // 自愈轮询：装了新插件自动补说明，插件卸了自动删说明（不依赖任何插桩）
  if (config.enabled !== false && (config.autoGenerate !== false || config.autoRemove !== false)) {
    const tick = async () => {
      try { await sync(ctx, { generate: config.autoGenerate !== false }) } catch { /* ignore */ }
    }
    setTimeout(tick, 20000)
    const timer = setInterval(tick, 60000)
    try { ctx.on('dispose', () => clearInterval(timer)) } catch { /* ignore */ }
  }

  logger.info(`插件工具说明就绪：${list().length} 份，目录 ${DIR}，自动生成=${config.autoGenerate !== false}，自动删除=${config.autoRemove !== false}`)
}
module.exports = { name, inject, Config, apply }
module.exports.name = name
module.exports.inject = inject
module.exports.Config = Config
module.exports.apply = apply
