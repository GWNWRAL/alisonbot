/**
 * koishi-plugin-alison-persona —— 人设插件
 *
 * 微内核里"人设"也是一个插件：她负责
 *   · 列出/读取 data/chathub/character/presets 下的人设
 *   · 切换当前人设，并把内容真正写进两处生效点（网页聊天的 systemPrompt + ChatLuna 角色预设的 system）
 *   · 编辑/新建人设（带备份）
 *   · 给 Alison 一个自己就能用的工具 alison_persona（list / current / switch / save / read）
 *   · 监听人设目录，改文件即热生效
 */
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { Schema } = require('koishi')

const name = 'alison-persona'
const inject = { required: ['server'], optional: ['chatluna', 'database'] }

const ROOT = process.env.ALISON_WORKSPACE || process.cwd()
const PRESET_DIR = path.join(ROOT, 'data', 'chathub', 'character', 'presets')
const DATA_DIR = path.join(ROOT, 'data', 'alison-persona')
const ACTIVE_FILE = path.join(DATA_DIR, 'active.json')
const CURRENT_MD = path.join(DATA_DIR, 'current.md')
const WEB_SETTINGS = path.join(ROOT, 'data', 'alison-platform-web', 'settings.json')
const BACKUP_DIR = path.join(ROOT, 'data', 'alison-core', 'backups')
const MARKER = '<!-- alison-persona -->'
const LEGACY_MARKER = '<!-- alison-onboarding -->'

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用人设插件'),
  defaultPersona: Schema.string().default('Alison').description('没有手动指定时用哪个人设'),
  pruneLength: Schema.number().default(12000).description('人设文本最长保留多少字符（超出截断）')
})

/* ------------------------------ 小工具 ------------------------------ */
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* ignore */ } }
function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
function readJson(f, dft) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dft } }
function writeJson(f, v) { ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8') }
function stripPersonaBlocks(text) {
  // 把历史遗留的人设块（连同尾部的 --- 分隔线）剥掉，保证反复应用不会越写越长
  let t = String(text || '')
  let cut = -1
  for (const m of [MARKER, LEGACY_MARKER]) {
    const i = t.indexOf(m)
    if (i >= 0 && (cut < 0 || i < cut)) cut = i
  }
  if (cut >= 0) t = t.slice(0, cut)
  return t.replace(/[\s\u2014-]*$/, '').replace(/\n-{3,}\s*$/, '')
}

function safeName(n) { return String(n || '').replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60) }

function listPresets() {
  const out = []
  try {
    for (const f of fs.readdirSync(PRESET_DIR)) {
      if (!/\.ya?ml$/i.test(f)) continue
      const full = path.join(PRESET_DIR, f)
      let doc = null
      try { doc = yaml.load(readText(full)) } catch { doc = null }
      const base = f.replace(/\.ya?ml$/i, '')
      out.push({
        name: base,
        file: f,
        nickNames: (doc && doc.nick_name) || [],
        systemLength: typeof (doc && doc.system) === 'string' ? doc.system.length : 0,
        title: (doc && doc.name) || base
      })
    }
  } catch { /* 目录不存在 */ }
  return out
}

function activeName(config) {
  const a = readJson(ACTIVE_FILE, null)
  if (a && a.name) return a.name
  const names = listPresets().map((p) => p.name)
  if (names.includes(config && config.defaultPersona)) return config.defaultPersona
  if (names.includes('Alison')) return 'Alison'
  return names[0] || null
}

function getPreset(n) {
  const safe = safeName(n)
  for (const ext of ['.yml', '.yaml']) {
    const f = path.join(PRESET_DIR, safe + ext)
    if (fs.existsSync(f)) {
      let doc = null
      try { doc = yaml.load(readText(f)) } catch { doc = null }
      return { name: safe, file: f, doc, system: (doc && typeof doc.system === 'string') ? doc.system : readText(f) }
    }
  }
  return null
}

