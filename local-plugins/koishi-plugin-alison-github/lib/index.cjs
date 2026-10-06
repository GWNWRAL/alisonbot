'use strict'

/**
 * koishi-plugin-alison-github —— 让 Alison 自己去开源平台找东西、装上、并且改造自己
 *
 * 能力：
 *   1. alison_search          在 GitHub / npm 镜像里搜插件与项目（带类型猜测与打分）
 *   2. alison_repo            读一个仓库的元数据 + 文件清单 + README，判断它是什么插件
 *   3. alison_install_plugin  按类型自动安装：
 *        · Koishi 插件  → 走 npm 镜像下载解包（复用 alison-autonomy，无需包管理器）
 *        · Python 插件  → 按 AstrBot/NoneBot2/MaiBot/LangBot 归类，下载到 plugins/py/<框架>/
 *        · MCP 服务器   → 写进 chatluna-mcp-client 的 mcpServers 配置
 *   4. alison_selfedit        调整自身结构：用模板生成新插件、改自己插件的代码（备份 + 语法校验 + 失败回滚）
 *
 * 安全：
 *   · 工具默认只对管理员（ownerIds）可见，装任何东西前会说明"需要主人同意"
 *   · 改自己的代码：先备份 → 语法校验（vm 编译）→ 写盘 → 出错回滚
 *   · 装完自动体检（复用 alison-autonomy.diagnose），坏了能回滚配置
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const https = require('node:https')
const { execFileSync } = require('node:child_process')
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
const DIR = path.join(ROOT, 'data', 'alison-github')
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'alison')
const PY_ROOT = path.join(ROOT, 'plugins', 'py')
const CONFIG = resolveConfigFile_()
const NPM = 'https://registry.npmmirror.com'

let logger

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }) }
function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return null } }
function readJson(f, fb) { try { return JSON.parse(readText(f) || '') } catch { return fb } }
function writeJson(f, v) { ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8') }

/** GitHub token：优先环境变量，其次 data/alison-github/token.txt（没有也能用，只是限流更严） */
function ghToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env) return String(env).trim()
  const f = path.join(DIR, 'token.txt')
  return fs.existsSync(f) ? readText(f).trim() : ''
}

function httpGet(url, { json = true, headers = {}, redirect = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'AlisonBot',
        Accept: json ? 'application/vnd.github+json' : '*/*',
        ...(ghToken() ? { Authorization: `token ${ghToken()}` } : {}),
        ...headers
      }
    }
    https.get(url, opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect > 0) {
        res.resume()
        return resolve(httpGet(res.headers.location, { json, headers, redirect: redirect - 1 }))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`))
        if (!json) return resolve(buf)
        try { resolve(JSON.parse(buf.toString('utf8'))) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

/* ================================================================== *
 * 1) 搜索
 * ================================================================== */
const KIND_HINTS = [
  [/koishi/i, 'koishi'], [/nonebot/i, 'nonebot2'], [/astrbot/i, 'astrbot'],
  [/mai[-_]?bot|maicore/i, 'maibot'], [/langbot/i, 'langbot'], [/mcp|modelcontextprotocol/i, 'mcp']
]

function guessKind(text) {
  for (const [re, kind] of KIND_HINTS) if (re.test(text)) return kind
  return 'unknown'
}

async function search(query, { limit = 8, kind = null } = {}) {
  const out = []
  // GitHub 仓库
  try {
    const q = encodeURIComponent(`${query} in:name,description`)
    const r = await httpGet(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${limit}`)
    for (const it of r.items || []) {
      const blob = `${it.name} ${it.description || ''} ${(it.topics || []).join(' ')}`
      const k = guessKind(blob)
      if (kind && k !== kind) continue
      const nm = String(it.name || '').toLowerCase()
      const isPluginName = /(^koishi-plugin-|^nonebot-plugin-|astrbot|^mcp-|plugin-)/.test(nm)
      const isAwesome = /awesome|list|collection|skills?$|^skill$/.test(nm) || /awesome|收录|清单|大全/.test(it.description || '')
      const stars = it.stargazers_count || 0
      if (isAwesome || (!isPluginName && stars > 5000)) continue      // 清单类 / 巨型项目不是插件
      out.push({
        source: 'github', kind: k, name: it.full_name,
        pluginName: isPluginName,
        stars: it.stargazers_count, updated: (it.updated_at || '').slice(0, 10),
        lang: it.language, desc: it.description || '', url: it.html_url,
        topics: (it.topics || []).slice(0, 6),
        score: (isPluginName ? 3000 : 0) + (k !== 'unknown' ? 500 : 0) + Math.min(stars, 500)
      })
    }
  } catch (e) { out.push({ source: 'github', error: e.message }) }
  // npm 镜像（Koishi 插件多是 npm 包）
  try {
    const s = await httpGet(`${NPM}/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`)
    for (const o of s.objects || []) {
      const p = o.package
      if (!/koishi|chatluna/i.test(p.name)) continue
      out.push({
        source: 'npm', kind: 'koishi', name: p.name,
        stars: Math.round((o.score && o.score.final) * 100) || 0, updated: (p.date || '').slice(0, 10),
        desc: p.description || '', url: `https://www.npmjs.com/package/${p.name}`,
        version: p.version, score: Math.round((o.score && o.score.final) * 1000) || 0
      })
    }
  } catch (e) { out.push({ source: 'npm', error: e.message }) }
  out.sort((a, b) => (b.score || 0) - (a.score || 0))
  return out.slice(0, limit)
}

