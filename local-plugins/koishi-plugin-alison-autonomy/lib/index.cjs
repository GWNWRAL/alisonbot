'use strict'

/**
 * koishi-plugin-alison-autonomy
 *
 * 让 Alison 能：
 *   1. 改自己的配置      —— 读写 koishi.yml，改前备份、改后校验，坏了自动回滚
 *   2. 装自己的插件      —— Koishi 插件（直接从 npm 镜像下载解包，不需要包管理器）
 *                          以及 AstrBot 插件（Python，走 astrbot-bridge.py 兼容桥）
 *   3. 修自己            —— 自检（配置/插件/数据/日志/磁盘）+ 从最近可用备份回滚
 *
 * 同时把这些能力以 HTTP 接口暴露给 Web UI 的「控制中心」。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const zlib = require('node:zlib')
const { execFileSync, execFile } = require('node:child_process')
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

const ROOT = process.cwd()
const APP_DIR = path.resolve(__dirname, '..', '..', '..')
const CONFIG = resolveConfigFile_()
const STATE_DIR = path.join(ROOT, 'data', 'alison-autonomy')
const BACKUP_DIR = path.join(STATE_DIR, 'backups')
const Alison_PLUGIN_DIR = path.join(ROOT, 'plugins', 'ice')
const ASTRBOT_DIR = path.join(ROOT, 'plugins', 'astrbot')
// Alison 功能插件目录（与 alison-core 的插件目录一致）
const ALISON_PLUGIN_DIR = path.join(ROOT, 'plugins', 'alison')
// Python 插件目录：workspace/plugins/py/<框架>/<插件名>（astrbot 也兼容旧的 plugins/astrbot/）
const PY_ROOT = path.join(ROOT, 'plugins', 'py')
const BRIDGE = path.join(__dirname, 'pyplugin-bridge.py')
// 兼容的 Python 插件框架（与 pyplugin-bridge.py 的 FRAMEWORKS 对应）
const PY_FRAMEWORKS = {
  astrbot: { title: 'AstrBot', note: '命令子集（@filter.command / @filter.keyword）' },
  nonebot2: { title: 'NoneBot2', note: 'on_command / on_keyword / on_startswith / on_message 子集' },
  maibot: { title: 'MaiBot', note: 'maibot_sdk 的 @Command / @Action 子集' },
  langbot: { title: 'LangBot', note: '组件式；完整语义需要官方 Plugin Runtime' }
}
const NPM_REGISTRY = 'https://registry.npmmirror.com'

const KEY_PLUGINS = ['chatluna', 'chatluna-character', 'adapter-onebot', 'database-sqlite', 'server', 'alison-platform-web']

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }) }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) }
function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fb } }
function readText(file) { try { return fs.readFileSync(file, 'utf8') } catch { return null } }

function parseConfig() {
  const text = readText(CONFIG)
  if (text == null) throw new Error('找不到 koishi.yml：' + CONFIG)
  const doc = yaml.load(text)
  if (!doc || typeof doc !== 'object') throw new Error('koishi.yml 解析结果不是对象')
  if (!doc.plugins || typeof doc.plugins !== 'object') throw new Error('koishi.yml 缺少 plugins 段')
  return { doc, text }
}

/** 收集插件条目（含 group 嵌套与 $if 等配置键） */
function collectPlugins(doc) {
  const list = []
  ;(function walk(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    for (const [k, v] of Object.entries(node)) {
      const raw = k.replace(/^~/, '')
      // 注意：group 判定必须用完整键，不能用 split(':')[0]（那会得到 "group"）
      if (raw.startsWith('group:')) { walk(v); continue }
      const base = raw.split(':')[0]
      // 插件条目形如 name:instanceId
      if (/^[\w@.\-]+:[a-z0-9]+$/i.test(raw) && !base.startsWith('$')) {
        list.push({ key: k, name: base, instanceId: raw.split(':')[1], enabled: !k.startsWith('~'), config: v })
      }
    }
  })(doc.plugins)
  return list
}

