/**
 * koishi-plugin-alison-update —— 自己的自动更新（可关闭）
 *
 * · 启动后定时检查 GitHub Release（可关、可改仓库/接口地址）
 * · 有新版：写进日志 + 界面/工具里能看到；可选自动下载、可选自动应用（重启生效）
 * · 一切走配置：enabled / repo / apiBase / autoCheck / checkIntervalHours / notifyOnly / autoApply
 * · 提供 HTTP 接口与 alison_update 工具，让 Alison 自己也能"查更新、装更新"
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { Schema } = require('koishi')

const name = 'alison-update'
const inject = { required: ['server'], optional: ['chatluna'] }

const ROOT = process.env.ALISON_WORKSPACE || process.cwd()
const DATA_DIR = path.join(ROOT, 'data', 'alison-update')

/** 从 argv 推导 app 目录：.../app/node_modules/koishi/bin.js */
function appDirOf() {
  try {
    const bin = process.argv[1] || ''
    const m = bin.replace(/\\/g, '/').match(/^(.*)\/node_modules\/koishi\//)
    if (m) return m[1]
  } catch { /* ignore */ }
  return path.join(ROOT, 'app')
}

const APP_DIR = appDirOf()

function readLocalVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch { return '0.0.0' }
}

/** 版本号比较：a>b 返回 1，相等 0，小于 -1（忽略 v 前缀与非数字段） */
function cmpVersion(a, b) {
  const pa = String(a || '0').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  const pb = String(b || '0').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 按当前系统挑要下载的产物 */
function pickAsset(assets, config) {
  const list = Array.isArray(assets) ? assets : []
  const plat = process.platform
  const arch = process.arch
  const want = (re) => list.find((a) => re.test(String(a.name || '')))
  if (plat === 'win32') {
    return want(/便携版|portable/i) || want(/\.zip$/i) || list[0] || null
  }
  if (plat === 'darwin') {
    const a = arch === 'arm64' ? want(/macOS-arm64/i) : want(/macOS-x64/i)
    return a || want(/macOS/i) || list[0] || null
  }
  return want(/src\.zip$/i) || list[0] || null
}

async function httpGetJson(url, timeoutMs) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs || 15000)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'AlisonBot-Updater', Accept: 'application/vnd.github+json' } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.json()
  } finally { clearTimeout(t) }
}

async function download(url, dest) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 600000)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'AlisonBot-Updater' }, redirect: 'follow' })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const buf = Buffer.from(await r.arrayBuffer())
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf)
    return buf.length
  } finally { clearTimeout(t) }
}