/* ================================================================== *
 * 2) 看仓库：判断它是什么插件
 * ================================================================== */
async function inspectRepo(fullName) {
  const repo = await httpGet(`https://api.github.com/repos/${fullName}`)
  const files = await httpGet(`https://api.github.com/repos/${fullName}/contents/`).catch(() => [])
  const names = (files || []).map((f) => f.name)
  let readme = ''
  try {
    const rd = await httpGet(`https://api.github.com/repos/${fullName}/readme`)
    if (rd && rd.content) readme = Buffer.from(rd.content, 'base64').toString('utf8').slice(0, 4000)
  } catch { /* ignore */ }

  let kind = 'unknown'
  let installHint = ''
  const has = (n) => names.includes(n)
  if (has('package.json')) {
    kind = 'koishi'
    installHint = 'Koishi 插件：可以直接用包名安装（npm 镜像）'
  } else if (has('metadata.yaml') && (has('main.py') || has('main.pyc'))) {
    kind = 'astrbot'
    installHint = 'AstrBot 插件：装到 plugins/py/astrbot/<名字>/'
  } else if (has('pyproject.toml') || has('setup.py') || names.some((n) => n.endsWith('__init__.py'))) {
    const guess = guessKind(`${repo.name} ${repo.description || ''} ${readme.slice(0, 800)}`)
    kind = guess === 'unknown' ? 'nonebot2' : guess
    installHint = `Python 插件：按 ${kind} 归类安装`
  } else if (has('manifest.yaml')) {
    kind = 'langbot'
    installHint = 'LangBot 插件：装到 plugins/py/langbot/<名字>/（完整语义需要官方 Runtime）'
  }
  if (kind === 'unknown') kind = guessKind(`${repo.name} ${repo.description || ''} ${readme.slice(0, 800)}`)

  const npmName = (() => {
    const m = readme.match(/koishi-plugin-[\w-]+/g)
    if (m && m.length) return m[0]
    if (/^koishi-plugin-/.test(repo.name)) return repo.name
    return null
  })()

  return {
    ok: true, kind, installHint, npmName,
    repo: {
      name: repo.full_name, stars: repo.stargazers_count, forks: repo.forks_count,
      lang: repo.language, license: repo.license && repo.license.spdx_id,
      updated: (repo.pushed_at || '').slice(0, 10), topics: repo.topics || [],
      desc: repo.description || '', url: repo.html_url, defaultBranch: repo.default_branch
    },
    files: names.slice(0, 40),
    readmeHead: readme.slice(0, 1200)
  }
}

/* ================================================================== *
 * 3) 安装
 * ================================================================== */
function autonomyOf(ctx) {
  return ctx.alisonAutonomy || (ctx.root && ctx.root.alisonAutonomy) || null
}