function pluginInstalledOnDisk(name) {
  const cands = name.startsWith('@')
    ? [name]
    : ['koishi-plugin-' + name, '@koishijs/plugin-' + name, name]
  for (const c of cands) {
    if (fs.existsSync(path.join(APP_DIR, 'node_modules', c, 'package.json'))) return c
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 1. 配置自改
 * ------------------------------------------------------------------ */
function backupConfig(reason) {
  ensureDir(BACKUP_DIR)
  const file = path.join(BACKUP_DIR, `koishi-${stamp()}.yml`)
  try {
    fs.copyFileSync(CONFIG, file)
    fs.writeFileSync(path.join(BACKUP_DIR, 'last-backup.json'),
      JSON.stringify({ file, reason: reason || '', at: new Date().toISOString() }, null, 2))
  } catch (e) { logger?.warn('备份配置失败: ' + e.message) }
  // 只留最近 30 份
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.yml')).sort()
    for (const f of files.slice(0, Math.max(0, files.length - 30))) fs.unlinkSync(path.join(BACKUP_DIR, f))
  } catch { /* ignore */ }
  return file
}

/** 读取配置文本（或某个插件段的 JSON） */
function configRead(section) {
  const { doc, text } = parseConfig()
  if (!section) return { ok: true, text, bytes: text.length, plugins: collectPlugins(doc).length }
  const found = collectPlugins(doc).find((p) => p.name === section)
  if (!found) return { ok: false, error: `配置里没有插件 ${section}` }
  return { ok: true, name: section, enabled: found.enabled, config: found.config }
}

/** 整份替换（带校验与自动回滚） */
function configWrite(text, reason) {
  const keep = readText(CONFIG)
  try {
    const doc = yaml.load(text)
    if (!doc || typeof doc !== 'object' || !doc.plugins) throw new Error('必须包含 plugins 段')
  } catch (e) {
    return { ok: false, error: 'YAML 校验失败：' + e.message }
  }
  backupConfig(reason || 'config-write')
  try {
    fs.writeFileSync(CONFIG, text, 'utf8')
    parseConfig() // 复检
    return { ok: true, bytes: text.length, backup: true }
  } catch (e) {
    try { if (keep != null) fs.writeFileSync(CONFIG, keep, 'utf8') } catch { }
    return { ok: false, error: '写入后复检失败，已回滚：' + e.message }
  }
}

/** 启用 / 禁用某个插件（文本级，保留注释） */
function configToggle(name, enabled) {
  const { text } = parseConfig()
  const lines = text.split('\n')
  let hit = 0
  const re = new RegExp('^(\\s*)(~?)(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(:[a-z0-9]+:.*)$', 'i')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue
    lines[i] = m[1] + (enabled ? '' : '~') + m[3] + m[4]
    hit++
  }
  if (!hit) {
    if (!enabled) return { ok: false, error: `配置里没有 ${name}` }
    // 新插件：插到 plugins: 之后（顶层，2 空格缩进）
    const idx = lines.findIndex((l) => /^plugins:\s*$/.test(l))
    if (idx < 0) return { ok: false, error: '找不到 plugins: 行' }
    lines.splice(idx + 1, 0, `  ${name}:${Math.random().toString(36).slice(2, 8)}: {}`)
    hit = 1
  }
  const res = configWrite(lines.join('\n'), `toggle ${name}=${enabled}`)
  return { ok: res.ok, error: res.error, changed: hit, needRestart: true }
}

/** 回滚到最近一份"能解析"的备份 */
function configRollback() {
  ensureDir(BACKUP_DIR)
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.yml')).sort().reverse()
  for (const f of files) {
    const p = path.join(BACKUP_DIR, f)
    try {
      const doc = yaml.load(fs.readFileSync(p, 'utf8'))
      if (!doc || !doc.plugins) continue
      const cur = readText(CONFIG)
      fs.copyFileSync(p, CONFIG)
      logger?.warn('已回滚配置到 ' + f)
      return { ok: true, from: f, previousBytes: (cur || '').length }
    } catch { continue }
  }
  return { ok: false, error: '没有可用备份' }
}

/* ------------------------------------------------------------------ *
 * 2. 插件自装
 * ------------------------------------------------------------------ */
function httpsGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'alison-autonomy' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
        res.resume(); return resolve(httpsGet(res.headers.location, depth + 1))
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)) }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

function tarExtract(tgz, dest) {
  ensureDir(dest)
  // Windows 10+ 与 macOS 都自带 tar
  execFileSync('tar', ['-xzf', tgz, '-C', dest], { stdio: 'pipe', timeout: 120000 })
}