/** 把人设写进"真正生效"的地方：网页聊天 systemPrompt + ChatLuna 角色预设 system */
function applyPersona(personaName, systemText) {
  const results = {}
  const limit = Number((config && config.pruneLength) || 12000)
  const body = String(systemText || '').trim()
  const block = MARKER + '\n' + (body.length > limit ? body.slice(0, limit) + '\n（人设过长已截断）' : body)

  // 1) 落盘一份当前人设，方便别的插件/工具读
  ensureDir(DATA_DIR)
  fs.writeFileSync(CURRENT_MD, block + '\n', 'utf8')
  results.file = CURRENT_MD

  // 2) 网页聊天
  try {
    const settings = readJson(WEB_SETTINGS, {})
    const cleanBase = stripPersonaBlocks(settings.systemPromptBase || settings.systemPrompt || '')
    settings.systemPromptBase = cleanBase
    const nextPrompt = [cleanBase, '', '---', '', block].filter(Boolean).join('\n')
    if (settings.systemPrompt !== nextPrompt) {
      settings.systemPrompt = nextPrompt
      writeJson(WEB_SETTINGS, settings)
      results.web = true
    } else { results.web = 'unchanged' }
  } catch (e) { results.webError = e.message }

  // 3) ChatLuna 角色预设：把 system 里的旧人设块换掉（保留原有基础人设）
  try {
    const preset = getPreset(personaName || 'Alison')
    if (preset) {
      ensureDir(BACKUP_DIR)
      try { fs.copyFileSync(preset.file, path.join(BACKUP_DIR, `preset-${preset.name}-${Date.now()}.yml`)) } catch { /* ignore */ }
      const doc = preset.doc && typeof preset.doc === 'object' ? preset.doc : {}
      const nextSystem = stripPersonaBlocks(doc.system || '') + '\n\n' + block + '\n'
      if (doc.system !== nextSystem) {
        doc.system = nextSystem
        fs.writeFileSync(preset.file, yaml.dump(doc, { lineWidth: -1, noRefs: true }), 'utf8')
        results.preset = preset.file
      } else { results.preset = 'unchanged' }
    }
  } catch (e) { results.presetError = e.message }

  // 4) 记下当前选的是谁
  writeJson(ACTIVE_FILE, { name: personaName || null, at: Date.now() })
  return results
}

/** 编辑/新建一个人设（结构化改 system，改前备份） */
function savePersona(n, systemText) {
  const safe = safeName(n)
  if (!safe) return { ok: false, error: '人设名不能为空' }
  ensureDir(PRESET_DIR)
  const file = path.join(PRESET_DIR, safe + '.yml')
  ensureDir(BACKUP_DIR)
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, path.join(BACKUP_DIR, `preset-${safe}-${Date.now()}.yml`)) } catch { /* ignore */ }
  }
  let doc = null
  try { doc = yaml.load(readText(file)) } catch { doc = null }
  if (!doc || typeof doc !== 'object') {
    doc = {
      name: safe,
      nick_name: [safe],
      input: '{{user}}说：{{input}}',
      system: ''
    }
  }
  doc.system = String(systemText || '')
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1, noRefs: true }), 'utf8')
  return { ok: true, file, name: safe }
}