async function installPlugin(ctx, { kind, name, source, framework }) {
  const auto = autonomyOf(ctx)
  const notes = []
  const k = kind || guessKind(String(name || source))

  if (k === 'koishi') {
    const pkg = name && /^(koishi-plugin-|@)/.test(name) ? name : (name ? `koishi-plugin-${name}` : null)
    if (!pkg) return { ok: false, error: '需要 Koishi 包名' }
    if (!auto || typeof auto.install !== 'function') return { ok: false, error: 'alison-autonomy 未就绪，无法自装' }
    const r = await auto.install(pkg)
    notes.push(r.ok ? `已安装 ${r.package || pkg}${r.version ? '@' + r.version : ''} 并写入配置` : `安装失败：${r.error}`)
    return { ok: !!r.ok, kind: k, package: r.package || pkg, version: r.version, notes, needRestart: false }
  }

  if (k === 'mcp') {
    const servers = readMcpServers()
    if (!source) return { ok: false, error: '需要 MCP 服务器的启动命令或地址（例如 npx -y @modelcontextprotocol/server-filesystem D:/）' }
    const key = (name || 'mcp').replace(/[^\w-]/g, '-')
    servers[key] = source.startsWith('http') ? { type: 'streamable_http', url: source } : { type: 'studio', command: source.split(/\s+/)[0], args: source.split(/\s+/).slice(1) }
    writeMcpServers(servers)
    notes.push(`已写进 chatluna-mcp-client 的 mcpServers.${key}`)
    return { ok: true, kind: k, notes, servers }
  }

  // Python 系列：下载 zip 到 plugins/py/<框架>/
  const fw = framework || (['astrbot', 'nonebot2', 'maibot', 'langbot'].includes(k) ? k : 'nonebot2')
  if (!auto || typeof auto.pyInstall !== 'function') return { ok: false, error: 'alison-autonomy 未就绪，无法装 Python 插件' }
  if (!source || !/^https?:\/\//.test(source)) return { ok: false, error: '需要 GitHub 仓库地址' }
  const r = await auto.pyInstall(fw, source)
  notes.push(r.ok ? `已装到 plugins/py/${fw}/${r.name}/` : `安装失败：${r.error}`)
  return { ok: !!r.ok, kind: fw, framework: fw, notes, needRestart: false }
}

function mcpConfigFile() { return path.join(ROOT, 'data', 'alison-platform-web', 'mcp.json') }

function readMcpServers() {
  // 优先读 chatluna-mcp-client 的 servers 配置（JSON 文本），其次读我们自己的文件
  try {
    const doc = yaml.load(readText(CONFIG)) || {}
    const found = {}
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n)) {
        const raw = k.replace(/^~/, '')
        if (raw.split(':')[0] === 'chatluna-mcp-client' && v && typeof v === 'object') {
          try { Object.assign(found, JSON.parse(v.servers || '{}').mcpServers || {}) } catch { /* ignore */ }
        }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    if (Object.keys(found).length) return found
  } catch { /* ignore */ }
  return readJson(mcpConfigFile(), {}).mcpServers || {}
}

function writeMcpServers(servers) {
  const json = JSON.stringify({ mcpServers: servers }, null, 2)
  writeJson(mcpConfigFile(), { mcpServers: servers })
  // 同步写进 chatluna-mcp-client 的 servers 字段（文本级，保留注释）
  const text = readText(CONFIG)
  if (!text) return { ok: false, error: '找不到配置' }
  const lines = text.split('\n')
  let hit = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{2,}chatluna-mcp-client:[a-z0-9]+:/.test(lines[i])) {
      // 该条目下写 servers（块标量）
      const indent = '    '
      lines.splice(i + 1, 0, `${indent}servers: |`, ...json.split('\n').map((l) => indent + '  ' + l))
      hit = true
      break
    }
  }
  if (!hit) return { ok: false, error: '配置里没有 chatluna-mcp-client 条目（先装上它）' }
  const next = lines.join('\n')
  try { yaml.load(next) } catch (e) { return { ok: false, error: 'YAML 校验失败：' + e.message } }
  fs.writeFileSync(CONFIG, next, 'utf8')
  return { ok: true }
}

/* ================================================================== *
 * 4) 改自身结构：生成 / 修改自己的插件
 * ================================================================== */