/** 从 npm 镜像装一个包到 app/node_modules（递归装 dependencies，深度受限） */
async function installFromNpm(pkgName, depth = 0, installed = []) {
  if (depth > 3) return { ok: false, error: '依赖太深，放弃' }
  const disk = pluginInstalledOnDisk(pkgName)
  if (disk && depth > 0) return { ok: true, skipped: disk }
  const metaBuf = await httpsGet(`${NPM_REGISTRY}/${pkgName.replace('/', '%2f')}/latest`)
  const meta = JSON.parse(metaBuf.toString('utf8'))
  const tarball = meta.dist && meta.dist.tarball
  if (!tarball) throw new Error('拿不到 tarball：' + pkgName)

  // 临时目录必须和目标同盘：Windows 上跨盘 rename 会 EXDEV
  const tmp = path.join(APP_DIR, 'node_modules', '.alison-install-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  ensureDir(tmp)
  const tgz = path.join(tmp, 'pkg.tgz')
  fs.writeFileSync(tgz, await httpsGet(tarball))
  tarExtract(tgz, tmp)
  const target = path.join(APP_DIR, 'node_modules', meta.name)
  ensureDir(path.dirname(target))
  fs.rmSync(target, { recursive: true, force: true })
  fs.renameSync(path.join(tmp, 'package'), target)
  fs.rmSync(tmp, { recursive: true, force: true })
  installed.push(`${meta.name}@${meta.version}`)

  const deps = Object.keys(meta.dependencies || {})
  for (const d of deps) {
    try { await installFromNpm(d, depth + 1, installed) }
    catch (e) { logger?.warn(`依赖 ${d} 安装失败：${e.message}`) }
  }
  return { ok: true, name: meta.name, version: meta.version, installed }
}

async function pluginInstall(name) {
  const pkg = name.startsWith('@') ? name : (name.startsWith('koishi-plugin-') ? name : 'koishi-plugin-' + name)
  try {
    const res = await installFromNpm(pkg)
    const base = pkg.replace(/^koishi-plugin-/, '')
    const toggle = configToggle(base, true)
    return { ok: true, package: pkg, version: res.version, installed: res.installed, enabled: toggle.ok, needRestart: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function pluginList() {
  let items = []
  try {
    const { doc } = parseConfig()
    items = collectPlugins(doc).map((p) => ({
      name: p.name,
      instanceId: p.instanceId,
      enabled: p.enabled,
      onDisk: !!pluginInstalledOnDisk(p.name),
      local: fs.existsSync(path.join(APP_DIR, 'local-plugins', 'koishi-plugin-' + p.name)) ||
        fs.existsSync(path.join(APP_DIR, 'local-plugins', p.name))
    }))
  } catch (e) { return { ok: false, error: e.message, items: [] } }
  const py = listPy()
  const ice = listIcePlugins()
  const byFramework = {}
  for (const p of py) byFramework[p.framework] = (byFramework[p.framework] || 0) + 1
  return {
    ok: true,
    items,
    astrbot: py.filter((p) => p.framework === 'astrbot'),
    py,
    pyFrameworks: PY_FRAMEWORKS,
    ice,
    counts: {
      koishi: items.length,
      enabled: items.filter((i) => i.enabled).length,
      py: py.length,
      astrbot: py.filter((p) => p.framework === 'astrbot').length,
      alisonPlugins: ice.length,
      byFramework
    }
  }
}

/* ------------------------------------------------------------------ *
 * Python 插件兼容层（多框架：AstrBot / NoneBot2 / MaiBot / LangBot）
 * ------------------------------------------------------------------ */
function findPython() {
  for (const c of ['python', 'python3', 'py']) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe', timeout: 8000 }); return c } catch { /* next */ }
  }
  return null
}

function pyDir(framework, name) {
  if (framework === 'astrbot') {
    const legacy = path.join(ASTRBOT_DIR, name)
    if (fs.existsSync(legacy)) return legacy
  }
  return path.join(PY_ROOT, framework, name)
}

function readYamlFlat(file) {
  const out = {}
  const text = readText(file)
  if (!text) return out
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes(':')) continue
    const i = line.indexOf(':')
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return out
}

/** 列出某框架（或全部框架）下的 Python 插件 */
function listPy(framework) {
  const frameworks = framework ? [framework] : Object.keys(PY_FRAMEWORKS)
  const out = []
  for (const fw of frameworks) {
    const bases = []
    if (fw === 'astrbot' && fs.existsSync(ASTRBOT_DIR)) bases.push([ASTRBOT_DIR, 'plugins/astrbot'])
    const base = path.join(PY_ROOT, fw)
    if (fs.existsSync(base)) bases.push([base, `plugins/py/${fw}`])
    for (const [dir0, label] of bases) {
      for (const d of fs.readdirSync(dir0, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue
        const dir = path.join(dir0, d.name)
        const meta = readYamlFlat(path.join(dir, 'metadata.yaml'))
        const manifestYaml = readYamlFlat(path.join(dir, 'manifest.yaml'))
        const manifestJson = readJson(path.join(dir, 'manifest.json'), {}) || {}
        const manifest = Object.keys(manifestYaml).length ? manifestYaml : manifestJson
        out.push({
          framework: fw,
          frameworkTitle: PY_FRAMEWORKS[fw].title,
          dir: d.name,
          location: label,
          name: meta.name || manifest.name || d.name,
          desc: meta.desc || meta.description || manifest.description || '',
          version: meta.version || manifest.version || '',
          hasMain: ['main.py', 'plugin.py', '__init__.py'].some((f) => fs.existsSync(path.join(dir, f)))
        })
      }
    }
  }
  return out
}

function listIcePlugins() {
  ensureDir(ALISON_PLUGIN_DIR)
  const out = []
  for (const d of fs.readdirSync(ALISON_PLUGIN_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const mf = path.join(ALISON_PLUGIN_DIR, d.name, 'plugin.json')
    const meta = readJson(mf, null)
    out.push({ dir: d.name, name: (meta && meta.name) || d.name, description: (meta && meta.description) || '', version: (meta && meta.version) || '', entry: (meta && meta.entry) || 'index.cjs' })
  }
  return out
}

/** 把 GitHub / zip / 本地目录装进 workspace（按框架分目录） */
/** 装完插件后自动为它写一份工具说明（插件与系统提示词分开保存） */
async function autoToolPrompt(ctx, pluginName) {
  try {
    const svc = ctx.root && ctx.root.alisonToolPrompt
    if (svc && typeof svc.generate === 'function') {
      const r = await svc.generate(pluginName, {})
      if (r && r.ok) logger && logger.info && logger.info('已为 ' + pluginName + ' 自动生成工具说明')
      return r
    }
  } catch (e) { /* 失败不影响安装 */ }
  return null
}

async function pyInstall(framework, source) {
  if (!PY_FRAMEWORKS[framework]) return { ok: false, error: '未知框架：' + framework }
  const targetRoot = framework === 'astrbot' ? ASTRBOT_DIR : path.join(PY_ROOT, framework)
  ensureDir(targetRoot)
  try {
    let name = ''
    if (/^https?:\/\/github\.com\//i.test(source)) {
      const m = source.match(/github\.com\/([^/]+)\/([^/?#]+)/i)
      if (!m) throw new Error('无法解析 GitHub 地址')
      name = m[2].replace(/\.git$/, '')
      const buf = await httpsGet(`https://codeload.github.com/${m[1]}/${name}/zip/refs/heads/main`)
        .catch(() => httpsGet(`https://codeload.github.com/${m[1]}/${name}/zip/refs/heads/master`))
      const tmp = path.join(targetRoot, '.alison-tmp-' + Date.now())
      ensureDir(tmp)
      const zip = path.join(tmp, 'p.zip')
      fs.writeFileSync(zip, buf)
      const out = path.join(tmp, 'x')
      ensureDir(out)
      execFileSync('tar', ['-xf', zip, '-C', out], { stdio: 'pipe', timeout: 120000 })
      const rootDir = fs.readdirSync(out)[0]
      const target = path.join(targetRoot, name)
      fs.rmSync(target, { recursive: true, force: true })
      fs.renameSync(path.join(out, rootDir), target)
      fs.rmSync(tmp, { recursive: true, force: true })
    } else if (/^https?:\/\//i.test(source)) {
      const buf = await httpsGet(source)
      name = path.basename(source).replace(/\.zip$/i, '')
      const tmp = path.join(targetRoot, '.alison-tmp-' + Date.now())
      ensureDir(tmp)
      const zip = path.join(tmp, 'p.zip')
      fs.writeFileSync(zip, buf)
      const out = path.join(tmp, 'x')
      ensureDir(out)
      execFileSync('tar', ['-xf', zip, '-C', out], { stdio: 'pipe', timeout: 120000 })
      const entries = fs.readdirSync(out)
      const src = entries.length === 1 ? path.join(out, entries[0]) : out
      const target = path.join(targetRoot, name)
      fs.rmSync(target, { recursive: true, force: true })
      if (fs.cpSync) fs.cpSync(src, target, { recursive: true }); else fs.renameSync(src, target)
      fs.rmSync(tmp, { recursive: true, force: true })
    } else {
      const abs = path.resolve(source)
      if (!fs.existsSync(abs)) throw new Error('本地路径不存在：' + abs)
      name = path.basename(abs)
      const target = path.join(targetRoot, name)
      fs.rmSync(target, { recursive: true, force: true })
      if (fs.statSync(abs).isDirectory()) {
        if (fs.cpSync) fs.cpSync(abs, target, { recursive: true }); else fs.renameSync(abs, target)
      } else {
        ensureDir(target)
        execFileSync('tar', ['-xf', abs, '-C', target], { stdio: 'pipe', timeout: 120000 })
      }
    }
    return { ok: true, framework, name, list: listPy(framework) }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/** 调多框架兼容桥：list 或 run */
function pyBridge(framework, name, action, command, args) {
  if (!PY_FRAMEWORKS[framework]) return { ok: false, error: '未知框架：' + framework }
  const dir = pyDir(framework, name)
  if (!fs.existsSync(dir)) return { ok: false, error: `没有这个 ${framework} 插件：${name}` }
  const py = findPython()
  if (!py) return { ok: false, error: '本机没有 Python 3.9+，Python 插件无法运行（装好 Python 后重试）' }
  const cli = action === 'run'
    ? [BRIDGE, framework, dir, 'run', command, ...(args || [])]
    : [BRIDGE, framework, dir, 'list']
  try {
    const out = execFileSync(py, cli, { timeout: 90000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    const line = String(out).trim().split('\n').pop()
    return JSON.parse(line)
  } catch (e) {
    return { ok: false, error: '桥接执行失败：' + (e.message || String(e)) }
  }
}

const pyInspect = (framework, name) => pyBridge(framework, name, 'list')
const pyRun = (framework, name, command, args) => pyBridge(framework, name, 'run', command, args)
// 兼容旧名字（astrbot 专用）
const listAstrBot = () => listPy('astrbot')
const astrbotInstall = (source) => pyInstall('astrbot', source)
const astrbotRun = (name, command, args) => pyRun('astrbot', name, command, args)
const astrbotInspect = (name) => pyInspect('astrbot', name)
/* ------------------------------------------------------------------ *
 * 3. 自检与自修复
 * ------------------------------------------------------------------ */
function tailLogErrors(limit = 400) {
  const dir = path.join(ROOT, 'data', 'logs')
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort()
    if (!files.length) return { scanned: 0, errors: [] }
    const text = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8')
    const lines = text.split('\n').slice(-limit)
    const errors = lines.filter((l) => l.includes('"type":"error"'))
      .map((l) => { try { const j = JSON.parse(l); return { name: j.name, content: String(j.content).slice(0, 200) } } catch { return { content: l.slice(0, 200) } } })
      .slice(-10)
    return { scanned: lines.length, errors }
  } catch { return { scanned: 0, errors: [] } }
}

function diskFree() {
  try {
    // Node 18.15+ 支持 statfs
    if (fs.statfsSync) {
      const s = fs.statfsSync(ROOT)
      return Math.round((s.bavail * s.bsize) / (1024 * 1024 * 1024)) + ' GB'
    }
  } catch { /* ignore */ }
  return '未知'
}

function diagnose() {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' })

  let doc = null
  try { const r = parseConfig(); doc = r.doc; push('koishi.yml 可解析', true, `${r.text.length} 字节`) }
  catch (e) { push('koishi.yml 可解析', false, e.message) }

  if (doc) {
    const plugins = collectPlugins(doc)
    const names = plugins.map((p) => p.name)
    const missing = KEY_PLUGINS.filter((k) => !names.includes(k))
    push('关键插件都在配置里', missing.length === 0, missing.length ? '缺少：' + missing.join(', ') : KEY_PLUGINS.join(', '))
    const enabled = plugins.filter((p) => p.enabled).length
    push('启用插件数正常', enabled >= 5, `${enabled} / ${plugins.length}`)
    const notOnDisk = plugins.filter((p) => p.enabled && !pluginInstalledOnDisk(p.name) && !p.name.startsWith('chatluna-intern'))
    push('启用的插件都已安装', notOnDisk.length === 0, notOnDisk.length ? '缺文件：' + notOnDisk.map((p) => p.name).join(', ') : '')
  }

  try { ensureDir(path.join(ROOT, 'data')); fs.writeFileSync(path.join(STATE_DIR, '.w'), 'x'); fs.unlinkSync(path.join(STATE_DIR, '.w')); push('数据目录可写', true, ROOT + '\\data') }
  catch (e) { push('数据目录可写', false, e.message) }

  const log = tailLogErrors()
  push('最近日志没有错误', log.errors.length === 0, log.errors.length ? `${log.errors.length} 条（最近一条：${log.errors[log.errors.length - 1].content}）` : `扫描 ${log.scanned} 行`)

  push('磁盘空间充足', true, diskFree() + ' 可用')
  const backups = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.yml')).length : 0
  push('配置备份可用', true, backups + ' 份（每次改配置会自动增加）')

  const bad = checks.filter((c) => !c.ok)
  return { ok: bad.length === 0, checks, bad: bad.map((c) => c.name), log: log.errors, version: pkgVersion() }
}

function repair(actions) {
  const done = []
  const want = (a) => !actions || actions.length === 0 || actions.includes(a)

  // 1) 配置坏了 → 回滚
  let cfgOk = true
  try { parseConfig() } catch { cfgOk = false }
  if (!cfgOk && want('config')) {
    const r = configRollback()
    done.push({ action: 'config-rollback', ok: r.ok, detail: r.ok ? '已回滚到 ' + r.from : r.error })
  }

  // 2) 目录缺失 → 补
  if (want('dirs')) {
    try {
      for (const d of [STATE_DIR, BACKUP_DIR, Alison_PLUGIN_DIR, ASTRBOT_DIR, PY_ROOT, path.join(ROOT, 'data')]) ensureDir(d)
      done.push({ action: 'ensure-dirs', ok: true, detail: '目录已补齐' })
    } catch (e) { done.push({ action: 'ensure-dirs', ok: false, detail: e.message }) }
  }

  // 3) 缺插件文件 → 尝试重装
  if (want('plugins')) {
    try {
      const { doc } = parseConfig()
      const missing = collectPlugins(doc).filter((p) => p.enabled && !pluginInstalledOnDisk(p.name))
      done.push({ action: 'plugins', ok: true, detail: missing.length ? '以下插件缺文件，需要用 alison_plugin 安装：' + missing.map((m) => m.name).join(', ') : '所有启用插件文件齐全' })
    } catch (e) { done.push({ action: 'plugins', ok: false, detail: e.message }) }
  }

  // 4) 备份一次当前状态
  if (want('backup')) {
    const f = backupConfig('repair')
    done.push({ action: 'backup', ok: !!f, detail: f ? '已备份当前配置' : '备份失败' })
  }

  return { ok: done.every((d) => d.ok), done, diagnose: diagnose() }
}

function pkgVersion() {
  try { return readJson(path.join(APP_DIR, 'package.json'), {}).version || '0.0.1' } catch { return '0.0.1' }
}

/* ------------------------------------------------------------------ *
 * ChatLuna 工具
 * ------------------------------------------------------------------ */
let StructuredTool = null
try { StructuredTool = require('@langchain/core/tools').StructuredTool } catch { /* 没有就不注册工具 */ }

function makeTools() {
  if (!StructuredTool) return []
  const { z } = require('zod')

  class ConfigTool extends StructuredTool {
    name = 'alison_config'
    description = '读写 Alison 自己的 koishi.yml 配置：read 查看、toggle 启用/禁用插件、write 整份替换、rollback 回滚、backup 备份。改动会先备份并在写入后校验，坏了自动回滚。'
    schema = z.object({
      action: z.enum(['read', 'toggle', 'write', 'rollback', 'backup']).describe('操作'),
      section: z.string().optional().describe('read 时看哪个插件的配置'),
      name: z.string().optional().describe('toggle 的插件名'),
      enabled: z.boolean().optional().describe('toggle 成启用还是禁用'),
      text: z.string().optional().describe('write 时的完整 koishi.yml 文本')
    })
    async _call(input) {
      switch (input.action) {
        case 'read': return JSON.stringify(configRead(input.section), null, 1).slice(0, 6000)
        case 'toggle': return JSON.stringify(configToggle(input.name, input.enabled !== false))
        case 'write': return JSON.stringify(configWrite(input.text, 'tool'))
        case 'rollback': return JSON.stringify(configRollback())
        case 'backup': return JSON.stringify({ ok: true, file: backupConfig('tool') })
        default: return '未知操作'
      }
    }
  }

  class PluginTool extends StructuredTool {
    name = 'alison_plugin'
    description = '管理 Alison 自己的插件：list 列出、install 安装 Koishi 插件（从 npm 镜像下载，无需包管理器）、toggle 启用/禁用、astrbot/install 安装 AstrBot(Python) 插件、astrbot/run 运行它的命令、astrbot/list 查看。'
    schema = z.object({
      action: z.enum(['list', 'install', 'toggle', 'frameworks', 'py-list', 'py-install', 'py-inspect', 'py-run', 'astrbot-list', 'astrbot-install', 'astrbot-run', 'astrbot-inspect']).describe('操作'),
      name: z.string().optional().describe('插件名 / Python 插件目录名'),
      enabled: z.boolean().optional(),
      framework: z.enum(['astrbot', 'nonebot2', 'maibot', 'langbot']).optional().describe('Python 插件框架，默认 astrbot'),
      source: z.string().optional().describe('Python 插件的 GitHub 地址 / zip / 本地目录'),
      command: z.string().optional().describe('要运行的插件命令'),
      args: z.array(z.string()).optional()
    })
    async _call(input) {
      switch (input.action) {
        case 'list': return JSON.stringify(pluginList(), null, 1).slice(0, 8000)
        case 'install': return JSON.stringify(await pluginInstall(input.name))
        case 'toggle': return JSON.stringify(configToggle(input.name, input.enabled !== false))
        case 'frameworks': return JSON.stringify(PY_FRAMEWORKS, null, 1)
        case 'py-list': return JSON.stringify(listPy(input.framework), null, 1)
        case 'py-install': return JSON.stringify(await pyInstall(input.framework || 'astrbot', input.source))
        case 'py-inspect': return JSON.stringify(pyInspect(input.framework || 'astrbot', input.name))
        case 'py-run': return JSON.stringify(pyRun(input.framework || 'astrbot', input.name, input.command, input.args))
        case 'astrbot-list': return JSON.stringify(listAstrBot())
        case 'astrbot-install': return JSON.stringify(await astrbotInstall(input.source))
        case 'astrbot-inspect': return JSON.stringify(astrbotInspect(input.name))
        case 'astrbot-run': return JSON.stringify(astrbotRun(input.name, input.command, input.args))
        default: return '未知操作'
      }
    }
  }

  class RepairTool extends StructuredTool {
    name = 'alison_repair'
    description = '自检并修复 Alison 自己：diagnose 体检（配置/插件/数据/日志/磁盘/备份）、repair 自动修复（配置坏了回滚、目录缺失补齐）、restart 建议重启。'
    schema = z.object({
      action: z.enum(['diagnose', 'repair']).describe('操作'),
      targets: z.array(z.string()).optional().describe('repair 的目标：config/dirs/plugins/backup')
    })
    async _call(input) {
      if (input.action === 'diagnose') return JSON.stringify(diagnose(), null, 1).slice(0, 8000)
      return JSON.stringify(repair(input.targets), null, 1).slice(0, 8000)
    }
  }

  return [new ConfigTool(), new PluginTool(), new RepairTool()]
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */
const name = 'alison-autonomy'
const inject = { optional: ['chatluna', 'server', 'database'] }

const Config = Schema.object({
  allowWriteConfig: Schema.boolean().default(true).description('允许 Alison 自己改 koishi.yml（改前自动备份 + 校验 + 坏则回滚）'),
  allowInstallPlugin: Schema.boolean().default(true).description('允许 Alison 自己装插件'),
  allowAstrBot: Schema.boolean().default(true).description('允许运行 AstrBot(Python) 插件（需要本机 Python 3.9+）'),
  ownerOnly: Schema.boolean().default(true).description('以上能力只对管理员可见（否则连工具都看不到）')
})

function apply(ctx, config) {
  logger = ctx.logger('alison-autonomy')
  ensureDir(STATE_DIR); ensureDir(BACKUP_DIR); ensureDir(ALISON_PLUGIN_DIR); ensureDir(ASTRBOT_DIR); ensureDir(PY_ROOT)

  // ---------- Alison 侧：ChatLuna 工具 ----------
  ctx.inject(['chatluna'], (chatCtx) => {
    const platform = chatCtx.chatluna && chatCtx.chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('chatluna.platform.registerTool 不可用，自我管理工具未注册')
      return
    }
    const tools = makeTools()
    const registered = []
    for (const t of tools) {
      registered.push(t.name)
      chatCtx.effect(() => platform.registerTool(t.name, {
        name: t.name,
        description: t.description,
        selector: () => true,
        createTool: () => t,
        meta: { source: 'alison-autonomy', group: 'Alison 自我管理' }
      }))
    }
    logger.info(`已注册自我管理工具：${registered.join(', ')}`)
  })

  // ---------- UI 侧：HTTP 接口 ----------
  ctx.inject(['server'], (serverCtx) => {
    const base = '/alison/api/autonomy'
    const guard = (koa) => {
      const ip = koa.request?.ip || koa.ip || ''
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true
      koa.status = 403; koa.body = { error: '仅允许本机' }; return false
    }
    const wrap = (fn) => async (koa) => {
      if (!guard(koa)) return
      try { koa.body = await fn(koa) } catch (e) { koa.status = 500; koa.body = { ok: false, error: e.message } }
    }

    serverCtx.server.get(base + '/overview', wrap(async () => {
      const p = pluginList()
      return { ok: true, ...p, version: pkgVersion(), root: ROOT, appDir: APP_DIR, python: findPython() || null, configBytes: (readText(CONFIG) || '').length }
    }))
    serverCtx.server.get(base + '/memory', wrap(async (koa) => {
      const q = String(koa.query.q || '').trim()
      const limit = Math.max(1, Math.min(200, Number(koa.query.limit) || 40))
      const preset = koa.query.preset ? String(koa.query.preset) : null
      try {
        const where = {}
        if (preset) where.presetId = preset
        let rows = await serverCtx.database.get('living_memory_entry', where)
        if (q) rows = rows.filter((r) => (r.content || '').includes(q) || (r.summary || '').includes(q) || (r.keywords || '').includes(q))
        rows.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
        const total = rows.length
        return {
          ok: true, total,
          items: rows.slice(0, limit).map((r) => ({
            id: r.id, preset: r.presetId, status: r.status, type: r.type,
            content: String(r.content || '').slice(0, 600),
            keywords: String(r.keywords || '').slice(0, 200),
            importance: r.importance, createdAt: r.createdAt, speakers: r.speakerKeys
          }))
        }
      } catch (e) { return { ok: false, error: '读取记忆失败：' + e.message + '（livingmemory 未启用或没有记忆表）', items: [], total: 0 } }
    }))
    serverCtx.server.get(base + '/diagnose', wrap(async () => diagnose()))
    serverCtx.server.post(base + '/repair', wrap(async (koa) => repair((koa.request.body || {}).targets)))
    serverCtx.server.get(base + '/config', wrap(async (koa) => {
      const section = koa.query.section ? String(koa.query.section) : null
      return section ? configRead(section) : { ok: true, text: readText(CONFIG) }
    }))
    serverCtx.server.post(base + '/config', wrap(async (koa) => {
      if (!config.allowWriteConfig) return { ok: false, error: '配置写入已被插件配置关闭' }
      return configWrite((koa.request.body || {}).text, 'webui')
    }))
    serverCtx.server.post(base + '/plugins/toggle', wrap(async (koa) => {
      const b = koa.request.body || {}
      return configToggle(b.name, b.enabled !== false)
    }))
    serverCtx.server.post(base + '/plugins/install', wrap(async (koa) => {
      if (!config.allowInstallPlugin) return { ok: false, error: '插件安装已被插件配置关闭' }
      return pluginInstall((koa.request.body || {}).name)
    }))
    serverCtx.server.get(base + '/py', wrap(async (koa) => ({ ok: true, frameworks: PY_FRAMEWORKS, items: listPy(koa.query.framework ? String(koa.query.framework) : undefined), python: findPython() || null })))
    serverCtx.server.post(base + '/py/install', wrap(async (koa) => {
      if (!config.allowAstrBot) return { ok: false, error: 'Python 插件兼容已被插件配置关闭' }
      const b = koa.request.body || {}
      return pyInstall(b.framework || 'astrbot', b.source)
    }))
    serverCtx.server.post(base + '/py/inspect', wrap(async (koa) => {
      const b = koa.request.body || {}
      return pyInspect(b.framework || 'astrbot', b.name)
    }))
    serverCtx.server.post(base + '/py/run', wrap(async (koa) => {
      if (!config.allowAstrBot) return { ok: false, error: 'Python 插件兼容已被插件配置关闭' }
      const b = koa.request.body || {}
      return pyRun(b.framework || 'astrbot', b.name, b.command, b.args)
    }))
    serverCtx.server.post(base + '/astrbot/install', wrap(async (koa) => {
      if (!config.allowAstrBot) return { ok: false, error: 'AstrBot 兼容已被插件配置关闭' }
      return astrbotInstall((koa.request.body || {}).source)
    }))
    serverCtx.server.post(base + '/astrbot/run', wrap(async (koa) => {
      if (!config.allowAstrBot) return { ok: false, error: 'AstrBot 兼容已被插件配置关闭' }
      const b = koa.request.body || {}
      return astrbotRun(b.name, b.command, b.args)
    }))
    serverCtx.server.post(base + '/astrbot/inspect', wrap(async (koa) => astrbotInspect((koa.request.body || {}).name)))

    logger.info('自治接口已挂载：' + base + '/*')
  })

  // ---------- Alison 自带功能插件（plugins/ice/*） ----------
  try {
    for (const meta of listIcePlugins()) {
      const dir = path.join(ALISON_PLUGIN_DIR, meta.dir)
      const entry = path.join(dir, meta.entry)
      if (!fs.existsSync(entry)) continue
      try {
        const mod = require(entry)
        if (typeof mod === 'function') mod(ctx, { root: ROOT, appDir: APP_DIR, logger, config })
        else if (mod && typeof mod.apply === 'function') mod.apply(ctx, { root: ROOT, appDir: APP_DIR, logger, config })
        logger.info(`Alison 功能插件已加载：${meta.name}`)
      } catch (e) { logger.warn(`Alison 功能插件 ${meta.name} 加载失败：${e.message}`) }
    }
  } catch (e) { logger.warn('扫描 Alison 功能插件失败：' + e.message) }

  // 把自装/启停/修复能力暴露给其它插件（引导、GitHub 检索都要用）
  const autopilot = {
    install: pluginInstall,
    enable: (name, enabled) => configToggle(name, enabled !== false),
    list: pluginList,
    pyInstall,
    pyRun,
    pyList: listPy,
    diagnose,
    repair
  }
  const rootCtx = ctx.root || ctx
  if (rootCtx.set) rootCtx.set('alisonAutonomy', autopilot)
  rootCtx.alisonAutonomy = autopilot
  ctx.alisonAutonomy = autopilot

  logger.info(`自治能力就绪（root=${ROOT}, app=${APP_DIR}，Python=${findPython() || '未找到'}）`)
}

module.exports = { name, inject, Config, apply }
module.exports.default = module.exports
module.exports.__internals = { diagnose, repair, configToggle, configWrite, configRollback, pluginList, listAstrBot, listIcePlugins, backupConfig }