/* ------------------------------ 插件主体 ------------------------------ */
async function apply(ctx, config) {
  if (config.enabled === false) { ctx.logger.info('人设插件已禁用'); return }
  const logger = ctx.logger ? ctx.logger(name) : console
  let watcher = null
  let applying = false
  let applyTimer = null
  const applyQuiet = (name2, text2) => {
    applying = true
    try { return applyPersona(name2, text2) } finally { setTimeout(() => { applying = false }, 500) }
  }
  const base = '/alison'

  const service = {
    list: () => listPresets(),
    active: () => activeName(config),
    current: () => {
      const n = activeName(config)
      const p = n ? getPreset(n) : null
      return { name: n, system: p ? p.system : '', file: p ? p.file : null }
    },
    switch: (n) => {
      const p = getPreset(n)
      if (!p) return { ok: false, error: `没有这个人设：${n}（可用：${listPresets().map((x) => x.name).join(', ')}）` }
      const r = applyQuiet(p.name, p.system || '')
      return { ok: true, name: p.name, applied: r }
    },
    save: (n, text) => {
      const r = savePersona(n, text)
      if (!r.ok) return r
      const applied = applyQuiet(r.name, text)
      return { ok: true, name: r.name, applied }
    },
    apply: (n, text) => applyQuiet(n, text),
    status: () => ({
      dir: PRESET_DIR,
      active: activeName(config),
      count: listPresets().length,
      currentFile: CURRENT_MD,
      watching: !!watcher
    })
  }

  // 挂到 root，其它插件（引导/自治）可以直接用她，而不是各自重写一遍
  try { ctx.root.set('alisonPersona', service) } catch { /* 老版本 */ }

  // 启动时把"当前人设"应用一次，保证两侧一致
  try {
    const cur = service.current()
    if (cur.name && cur.system) applyQuiet(cur.name, cur.system)
  } catch (e) { logger.warn('启动应用人设失败：' + e.message) }

  /* ---- HTTP 接口 ---- */
  ctx.server.get(base + '/api/persona/list', async (koa) => {
    koa.body = { ok: true, active: activeName(config), presets: listPresets(), status: service.status() }
  })
  ctx.server.get(base + '/api/persona/current', async (koa) => {
    const c = service.current()
    koa.body = { ok: true, name: c.name, file: c.file, system: String(c.system || '').slice(0, 6000), length: String(c.system || '').length }
  })
  ctx.server.post(base + '/api/persona/switch', async (koa) => {
    const b = koa.request.body || {}
    koa.body = service.switch(b.name)
  })
  ctx.server.post(base + '/api/persona/save', async (koa) => {
    const b = koa.request.body || {}
    koa.body = service.save(b.name, b.system)
  })

  /* ---- 给 Alison 一个她自己就能用的工具（等 chatluna 就绪再注册：它在配置里通常后加载） ---- */
  ctx.inject(['chatluna'], (ctx2) => {
  try {
    const platform = ctx2.chatluna && ctx2.chatluna.platform
    if (platform && typeof platform.registerTool === 'function') {
      const { StructuredTool } = require('@langchain/core/tools')
      const { z } = require('zod')
      const personaTool = new (class extends StructuredTool {
        name = 'alison_persona'
        description = '管理我的人设：list 列出所有人设、current 看当前人设、switch 切换（参数 name）、save 保存新的人设内容（参数 name + system）、read 读某个人设全文。切换后网页与 QQ 两侧立即生效。'
        schema = z.object({
          action: z.enum(['list', 'current', 'switch', 'save', 'read']).describe('要做的操作'),
          name: z.string().optional().describe('人设名（switch/save/read 用）'),
          system: z.string().optional().describe('新的人设正文（save 用）')
        })
        async _call({ action, name: pname, system }) {
          try {
            if (action === 'list') return JSON.stringify(listPresets())
            if (action === 'current') { const c = service.current(); return `当前人设：${c.name}\n\n${String(c.system).slice(0, 2000)}` }
            if (action === 'read') { const p = getPreset(pname); return p ? String(p.system).slice(0, 4000) : '没有这个人设' }
            if (action === 'switch') { const r = service.switch(pname); return JSON.stringify(r) }
            if (action === 'save') { const r = service.save(pname, system); return JSON.stringify(r) }
            return '未知操作'
          } catch (e) { return '人设操作失败：' + e.message }
        }
      })()
      platform.registerTool(personaTool.name, {
        name: personaTool.name,
        description: personaTool.description,
        selector: () => true,
        createTool: () => personaTool,
        meta: { source: 'alison-persona', group: 'Alison 自我管理' }
      })
      logger.info('已注册工具：alison_persona（仅管理用途）')
    }
  } catch (e) { logger.warn('注册人设工具失败（不影响接口）：' + e.message) }
  })

  /* ---- 监听人设目录：改文件即热生效 ---- */
  try {
    if (fs.existsSync(PRESET_DIR)) {
      watcher = fs.watch(PRESET_DIR, { persistent: false }, (evt, file) => {
        if (!file || !/\.ya?ml$/i.test(String(file))) return
        if (applying) return                       // 自己写自己触发的，忽略
        if (applyTimer) clearTimeout(applyTimer)
        applyTimer = setTimeout(() => {
          applyTimer = null
          if (applying) return
          logger.info(`人设文件变化：${file}（热生效）`)
          try {
            const cur = service.current()
            if (cur.name && cur.system) applyQuiet(cur.name, cur.system)
          } catch (e) { logger.warn('热应用人设失败：' + e.message) }
        }, 400)
      })
    }
  } catch (e) { logger.warn('监听人设目录失败：' + e.message) }

  logger.info(`人设插件就绪：${listPresets().length} 个人设，当前「${activeName(config)}」，热监听=${!!watcher}`)
  return () => { try { watcher && watcher.close() } catch { /* ignore */ } }
}

module.exports = { name, inject, Config, apply }
module.exports.name = name
module.exports.inject = inject
module.exports.Config = Config
module.exports.apply = apply