const TEMPLATE = (id, name, desc, extra = '') => `'use strict'

/**
 * ${name} —— ${desc}
 * 由 Alison 自己生成（alison_selfedit），保存即热加载。
 */

const { defineAlisonPlugin } = require('koishi-plugin-alison-core')

module.exports = defineAlisonPlugin({
  id: '${id}',
  name: '${name}',
  version: '0.0.1',
  desc: '${desc}',

  setup(ctx, env) {
    const log = env.logger
    log.info('${name} 已加载')
${extra}
    return () => log.info('${name} 已卸载')
  }
})
`

function scaffold({ id, name, desc, body }) {
  if (!id || !/^[\w-]+$/.test(id)) return { ok: false, error: 'id 只能包含字母数字横线' }
  ensureDir(PLUGIN_DIR)
  const file = path.join(PLUGIN_DIR, `${id}.cjs`)
  if (fs.existsSync(file)) return { ok: false, error: `插件 ${id} 已存在（要改它请用 selfedit）` }
  const content = TEMPLATE(id, name || id, desc || 'Alison 自己生成的功能', body || '')
  try { new vm.Script(content) } catch (e) { return { ok: false, error: '生成的代码语法有误：' + e.message } }
  fs.writeFileSync(file, content, 'utf8')
  return { ok: true, file: file.replace(ROOT, '.'), id, hot: true, note: '已写入插件目录，alison-core 会立刻热加载' }
}

/** 改自己插件的代码：备份 → 语法校验 → 写盘（失败回滚） */
function selfEdit({ file, content, find, replace }) {
  if (!file) return { ok: false, error: '需要 file（相对 plugins/alison 的文件名）' }
  const target = path.isAbsolute(file) ? file : path.join(PLUGIN_DIR, file)
  const name = path.basename(target)
  ensureDir(PLUGIN_DIR)
  const existed = fs.existsSync(target)
  const old = existed ? readText(target) : ''
  let next = content
  if (next == null) {
    if (!existed) return { ok: false, error: '文件不存在，且没有提供 content' }
    if (find == null || replace == null) return { ok: false, error: '改已有文件需要 find + replace（或直接给 content）' }
    if (!old.includes(find)) return { ok: false, error: 'find 没匹配到内容，没做任何修改' }
    next = old.split(find).join(replace)
  }
  try { new vm.Script(next) } catch (e) { return { ok: false, error: '新代码语法有误，未写入：' + e.message } }
  // 备份
  ensureDir(path.join(DIR, 'backups'))
  if (existed) fs.writeFileSync(path.join(DIR, 'backups', `${name}.${Date.now()}.bak`), old, 'utf8')
  fs.writeFileSync(target, next, 'utf8')
  // 立刻验证能不能 require（语法过了也可能 require 失败）
  try {
    delete require.cache[target]
    require(target)
    return { ok: true, file: file, bytes: next.length, backup: existed, hot: true }
  } catch (e) {
    if (existed) fs.writeFileSync(target, old, 'utf8')
    else fs.unlinkSync(target)
    return { ok: false, error: '新代码加载失败，已回滚：' + e.message }
  }
}

function listOwnPlugins() {
  ensureDir(PLUGIN_DIR)
  return fs.readdirSync(PLUGIN_DIR).filter((f) => !f.startsWith('_')).map((f) => ({
    file: f, bytes: fs.statSync(path.join(PLUGIN_DIR, f)).size
  }))
}

/* ================================================================== *
 * ChatLuna 工具
 * ================================================================== */
let StructuredTool = null
try { StructuredTool = require('@langchain/core/tools').StructuredTool } catch { /* 无 */ }