/** 配置以"配置文件"为准：这样界面/文件里改开关立刻生效（Koishi 热重载会按内存回写，插件自己再读一遍最稳） */
function effectiveConfig(config) {
  try {
    const yaml = require('js-yaml')
    const file = path.join(ROOT, 'alison.yml')
    if (!fs.existsSync(file)) return config
    const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {}
    let entry = null
    ;(function walk(n) {
      if (!n || typeof n !== 'object' || entry) return
      for (const [k, v] of Object.entries(n)) {
        if (k.replace(/^~/, '').split(':')[0] === 'alison-update' && v && typeof v === 'object') { entry = v; return }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    return entry ? Object.assign({}, config, entry) : config
  } catch { return config }
}

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用自动更新检查（关掉就完全不联网检查）'),
  repo: Schema.string().default('GWNWRAL/alisonbot').description('GitHub 仓库（owner/name）'),
  apiBase: Schema.string().default('https://api.github.com').description('Release 接口地址（自建/镜像可改）'),
  autoCheck: Schema.boolean().default(true).description('启动后自动检查'),
  checkIntervalHours: Schema.number().default(12).description('每隔多少小时检查一次'),
  notifyOnly: Schema.boolean().default(true).description('只提醒不下载（关掉则自动下载）'),
  autoApply: Schema.boolean().default(false).description('下载后自动应用（会重启，默认关）')
})

async function apply(ctx, config) {
  let logger = ctx.logger ? ctx.logger(name) : console
  const base = '/alison'
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const STATE = path.join(DATA_DIR, 'state.json')
  const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
  const writeState = (v) => { try { fs.writeFileSync(STATE, JSON.stringify(v, null, 2), 'utf8') } catch { /* ignore */ } }

  const status = () => {
    const cfg = effectiveConfig(config)
    const s = readState()
    return {
      enabled: cfg.enabled !== false,
      local: readLocalVersion(),
      latest: s.latest || null,
      hasUpdate: !!s.hasUpdate,
      checkedAt: s.checkedAt || null,
      asset: s.asset || null,
      downloaded: s.downloaded || null,
      applied: !!s.applied,
      repo: cfg.repo,
      apiBase: cfg.apiBase,
      notifyOnly: cfg.notifyOnly !== false,
      autoApply: !!cfg.autoApply,
      appDir: APP_DIR,
      assets: s.assets || []
    }
  }

  const check = async () => {
    const cfg = effectiveConfig(config)
    const local = readLocalVersion()
    const url = `${String(cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '')}/repos/${cfg.repo}/releases/latest`
    const st = { local, checkedAt: Date.now(), url }
    try {
      const rel = await httpGetJson(url, 15000)
      const latest = String(rel.tag_name || rel.name || '').replace(/^v/i, '')
      const assets = (rel.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
      st.latest = latest
      st.assets = assets
      st.hasUpdate = cmpVersion(latest, local) > 0
      st.asset = pickAsset(assets, config)
      writeState(Object.assign(readState(), st))
      if (st.hasUpdate) logger.info(`发现新版本 ${latest}（当前 ${local}）：${st.asset ? st.asset.name : '（该平台暂无对应产物）'}`)
      else logger.info(`已是最新版本（${local}）`)
      return Object.assign({ ok: true }, st)
    } catch (e) {
      st.error = e.message
      writeState(Object.assign(readState(), { checkedAt: st.checkedAt, error: e.message }))
      logger.warn('检查更新失败：' + e.message)
      return Object.assign({ ok: false }, st)
    }
  }

  const downloadAndPrepare = async () => {
    const cfg = effectiveConfig(config)
    const s = readState()
    if (!s.hasUpdate || !s.asset) return { ok: false, error: '没有可用的新版本产物（先跑一次检查）' }
    const dest = path.join(DATA_DIR, 'download', s.asset.name)
    let size
    try { size = await download(s.asset.url, dest) } catch (e) { return { ok: false, error: '下载失败：' + e.message } }
    // 生成"退出后替换 + 重启"的脚本（Windows .cmd / 其它 .sh）
    const isWin = process.platform === 'win32'
    const script = path.join(DATA_DIR, 'download', isWin ? 'apply-update.cmd' : 'apply-update.sh')
    const installDir = path.dirname(APP_DIR)
    if (isWin) {
      fs.writeFileSync(script, [
        '@echo off',
        'chcp 65001 >nul',
        'rem 等 Alison 退出后再替换 app 目录（工作区不动）',
        'timeout /t 4 /nobreak >nul',
        'taskkill /f /im Alison.exe >nul 2>nul',
        'timeout /t 2 /nobreak >nul',
        `set "PKG=${dest}"`,
        `set "DIR=${installDir}"`,
        'if exist "%DIR%\\app.old" rd /s /q "%DIR%\\app.old"',
        'move "%DIR%\\app" "%DIR%\\app.old" >nul',
        'powershell -NoProfile -Command "Expand-Archive -LiteralPath \'%PKG%\' -DestinationPath \'%DIR%\\_upd\' -Force"',
        'if exist "%DIR%\\_upd\\app" (move "%DIR%\\_upd\\app" "%DIR%\\app" >nul) else (move "%DIR%\\_upd" "%DIR%\\app" >nul)',
        'rd /s /q "%DIR%\\_upd" 2>nul',
        'start "" "%DIR%\\Alison.exe"',
        'echo 更新完成',
        ''
      ].join('\r\n'), 'utf8')
    } else {
      fs.writeFileSync(script, [
        '#!/usr/bin/env bash',
        '# 等 Alison 退出后再替换 app 目录（工作区不动）',
        'sleep 4',
        `PKG="${dest}"`,
        `DIR="${installDir}"`,
        'rm -rf "$DIR/app.old"',
        'mv "$DIR/app" "$DIR/app.old"',
        'TMP="$(mktemp -d)"',
        'unzip -q "$PKG" -d "$TMP"',
        'if [ -d "$TMP/app" ]; then mv "$TMP/app" "$DIR/app"; else mv "$TMP" "$DIR/app"; fi',
        `( cd "$DIR" && (./Alison.exe >/dev/null 2>&1 &) ) 2>/dev/null || echo "请手动重启 Alison"`,
        ''
      ].join('\n'), 'utf8')
      try { fs.chmodSync(script, 0o755) } catch { /* ignore */ }
    }
    writeState(Object.assign(readState(), { downloaded: { file: dest, size, script, at: Date.now() } }))
    logger.info(`已下载 ${s.asset.name}（${(size / 1048576).toFixed(1)} MB）→ ${script}`)
    return { ok: true, file: dest, size, script }
  }

  const applyNow = async () => {
    const cfg = effectiveConfig(config)
    const s = readState()
    let d = s.downloaded
    if (!d || !fs.existsSync(d.script)) {
      const r = await downloadAndPrepare()
      if (!r.ok) return r
      d = readState().downloaded
    }
    const isWin = process.platform === 'win32'
    try {
      const { spawn } = require('node:child_process')
      const p = spawn(d.script, [], { detached: true, stdio: 'ignore', shell: isWin, windowsHide: true })
      p.unref()
      writeState(Object.assign(readState(), { applied: true, appliedAt: Date.now() }))
      logger.info('更新脚本已启动，Alison 即将退出并完成替换，然后自动重启')
      setTimeout(() => { try { process.exit(0) } catch { /* ignore */ } }, 1500)
      return { ok: true, script: d.script, restarting: true }
    } catch (e) { return { ok: false, error: e.message } }
  }

  /* ---------------- 挂到 root，别的插件/界面能用 ---------------- */
  try { ctx.root.set('alisonUpdate', { status, check, download: downloadAndPrepare, apply: applyNow }) } catch { /* ignore */ }

  /* ---------------- HTTP ---------------- */
  ctx.server.get(base + '/api/update/status', async (koa) => { koa.body = Object.assign({ ok: true }, status()) })
  ctx.server.post(base + '/api/update/check', async (koa) => { koa.body = await check() })
  ctx.server.post(base + '/api/update/download', async (koa) => { koa.body = await downloadAndPrepare() })
  ctx.server.post(base + '/api/update/apply', async (koa) => { koa.body = await applyNow() })

  /* ---------------- 工具：让 Alison 自己也能查/装更新 ---------------- */
  ctx.inject(['chatluna'], (ctx2) => {
    try {
      const platform = ctx2.chatluna && ctx2.chatluna.platform
      if (!platform || typeof platform.registerTool !== 'function') return
      const { StructuredTool } = require('@langchain/core/tools')
      const { z } = require('zod')
      const tool = new (class extends StructuredTool {
        name = 'alison_update'
        description = '查看/安装 Alison 自己的更新：status 看当前版本与检查结果、check 立刻联网检查、download 下载新版、apply 应用（会重启自己）。'
        schema = z.object({ action: z.enum(['status', 'check', 'download', 'apply']).describe('要做什么') })
        async _call({ action }) {
          try {
            if (action === 'status') return JSON.stringify(status())
            if (action === 'check') return JSON.stringify(await check())
            if (action === 'download') return JSON.stringify(await downloadAndPrepare())
            if (action === 'apply') return JSON.stringify(await applyNow())
            return '未知操作'
          } catch (e) { return '更新操作失败：' + e.message }
        }
      })()
      platform.registerTool(tool.name, {
        name: tool.name, description: tool.description, selector: () => true,
        createTool: () => tool, meta: { source: 'alison-update', group: 'Alison 自我管理' }
      })
      logger.info('已注册工具：alison_update')
    } catch (e) { logger.warn('注册更新工具失败（不影响接口）：' + e.message) }
  })

  /* ---------------- 自动检查 ---------------- */
  if (config.enabled !== false && config.autoCheck !== false) {
    const run = () => { check().catch(() => { /* ignore */ }) }
    setTimeout(run, 15000)
    const hours = Math.max(1, Number(config.checkIntervalHours) || 12)
    const timer = setInterval(() => { if (effectiveConfig(config).enabled !== false) run() }, hours * 3600 * 1000)
    try { ctx.on('dispose', () => clearInterval(timer)) } catch { /* ignore */ }
  }

  logger.info(`更新插件就绪：当前 v${readLocalVersion()}，自动检查=${config.enabled !== false && config.autoCheck !== false}，只提醒=${config.notifyOnly !== false}，自动应用=${!!config.autoApply}`)
  function_name_placeholder()
}

function function_name_placeholder() { /* noop */ }

module.exports = { name, inject, Config, apply }
module.exports.name = name
module.exports.inject = inject
module.exports.Config = Config
module.exports.apply = apply