function makeTools(ctx, config) {
  if (!StructuredTool) return []
  const { z } = require('zod')

  class SearchTool extends StructuredTool {
    name = 'alison_search'
    description = '去 GitHub / npm 搜插件或项目。返回候选（类型、星数、更新时间、简介）。用于"我需要一个能 XX 的插件"这类需求。'
    schema = z.object({
      query: z.string().describe('搜索关键词，例如 "画图"、"定时提醒"、"astrbot 天气"'),
      kind: z.enum(['koishi', 'nonebot2', 'astrbot', 'maibot', 'langbot', 'mcp']).optional().describe('只找某一类'),
      limit: z.number().optional().describe('返回条数，默认 8')
    })
    async _call(i) { return JSON.stringify(await search(i.query, { kind: i.kind, limit: i.limit || 8 }), null, 1).slice(0, 8000) }
  }

  class RepoTool extends StructuredTool {
    name = 'alison_repo'
    description = '看一个 GitHub 仓库：它是哪一类插件、怎么装、有没有 README 说明。装之前先看它。'
    schema = z.object({ name: z.string().describe('仓库全名，如 owner/repo') })
    async _call(i) { return JSON.stringify(await inspectRepo(i.name), null, 1).slice(0, 8000) }
  }

  class InstallTool extends StructuredTool {
    name = 'alison_install_plugin'
    description = '把找到的插件装上：Koishi 插件走镜像直装；Python 插件按框架装；MCP 服务器写进配置。**装之前要先问过主人**（返回 needOwnerApproval 提示）。'
    schema = z.object({
      kind: z.string().describe('koishi / astrbot / nonebot2 / maibot / langbot / mcp'),
      name: z.string().optional().describe('Koishi 包名，或 MCP 名字'),
      source: z.string().optional().describe('GitHub 地址 / zip 地址，或 MCP 的启动命令'),
      framework: z.string().optional().describe('Python 插件框架（覆盖 kind）')
    })
    async _call(i) {
      if (!config.autoInstall) return JSON.stringify({ ok: false, needOwnerApproval: true, hint: '主人没开自动安装，先把方案说给主人听，等他同意再装（或让他在控制中心点一下）' })
      const r = await installPlugin(ctx, i)
      const auto = autonomyOf(ctx)
      if (r.ok && auto && typeof auto.diagnose === 'function') {
        try { r.health = auto.diagnose().ok ? '体检通过' : '体检有红项（可让 Alison 自己修）' } catch { /* ignore */ }
      }
      return JSON.stringify(r, null, 1).slice(0, 6000)
    }
  }

  class SelfEditTool extends StructuredTool {
    name = 'alison_selfedit'
    description = '调整 Alison 自己的结构：scaffold 生成一个新插件（她给自己加功能）；selfedit 改自己插件的代码；list 看她现在的插件。改代码会备份 + 语法校验 + 失败回滚。'
    schema = z.object({
      action: z.enum(['scaffold', 'selfedit', 'list']),
      id: z.string().optional().describe('scaffold：插件 id（字母数字横线）'),
      name: z.string().optional().describe('scaffold：显示名'),
      desc: z.string().optional().describe('scaffold：说明'),
      body: z.string().optional().describe('scaffold：setup 里的初始代码'),
      file: z.string().optional().describe('selfedit：plugins/alison 下的文件名'),
      content: z.string().optional().describe('selfedit：整份新内容'),
      find: z.string().optional().describe('selfedit：要替换的片段'),
      replace: z.string().optional().describe('selfedit：替换成什么')
    })
    async _call(i) {
      if (i.action === 'list') return JSON.stringify({ plugins: listOwnPlugins(), dir: PLUGIN_DIR.replace(ROOT, '.') }, null, 1)
      if (i.action === 'scaffold') return JSON.stringify(scaffold(i), null, 1)
      return JSON.stringify(selfEdit(i), null, 1)
    }
  }

  return [new SearchTool(), new RepoTool(), new InstallTool(), new SelfEditTool()]
}

/* ================================================================== *
 * 插件入口
 * ================================================================== */
const name = 'alison-github'
const inject = { optional: ['chatluna', 'server'] }

const Config = Schema.object({
  autoInstall: Schema.boolean().default(false).description('允许 Alison 未经确认直接装插件（默认关：她得先问你）'),
  ownerOnly: Schema.boolean().default(true).description('这些工具只对管理员可见'),
  maxStars: Schema.number().default(0).description('只推荐星数 >= 该值的项目（0 = 不限）')
})

function apply(ctx, config) {
  logger = ctx.logger('alison-github')
  ensureDir(DIR); ensureDir(PLUGIN_DIR)
  if (!fs.existsSync(path.join(DIR, 'token.txt'))) {
    fs.writeFileSync(path.join(DIR, 'token.txt.example'),
      '# 把 GitHub token 粘到这里（改名成 token.txt），能提高搜索限流额度；不填也能用\n', 'utf8')
  }

  const core = ctx.alison || (ctx.root && ctx.root.alison)
  if (core && core.registerPlugin) core.registerPlugin({ name, version: '0.0.1', kind: 'github' })

  ctx.inject(['chatluna'], (chatCtx) => {
    const platform = chatCtx.chatluna && chatCtx.chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') { logger.warn('registerTool 不可用，GitHub 工具未注册'); return }
    const isOwner = (session) => {
      if (!config.ownerOnly) return true
      try {
        const selfop = require(path.join(APP_DIR, 'node_modules', 'koishi-plugin-alison-hotreload', 'lib', 'index.js'))
        const owners = (selfop && selfop.__owners) || []
        if (owners.length) return owners.includes(String(session && session.userId))
      } catch { /* ignore */ }
      return true   // 拿不到 owner 配置时不额外拦截（QQ 侧 authority 会再拦一层）
    }
    for (const t of makeTools(ctx, config)) {
      chatCtx.effect(() => platform.registerTool(t.name, {
        name: t.name, description: t.description,
        authorization: (session) => isOwner(session),
        selector: () => true,
        createTool: () => t,
        meta: { source: name, group: 'Alison 自我进化' }
      }))
    }
    logger.info('已注册工具：alison_search, alison_repo, alison_install_plugin, alison_selfedit')
  })

  ctx.inject(['server'], (serverCtx) => {
    const base = '/alison/api/github'
    const guard = (koa) => {
      const ip = koa.request?.ip || koa.ip || ''
      if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return true
      koa.status = 403; koa.body = { error: '仅允许本机' }; return false
    }
    const wrap = (fn) => async (koa) => {
      if (!guard(koa)) return
      try { koa.body = await fn(koa) } catch (e) { koa.status = 500; koa.body = { ok: false, error: e.message } }
    }
    serverCtx.server.get(base + '/search', wrap(async (koa) => ({ ok: true, items: await search(String(koa.query.q || ''), { kind: koa.query.kind ? String(koa.query.kind) : null, limit: Number(koa.query.limit) || 8 }) })))
    serverCtx.server.get(base + '/repo', wrap(async (koa) => inspectRepo(String(koa.query.name || ''))))
    serverCtx.server.post(base + '/install', wrap(async (koa) => installPlugin(ctx, koa.request.body || {})))
    serverCtx.server.post(base + '/scaffold', wrap(async (koa) => scaffold(koa.request.body || {})))
    serverCtx.server.post(base + '/selfedit', wrap(async (koa) => selfEdit(koa.request.body || {})))
    serverCtx.server.get(base + '/plugins', wrap(async () => ({ ok: true, plugins: listOwnPlugins(), dir: PLUGIN_DIR.replace(ROOT, '.'), token: ghToken() ? '已配置' : '未配置（限流更严）' })))
    logger.info(`GitHub 接口：${base}/*`)
  })

  ctx.command('alison.find <keyword:text>', '去开源平台找插件').action(async ({ session }, keyword) => {
    if (!keyword) return '用法：alison.find 画图'
    const items = await search(keyword, { limit: 5 })
    return items.map((i) => `· [${i.kind}] ${i.name} ★${i.stars || 0}（${i.updated || '-'}）${i.desc || ''}`.slice(0, 160)).join('\n')
  })

  ctx.command('alison.self <action:text> [arg:text]', 'Alison 调整自己的结构（scaffold/list/selfedit）').action(async ({ session }, action, arg) => {
    if (action === 'list') return listOwnPlugins().map((p) => p.file).join('\n') || '（还没有自己的插件）'
    if (action === 'scaffold') {
      const r = scaffold({ id: arg, name: arg, desc: '由 Alison 生成' })
      return r.ok ? `已生成 ${r.file}（会自动热加载）` : '失败：' + r.error
    }
    return '用法：alison.self scaffold 插件名 / alison.self list'
  })

  logger.info('Alison 的开源检索与自我改造能力已就绪')
}

module.exports = { name, inject, Config, apply }
module.exports.default = module.exports
module.exports.__internals = { search, inspectRepo, installPlugin, scaffold, selfEdit, listOwnPlugins, readMcpServers, writeMcpServers }
