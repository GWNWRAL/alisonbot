'use strict'

/**
 * koishi-plugin-alison-hotreload
 *
 * 让 Alison（Koishi / ChatLuna）能**自己重启自己**、**自己重载配置**。
 *
 *   1. alison_restart      预约一次自重启（先回复完，再由脱离进程树的助手去重启）
 *   2. alison_reload       热重载 koishi.yml（进程内 reload，不重启）／校验角色预设
 *   3. alison_self_status  自己的运行状态：pid / 运行时长 / 端口 / 配置指纹 / 上次重启与重载
 *
 * 为什么不是「直接杀掉自己再起来」：
 *   - Alison 就跑在 Koishi 里，`taskkill` 掉 node 的那一瞬间自己也死了；
 *   - `koishi.db` 是 SQLite，强杀有小概率损坏（见 `D:\Alison\koishi\README.md` 坑 2/红线 5）。
 *   所以这里走的是**启动器（koi.exe）自己的重启通道**：
 *   `koi restart <instance>` → 启动器优雅停掉实例（CTRL_C）→ 再拉起来。
 *   这正是托盘菜单「重启」和命令行 `koi restart default` 走的那条路。
 *
 * 助手进程（lib/restart-helper.js）是 detached 的，脱离 Koishi 的进程树与控制台，
 * 因此实例被停掉时它不受影响；它还会在实例没回来时兜底跑启动脚本。
 *
 * 安全取向：
 *   - 三个工具默认**只对 ownerIds 里的人开放**（工具本身对它人不可见，且 handler 再拦一次）；
 *   - 任何输出都只报**键路径**，绝不回显配置值（koishi.yml 里有明文密钥）；
 *   - 重载前先校验 YAML，校验失败直接放弃（配置一个字都不动）；
 *   - 改配置前自动备份到 `<数据根>/backups/`。
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const yaml = require('js-yaml')
const { Schema } = require('koishi')
const { StructuredTool } = require('@langchain/core/tools')
const { z } = require('zod')

const name = 'alison-hotreload'
const inject = { optional: ['chatluna', 'chatluna_character'] }

const usage = `
## alison-hotreload

让 Alison 能自己重启自己、自己重载配置。

- \`alison_restart\`：预约一次自重启（先回复完，再由启动器优雅重启）。改完 \`koishi.yml\` 后用它。
- \`alison_reload\`：**进程内热重载** \`koishi.yml\`（不重启、不断线），或校验角色预设。
- \`alison_self_status\`：看自己的 pid / 运行时长 / 端口 / 配置指纹 / 上次重启与重载结果。

只有管理员（\`ownerIds\`）能用；其他人连工具都看不到。
`

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(true).description('总开关：关闭后所有工具直接返回「已禁用」。'),
    requireOwner: Schema.boolean().default(true).description('是否只允许 ownerIds 里的人使用（强烈建议保持开启）。'),
    ownerIds: Schema.array(Schema.string()).role('table').default([]).description('允许自重启 / 重载的 QQ 号。留空 = 只认 Koishi 管理员权限（authority ≥ 4）。'),
    defaultDelaySeconds: Schema.natural().default(12).description('默认延迟多少秒再重启（留够时间把当前回复发出去）。'),
    minDelaySeconds: Schema.natural().default(3).description('延迟下限（秒）。'),
    maxDelaySeconds: Schema.natural().default(600).description('延迟上限（秒）。'),
  }).description('总开关与权限'),

  Schema.object({
    koiPath: Schema.string().default('').description('启动器 koi.exe 路径。留空 = C:\\Program Files\\Koishi\\Desktop\\koi.exe。'),
    instanceName: Schema.string().default('default').description('启动器里的实例名（koi ps 里那个）。'),
    restartMode: Schema.union([
      Schema.const('auto').description('自动：先试进程内自重启（最快），不行再由助手升级到启动器 / 启动脚本'),
      Schema.const('app').description('只用进程内自重启：loader.fullReload()，退出码 51 让 koishi start 原地重新 fork worker'),
      Schema.const('launcher').description('只用启动器：koi restart <instance>（等于托盘菜单「重启」）'),
      Schema.const('legacy').description('只用旧脚本：taskkill 强杀 + 启动脚本（SQLite 有小概率风险）'),
    ]).default('auto').description('自重启走哪条路。'),
    launcherScript: Schema.string().default('').description('兜底启动脚本。留空 = <数据根>/tools/启动Alison.cmd。'),
    legacyRestartScript: Schema.string().default('').description('旧的重启脚本（强杀 + 拉起）。留空 = <数据根>/tools/restart-koishi.cmd。'),
    serverPort: Schema.natural().default(5140).description('Koishi 控制台端口，用来判断实例死没死。'),
    helperWaitBackSeconds: Schema.natural().default(120).description('助手最多等多少秒让实例回来，超时就跑兜底启动脚本。'),
    allowHardKillFallback: Schema.boolean().default(false).description('启动器重启彻底失败时，是否允许退回「taskkill + 启动脚本」（强杀有 SQLite 风险，默认关闭）。'),
    autoBackup: Schema.boolean().default(true).description('改配置前自动备份到 <数据根>/backups/。'),
  }).description('路径与重启引擎'),

  Schema.object({
    debugLog: Schema.boolean().default(false).description('输出调试日志。'),
  }).description('调试'),
])

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const SELFOP_DIRNAME = 'alison-hotreload'

function redact(text) {
  if (typeof text !== 'string') return text
  // 双保险：任何形如 sk-xxxx 的串都不许出现在输出里
  return text
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/(apiKey|api_key|token|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/gi, '$1=***')
}

function reply(value) {
  try {
    return redact(JSON.stringify(value))
  } catch (err) {
    return JSON.stringify({ ok: false, error: 'serialize_failed', message: String(err && err.message || err) })
  }
}

function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function hashFile(file) {
  try {
    return sha1(fs.readFileSync(file))
  } catch {
    return null
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(file, value) {
  try {
    ensureDir(path.dirname(file))
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 用一次 TCP 连接判断端口是否在监听（比 netstat 可靠，也不用起子进程）。 */
function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    const socket = net.connect({ port: Number(port), host })
    socket.setTimeout(timeout)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

/** "20" / "20s" / "2m" / "1h" / "90 秒" → 秒数。 */
function parseDelay(input, fallback) {
  if (input === undefined || input === null || input === '') return fallback
  if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input)
  const text = String(input).trim().toLowerCase()
  let match = /^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds|秒)?$/.exec(text)
  if (match) return Math.round(parseFloat(match[1]))
  match = /^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes|分|分钟)$/.exec(text)
  if (match) return Math.round(parseFloat(match[1]) * 60)
  match = /^(\d+(?:\.\d+)?)\s*(?:h|hour|hours|小时)$/.exec(text)
  if (match) return Math.round(parseFloat(match[1]) * 3600)
  return fallback
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(Math.round(n), min), max)
}

function kindOf(value) {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return 'leaf'
  return typeof value === 'object' ? 'object' : 'leaf'
}

function hashValue(value) {
  try {
    return sha1(JSON.stringify(value === undefined ? null : value))
  } catch {
    return 'unhashable'
  }
}

/**
 * 对比两份配置，只返回**发生了什么**（键路径 + 增/删/改），
 * 绝不返回值本身 —— koishi.yml 里全是明文密钥，绝对不能进聊天记录。
 */
function diffConfig(before, after, limit = 200) {
  const out = []
  const walk = (a, b, prefix) => {
    if (out.length > limit) return
    if (kindOf(a) === 'object' && kindOf(b) === 'object') {
      const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
      for (const key of keys) {
        const next = prefix ? `${prefix}.${key}` : key
        const inA = a && Object.prototype.hasOwnProperty.call(a, key)
        const inB = b && Object.prototype.hasOwnProperty.call(b, key)
        if (!inB) out.push({ path: next, kind: 'removed' })
        else if (!inA) out.push({ path: next, kind: 'added' })
        else walk(a[key], b[key], next)
      }
      return
    }
    if (hashValue(a) !== hashValue(b)) out.push({ path: prefix || '(root)', kind: 'changed' })
  }
  walk(before || {}, after || {}, '')
  return out
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

class State {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.logger = ctx.logger('alison-hotreload')
    this.paths = this.resolvePaths()
    ensureDir(this.paths.dataDir)
  }

  resolvePaths() {
    const cfg = this.config
    const instanceDir = (this.ctx.baseDir && fs.existsSync(this.ctx.baseDir))
      ? this.ctx.baseDir
      : process.cwd()
    const rootDir = path.dirname(instanceDir)
    const loaderFile = this.ctx.loader && this.ctx.loader.filename
    return {
      instanceDir,
      rootDir,
      configPath: path.resolve(loaderFile || path.join(instanceDir, 'koishi.yml')),
      presetPath: path.join(instanceDir, 'data', 'chathub', 'character', 'presets', 'Alison.yml'),
      dataDir: path.join(instanceDir, 'data', SELFOP_DIRNAME),
      backupsDir: path.join(rootDir, 'backups'),
      koiPath: cfg.koiPath || 'C:\\Program Files\\Koishi\\Desktop\\koi.exe',
      launcherScript: cfg.launcherScript || path.join(rootDir, 'tools', '启动Alison.cmd'),
      legacyRestartScript: cfg.legacyRestartScript || path.join(rootDir, 'tools', 'restart-koishi.cmd'),
      helperScript: path.join(__dirname, 'restart-helper.js'),
      bootFile: path.join(instanceDir, 'data', SELFOP_DIRNAME, 'boot.json'),
      intentFile: path.join(instanceDir, 'data', SELFOP_DIRNAME, 'intent.json'),
      lastRestartFile: path.join(instanceDir, 'data', SELFOP_DIRNAME, 'last-restart.json'),
      lastReloadFile: path.join(instanceDir, 'data', SELFOP_DIRNAME, 'last-reload.json'),
    }
  }

  /* ---------------- 权限 ---------------- */

  static userIdOf(session) {
    if (!session) return null
    const raw = session.userId
      || (session.user && session.user.id)
      || (session.event && session.event.user && session.event.user.id)
      || (session.author && session.author.id)
      || null
    if (raw === undefined || raw === null || raw === '') return null
    return String(raw)
  }

  isOwner(session) {
    if (!this.config.requireOwner) return true
    // 统一管理员模型（issue #3）：先问微内核
    try {
      const core = this.ctx && this.ctx.root && this.ctx.root.alison
      if (core && core.admin) {
        const info = core.admin.info()
        if (info.fromCore || info.legacy.length) return core.admin.isAdmin({ session, userId: State.userIdOf(session) })
      }
    } catch { /* ignore */ }
    const owners = (this.config.ownerIds || []).map(String).filter(Boolean)
    const id = State.userIdOf(session)
    if (id && owners.includes(id)) return true
    // 兜底：Koishi 自己的管理员权限
    if (session && typeof session.authority === 'number' && session.authority >= 4) return true
    if (!owners.length && !session) return false
    return false
  }

  guard(session, action) {
    if (!this.config.enabled) {
      return reply({ ok: false, error: 'disabled', message: 'alison-hotreload 已被配置关闭。' })
    }
    if (this.isOwner(session)) return null
    const id = State.userIdOf(session)
    this.logger.warn(`拒绝了来自 ${id || '(未知)'} 的 ${action} 请求`)
    return reply({
      ok: false,
      error: 'forbidden',
      message: '只有管理员才能让我重启或重载配置。这条请求已经被拒绝，配置没有任何改动。',
    })
  }

  /* ---------------- 配置校验 / 备份 ---------------- */

  /** 只做校验，不落盘、不重启。 */
  validateConfigFile(file, label) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, error: 'unreadable', file: label, message: String(err && err.message || err) }
    }
    let parsed
    try {
      parsed = yaml.load(text)
    } catch (err) {
      return {
        ok: false,
        error: 'yaml_invalid',
        file: label,
        message: `YAML 解析失败：${String(err && err.message || err)}`,
        hash: sha1(text),
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'not_an_object', file: label, message: '顶层不是一个对象。', hash: sha1(text) }
    }
    return { ok: true, file: label, hash: sha1(text), parsed, text }
  }

  backupConfig(reason) {
    if (!this.config.autoBackup) return null
    try {
      ensureDir(this.paths.backupsDir)
      const target = path.join(this.paths.backupsDir, `koishi.yml.bak-${reason}-${stamp()}`)
      fs.copyFileSync(this.paths.configPath, target)
      return target
    } catch (err) {
      this.logger.warn(`备份失败：${err && err.message ? err.message : err}`)
      return null
    }
  }

  countLoadedPlugins() {
    try {
      const { Loader } = require('@koishijs/loader')
      const entry = this.ctx.loader && this.ctx.loader.entry
      const record = entry && entry.scope && entry.scope[Loader.kRecord]
      return record ? Object.keys(record).length : null
    } catch {
      return null
    }
  }

  /** 有没有一个刚起来的助手进程（避免十秒内排两次重启）。 */
  pendingHelper() {
    const dir = this.paths.dataDir
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('helper-') && f.endsWith('.json'))
    } catch {
      return null
    }
    let newest = null
    for (const file of files) {
      const full = path.join(dir, file)
      const data = readJson(full)
      const mtime = safeMtime(full)
      if (!data || !mtime) continue
      const ageSeconds = (Date.now() - mtime) / 1000
      if (ageSeconds > 900) continue
      if (!newest || mtime > newest.mtime) newest = { file: full, data, mtime, ageSeconds: Math.round(ageSeconds) }
    }
    return newest
  }

  /* ---------------- 重启 ---------------- */

  /**
   * 能不能走「进程内自重启」。
   *
   * 三个条件缺一不可（都在本机装好的代码里核对过）：
   *   1. `process.send` 存在 —— 说明我们是被 `child_process.fork` 出来的 worker，有 IPC 通道
   *      （koi.exe 直接起的那个进程没有 IPC，fullReload 会静默失败）；
   *   2. `KOISHI_SHARED` 环境变量在 —— `koishi/lib/cli/index.js` 在 fork 之前设的，
   *      它是「我上面确实有一个 koishi start 会给我重新 fork」的硬证据；
   *   3. loader 有 `fullReload`、root 有 `stop`。
   */
  canSelfRestart() {
    try {
      return typeof process.send === 'function'
        && !!process.env.KOISHI_SHARED
        && !!this.ctx.loader && typeof this.ctx.loader.fullReload === 'function'
        && !!this.ctx.root && typeof this.ctx.root.stop === 'function'
    } catch {
      return false
    }
  }

  resolveMode(requested) {
    const auto = () => (this.canSelfRestart() ? 'app' : 'launcher')
    if (requested === 'auto') return auto()
    if (requested) return String(requested)
    const ask = String(this.config.restartMode || 'auto')
    if (ask !== 'auto') return ask
    // auto：能自己重启就自己重启（最快，不用惊动启动器），否则交给启动器
    return auto()
  }

  /**
   * 进程内自重启（mode=app）。
   *
   * 先 `ctx.root.stop()` 让所有 dispose 跑完（数据库连接、子进程……），
   * loader 注册在 root 上的 dispose 监听会调 fullReload()：
   * 它把 envData 用 IPC 发回 `koishi start`，然后 process.exit(51)；
   * koishi start 看到 51 会**原地重新 fork 一个 worker** —— 这就是「自己重启自己」。
   *
   * 注意退出码别写错：51 = 重启 app 进程（worker）；52 = 让 koi.exe 把整个实例重开。
   * 正常路径下 51 是 fullReload() 自己带的；只有兜底 2 才由我们直接写死 51。
   */
  scheduleAppRestart(delaySeconds, token) {
    const timer = setTimeout(() => {
      writeJson(path.join(this.paths.dataDir, 'app-restart.json'), {
        at: nowIso(), token, pid: process.pid, delaySeconds,
      })
      this.logger.info('自重启（进程内）：dispose 之后由 loader 请求 fullReload（退出码 51）')
      try {
        const stopping = this.ctx.root.stop()
        if (stopping && typeof stopping.catch === 'function') stopping.catch(() => {})
      } catch (err) {
        this.logger.error(`ctx.root.stop() 出错：${err && err.message ? err.message : err}`)
      }
      // 兜底 1：万一 dispose 那条路没走到 fullReload，3 秒后自己叫一次
      setTimeout(() => {
        try {
          this.ctx.loader.fullReload()
        } catch (err) {
          this.logger.error(`fullReload() 出错：${err && err.message ? err.message : err}`)
        }
      }, 3000)
      // 兜底 2：还是没退，就按约定直接退（51 = 让 koishi start 原地重新 fork worker）。
      //        到这一步 app 早就 dispose 完了，退出不会丢东西；真没人重新拉起，
      //        外面的助手也会发现端口一直不通，升级到启动器 / 启动脚本。
      setTimeout(() => {
        this.logger.warn('自重启：前两条路都没把进程带走，直接按退出码 51 退出')
        process.exit(51)
      }, 6000)
    }, Math.max(0, delaySeconds * 1000))
    this.appRestartTimer = timer
    return timer
  }

  /**
   * 真正的动作：spawn 一个 detached 的助手进程。
   *
   * 助手干什么取决于 mode：
   *   - app：插件自己在进程里重启，助手负责「盯梢 + 升级」（端口断没断、回没回来）；
   *   - launcher / legacy：助手自己动手，让启动器或旧脚本去重启。
   *
   * 不管哪种，助手都会先写一个 ready 文件，我们等它出现 ——
   * 这样「排期成功」是可验证的，而不是「以为 spawn 成功了」。
   */
  async spawnHelper(options) {
    const { delay, token, reason, mode } = options
    const helper = this.paths.helperScript
    if (!fs.existsSync(helper)) {
      return { ok: false, error: 'helper_missing', message: `找不到助手脚本：${helper}` }
    }
    ensureDir(this.paths.dataDir)
    const intentFile = this.paths.intentFile
    writeJson(intentFile, {
      token,
      at: nowIso(),
      delaySeconds: delay,
      mode,
      reason: reason || '',
      pid: process.pid,
      requester: options.requester || null,
    })

    const args = [
      helper,
      '--delay', String(delay),
      '--port', String(this.config.serverPort),
      '--instance', String(this.config.instanceName),
      '--koi', this.paths.koiPath,
      '--launcher', this.paths.launcherScript,
      '--legacy', this.paths.legacyRestartScript,
      '--dir', this.paths.dataDir,
      '--token', token,
      '--wait-back', String(this.config.helperWaitBackSeconds),
      '--mode', mode,
      '--intent', intentFile,
      '--allow-hard-kill', this.config.allowHardKillFallback ? '1' : '0',
    ]

    let child
    try {
      child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: this.paths.instanceDir,
      })
      child.unref()
    } catch (err) {
      return { ok: false, error: 'spawn_failed', message: String(err && err.message || err) }
    }

    const readyFile = path.join(this.paths.dataDir, `helper-${token}.json`)
    let ready = null
    for (let i = 0; i < 24; i++) {
      ready = readJson(readyFile)
      if (ready) break
      await sleep(250)
    }
    if (!ready) {
      return {
        ok: false,
        error: 'helper_not_started',
        message: '助手进程没能在 6 秒内起来（没有写 ready 文件）。重启没有排期，实例仍在正常运行。',
        pid: child.pid || null,
        log: path.join(this.paths.dataDir, 'restart-helper.log'),
      }
    }
    return { ok: true, helperPid: ready.pid, readyFile, log: path.join(this.paths.dataDir, 'restart-helper.log') }
  }

  async handleRestart(input, runConfig) {
    const session = runConfig && runConfig.configurable && runConfig.configurable.session
    const denied = this.guard(session, 'alison_restart')
    if (denied) return denied

    const pending = this.pendingHelper()
    if (pending) {
      return reply({
        ok: false,
        error: 'already_pending',
        message: `已经有一次重启在排队了（${pending.data && pending.data.at ? pending.data.at : '刚刚'}，还有约 ${Math.max(0, (pending.data && pending.data.delaySeconds ? pending.data.delaySeconds : 0) - pending.ageSeconds)} 秒动手）。不要重复排期。`,
        pending: { token: pending.data && pending.data.token, at: pending.data && pending.data.at },
      })
    }

    const delay = clamp(parseDelay(input.delay, this.config.defaultDelaySeconds), this.config.minDelaySeconds, this.config.maxDelaySeconds)
    const mode = this.resolveMode(input.mode)

    // ① 校验：配置坏了就不要重启 —— 重启只会让坏配置生效，然后你就回不来了
    const checks = []
    const configCheck = this.validateConfigFile(this.paths.configPath, 'koishi.yml')
    checks.push({ file: 'koishi.yml', ok: configCheck.ok, error: configCheck.error || null, message: configCheck.message || null, hash: configCheck.hash || null })
    if (fs.existsSync(this.paths.presetPath)) {
      const presetCheck = this.validateConfigFile(this.paths.presetPath, 'Alison.yml')
      checks.push({ file: 'Alison.yml', ok: presetCheck.ok, error: presetCheck.error || null, message: presetCheck.message || null, hash: presetCheck.hash || null })
    }
    const broken = checks.filter((c) => !c.ok)
    if (broken.length && !input.skip_validate) {
      return reply({
        ok: false,
        error: 'config_invalid',
        message: `这些文件有问题，**没有**重启（配置一个字没动）：${broken.map((b) => `${b.file}: ${b.error}`).join('；')}。修好再用 alison_restart；确实要强行重启就传 skip_validate=true。`,
        checks,
      })
    }

    // ② 备份
    const backup = this.config.autoBackup ? this.backupConfig('selfop-restart') : null

    // ③ 排期
    const token = crypto.randomBytes(4).toString('hex')
    const result = await this.spawnHelper({
      delay,
      token,
      reason: input.reason || '',
      mode,
      requester: State.userIdOf(session),
    })

    if (!result.ok) {
      return reply({ ok: false, error: result.error, message: result.message, checks, backup, token })
    }

    // ④ mode=app 时，真正动手的是我们自己：延迟到点后在进程里 dispose + fullReload
    if (mode === 'app') this.scheduleAppRestart(delay, token)

    const how = mode === 'app'
      ? '进程内自重启（loader.fullReload，退出码 51，koishi start 原地重开）'
      : mode === 'launcher'
        ? '启动器重启（koi restart，等于托盘菜单「重启」）'
        : '旧脚本重启（强杀 + 启动脚本）'
    this.logger.info(`已排期自重启：${delay}s 后 · ${how}（token=${token}${input.reason ? '，原因：' + input.reason : ''}）`)
    return reply({
      ok: true,
      scheduled: true,
      delay_seconds: delay,
      fire_at: new Date(Date.now() + delay * 1000).toISOString(),
      mode,
      how,
      token,
      backup,
      checks,
      helper_pid: result.helperPid,
      log: result.log,
      message: `好，${delay} 秒后重启（${how}）。现在把这句话发出去，然后我就会断线几秒再回来。助手会在旁边盯着，真起不来它会兜底。（日志：${result.log}）`,
    })
  }

  /* ---------------- 热重载 ---------------- */

  async handleReload(input, runConfig) {
    const session = runConfig && runConfig.configurable && runConfig.configurable.session
    const denied = this.guard(session, 'alison_reload')
    if (denied) return denied

    const target = String(input.target || 'config').toLowerCase()
    const dryRun = !!input.dry_run
    const report = {
      ok: true,
      at: nowIso(),
      target,
      dry_run: dryRun,
      applied: [],
      skipped: [],
      checks: [],
      changed: [],
      changed_count: 0,
      changed_truncated: false,
      needs_restart: false,
      notes: [],
    }

    const wantsConfig = ['config', 'all', 'koishi', 'koishi.yml', 'yml'].includes(target)
    const wantsPreset = ['preset', 'all', 'ice', 'alison.yml', 'character'].includes(target)
    if (!wantsConfig && !wantsPreset) {
      return reply({ ok: false, error: 'bad_target', message: `target 只能是 config / preset / all，收到的是「${target}」。` })
    }

    /* ---- koishi.yml ---- */
    if (wantsConfig) {
      const check = this.validateConfigFile(this.paths.configPath, 'koishi.yml')
      report.checks.push({ file: 'koishi.yml', ok: check.ok, error: check.error || null, message: check.message || null, hash: check.hash || null })
      if (!check.ok) {
        return reply({
          ok: false,
          error: 'config_invalid',
          message: `koishi.yml 没通过校验，**已放弃重载**（配置一个字没动，进程照常在跑）：${check.message}`,
          checks: report.checks,
        })
      }
      if (!check.parsed.plugins || typeof check.parsed.plugins !== 'object') {
        return reply({
          ok: false,
          error: 'config_no_plugins',
          message: 'koishi.yml 里没有 plugins 段，看起来不像一份完整配置，已放弃重载。',
          checks: report.checks,
        })
      }

      const loader = this.ctx.loader
      if (!loader || typeof loader.readConfig !== 'function' || !this.ctx.root || !this.ctx.root.scope) {
        return reply({ ok: false, error: 'no_loader', message: '拿不到 loader，无法在进程内重载。请改用 alison_restart 做完整重启。' })
      }

      const running = loader.config || {}
      const diff = diffConfig(running, check.parsed, 200)
      report.changed = diff.slice(0, 40)
      report.changed_count = diff.length
      report.changed_truncated = diff.length > 40

      if (!diff.length) {
        report.notes.push('koishi.yml 和正在跑的配置没有差异，不用重载。')
        return reply(report)
      }

      // 顶层字段（nickname / prefix / …）不属于任何插件，热重载不会让它们重新生效
      const topLevel = [...new Set(diff.filter((d) => !d.path.includes('.')).map((d) => d.path))]
      const nonPlugins = topLevel.filter((key) => key !== 'plugins')
      if (nonPlugins.length) {
        report.needs_restart = true
        report.notes.push(`改动涉及顶层字段（${nonPlugins.join('、')}）：这些不走插件 reload，要完整重启才会生效。`)
      }
      if (diff.some((d) => d.kind === 'added' && d.path.startsWith('plugins.')) || diff.some((d) => d.kind === 'removed' && d.path.startsWith('plugins.'))) {
        report.notes.push('有插件被新增 / 移除：如果它是新装的依赖，进程内 reload 装不上，需要用 alison_restart 完整重启。')
      }

      if (dryRun) {
        report.notes.push('dry_run：只做了校验和对比，没有真的重载。')
        return reply(report)
      }

      if (this.config.autoBackup) report.backup = this.backupConfig('selfop-reload')

      const beforeCount = this.countLoadedPlugins()
      let config
      try {
        config = await loader.readConfig()
      } catch (err) {
        return reply({ ok: false, error: 'reload_failed', message: `重新读取 koishi.yml 失败：${String(err && err.message || err)}`, checks: report.checks })
      }

      try {
        loader.config = config
        // 和官方 hmr 插件同一条路：更新 root scope 的 config，
        // 触发 loader 注册的 accept，把变化的插件 fork 重新 reload
        this.ctx.root.scope.update(config)
        this.ctx.root.emit('config')
      } catch (err) {
        report.ok = false
        report.error = 'apply_failed'
        report.message = `应用配置时出错：${String(err && err.message || err)}`
        return reply(report)
      }

      report.applied.push('koishi.yml')
      report.loaded_plugins_before = beforeCount
      report.loaded_plugins_after = this.countLoadedPlugins()
      report.config_hash = hashFile(this.paths.configPath)
      report.notes.push('已按进程内 reload 应用；`alison_self_status` 可以确认配置指纹。')
    }

    /* ---- 角色预设 Alison.yml ---- */
    if (wantsPreset) {
      if (!fs.existsSync(this.paths.presetPath)) {
        report.skipped.push('Alison.yml')
        report.notes.push(`找不到角色预设：${this.paths.presetPath}`)
      } else {
        const check = this.validateConfigFile(this.paths.presetPath, 'Alison.yml')
        report.checks.push({ file: 'Alison.yml', ok: check.ok, error: check.error || null, message: check.message || null, hash: check.hash || null })
        if (!check.ok) {
          report.ok = false
          report.error = 'preset_invalid'
          report.message = `角色预设没通过校验：${check.message}`
          return reply(report)
        }
        if (dryRun) {
          report.notes.push('dry_run：预设只做了校验，没有重载。')
        } else {
          const service = this.ctx.chatluna_character
          const preset = service && servalison.preset
          if (preset && typeof preset.loadAllPreset === 'function') {
            try {
              await preset.loadAllPreset()
              report.applied.push('Alison.yml')
              report.preset_hash = check.hash
              report.needs_restart = true
              report.notes.push('预设列表已重新读盘；但 chatluna-character 内部还有一层会话级预设缓存，完全生效最稳的是 alison_restart。')
            } catch (err) {
              report.ok = false
              report.error = 'preset_reload_failed'
              report.message = `重载预设出错：${String(err && err.message || err)}`
              return reply(report)
            }
          } else {
            report.skipped.push('Alison.yml')
            report.needs_restart = true
            report.preset_hash = check.hash
            report.notes.push('预设文件校验通过，但没有找到可调用的重载入口；改动要 alison_restart 之后才生效。')
          }
        }
      }
    }

    writeJson(this.paths.lastReloadFile, {
      at: report.at,
      target,
      dry_run: dryRun,
      changed_count: report.changed_count,
      changed: report.changed,
      applied: report.applied,
      needs_restart: report.needs_restart,
      by: State.userIdOf(session),
    })
    if (report.applied.length) {
      this.logger.info(`重载完成：applied=${report.applied.join(',')} changed=${report.changed_count}`)
    }
    return reply(report)
  }

  /* ---------------- 状态 ---------------- */

  async handleStatus(input, runConfig) {
    const session = runConfig && runConfig.configurable && runConfig.configurable.session
    const denied = this.guard(session, 'alison_self_status')
    if (denied) return denied

    const cfgStat = statOf(this.paths.configPath)
    const presetStat = statOf(this.paths.presetPath)
    const pending = this.pendingHelper()
    const boot = readJson(this.paths.bootFile)
    return reply({
      ok: true,
      at: nowIso(),
      pid: process.pid,
      uptime_seconds: Math.round(process.uptime()),
      started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      node: process.version,
      loaded_plugins: this.countLoadedPlugins(),
      config: {
        path: this.paths.configPath,
        exists: cfgStat.exists,
        size: cfgStat.size,
        mtime: cfgStat.mtime,
        hash: hashFile(this.paths.configPath),
      },
      preset: {
        path: this.paths.presetPath,
        exists: presetStat.exists,
        size: presetStat.size,
        mtime: presetStat.mtime,
        hash: hashFile(this.paths.presetPath),
      },
      server: {
        port: this.config.serverPort,
        listening: await portOpen(this.config.serverPort),
      },
      restart_engine: {
        mode_configured: String(this.config.restartMode || 'auto'),
        mode_would_use: this.resolveMode(null),
        can_self_restart: this.canSelfRestart(),
        has_ipc: typeof process.send === 'function',
        koi: this.paths.koiPath,
        koi_exists: fs.existsSync(this.paths.koiPath),
        launcher: this.paths.launcherScript,
        launcher_exists: fs.existsSync(this.paths.launcherScript),
        legacy: this.paths.legacyRestartScript,
        legacy_exists: fs.existsSync(this.paths.legacyRestartScript),
        instance: this.config.instanceName,
        allow_hard_kill_fallback: !!this.config.allowHardKillFallback,
      },
      pending_helper: pending ? { token: pending.data && pending.data.token, at: pending.data && pending.data.at, started_seconds_ago: pending.ageSeconds } : null,
      boot,
      last_restart: readJson(this.paths.lastRestartFile),
      last_reload: readJson(this.paths.lastReloadFile),
      helper_log: path.join(this.paths.dataDir, 'restart-helper.log'),
    })
  }
}

function statOf(file) {
  try {
    const s = fs.statSync(file)
    return { exists: true, size: s.size, mtime: s.mtime.toISOString() }
  } catch {
    return { exists: false, size: null, mtime: null }
  }
}

function safeMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const TOOL_META = {
  source: 'extension',
  group: 'alison-hotreload',
  tags: ['ice', 'self', 'restart', 'reload', 'admin'],
  defaultAvailability: {
    enabled: true,
    main: true,
    subAgent: false,
    chatluna: true,
    characterScope: 'owner',
  },
}

const RESTART_DESCRIPTION = [
  '预约一次「自己重启自己」：改完 koishi.yml 或装好新依赖后用它让改动生效。',
  '调用后**先**把要说的话正常回复出去，延迟到了才重启（默认 12 秒，可调），所以不会打断这轮对话。',
  '默认走进程内自重启（先 dispose，再让 loader 请求 fullReload，退出码 51 由 koishi start 原地重开一个 worker）——最快、不断启动器；',
  '同时会起一个脱离进程树的助手在旁边盯着：万一自重启没生效或没起来，它会自动升级到启动器重启 / 启动脚本兜底。',
  '重启前会校验 koishi.yml / Alison.yml，配置有语法错误就拒绝重启（避免再也起不来）。',
  '只有管理员能用；别人调用会被拒绝。不要在没改任何东西的时候反复重启。',
].join(' ')

const RELOAD_DESCRIPTION = [
  '不重启、不断线地**热重载配置**：把 koishi.yml 的改动在进程内应用（和官方 hmr 插件同一条路）。',
  'target=config（默认）重载 koishi.yml；target=preset 重新读角色预设 Alison.yml；target=all 两个都做。',
  'dry_run=true 只做校验和差异对比（会告诉你改了哪些键路径），不动任何东西。',
  '只报告改动的**键路径**，不会回显任何配置值（配置文件里有密钥）。',
  '顶层字段（nickname / prefix 之类）和新增的插件依赖，进程内 reload 不会生效，那时要用 alison_restart。',
].join(' ')

const STATUS_DESCRIPTION = [
  '查看 Alison 自己的运行状态：进程号、运行时长、控制台端口是否在听、配置/预设文件的指纹与修改时间、',
  '上次重启和上次重载的结果、有没有重启在排队、重启引擎（koi.exe / 启动脚本）在不在。',
].join(' ')

class IceRestartTool extends StructuredTool {
  constructor(state) {
    super()
    this.state = state
    this.name = 'alison_restart'
    this.description = RESTART_DESCRIPTION
    this.schema = z.object({
      delay: z.string().optional().describe('多久之后重启：秒数或 15s / 2m / 1h，默认 12 秒'),
      reason: z.string().optional().describe('为什么重启（一句话，会记进日志）'),
      mode: z.enum(['auto', 'app', 'launcher', 'legacy']).optional().describe('重启方式，一般不用填。auto（默认）= 进程内自重启，失败由助手升级到启动器'),
      skip_validate: z.boolean().optional().describe('配置校验失败也强行重启（危险，默认 false）'),
    })
  }

  async _call(input, _runManager, runConfig) {
    return this.state.handleRestart(input || {}, runConfig)
  }
}

class IceReloadTool extends StructuredTool {
  constructor(state) {
    super()
    this.state = state
    this.name = 'alison_reload'
    this.description = RELOAD_DESCRIPTION
    this.schema = z.object({
      target: z.enum(['config', 'preset', 'all']).optional().describe('重载什么，默认 config（koishi.yml）'),
      dry_run: z.boolean().optional().describe('只校验 + 对比差异，不真的改'),
    })
  }

  async _call(input, _runManager, runConfig) {
    return this.state.handleReload(input || {}, runConfig)
  }
}

class IceSelfStatusTool extends StructuredTool {
  constructor(state) {
    super()
    this.state = state
    this.name = 'alison_self_status'
    this.description = STATUS_DESCRIPTION
    this.schema = z.object({
      limit: z.number().optional().describe('保留参数，暂时没用'),
    })
  }

  async _call(input, _runManager, runConfig) {
    return this.state.handleStatus(input || {}, runConfig)
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

function apply(ctx, config) {
  const logger = ctx.logger('alison-hotreload')
  let state
  try {
    state = new State(ctx, config)
  } catch (err) {
    logger.error(`初始化失败：${err && err.message ? err.message : err}`)
    return
  }

  // 记一笔启动时间：下次看 status 就知道「上次重启是不是真的回来了」
  // 同时把「能不能进程内自重启」的判断依据一起落盘，方便事后核对
  writeJson(state.paths.bootFile, {
    at: nowIso(),
    pid: process.pid,
    hasIpc: typeof process.send === 'function',
    koishiShared: !!process.env.KOISHI_SHARED,
    canSelfRestart: state.canSelfRestart(),
    koishiAgent: process.env.KOISHI_AGENT || null,
    previous: readJson(state.paths.intentFile),
  })

  ctx.inject(['chatluna'], (chatCtx) => {
    const platform = chatCtx.chatluna && chatCtx.chatluna.platform
    if (!platform || typeof platform.registerTool !== 'function') {
      logger.warn('chatluna.platform.registerTool 不可用，自我管理工具没有注册。')
      return
    }
    const toolClasses = [IceRestartTool, IceReloadTool, IceSelfStatusTool]
    const registered = []
    for (const Klass of toolClasses) {
      const probe = new Klass(state)
      registered.push(probe.name)
      chatCtx.effect(() =>
        platform.registerTool(probe.name, {
          name: probe.name,
          description: probe.description,
          // 对非管理员直接隐藏：模型连看都看不到这几个工具
          authorization: (session) => state.isOwner(session),
          selector: () => true,
          createTool: () => new Klass(state),
          meta: TOOL_META,
        }),
      )
    }
    logger.info(`已注册工具：${registered.join(', ')}（仅管理员可见）`)
  })

  try {
    if (typeof ctx.command === 'function') {
      ctx
        .command('alison.self.restart [delay] [reason:text]', '让 Alison 自己重启（先回复完再重启）', { authority: 4 })
        .alias('自重启')
        .action(async ({ session }, delay, reason) =>
          state.handleRestart({ delay, reason }, { configurable: { session } }))

      ctx
        .command('alison.self.reload [target]', '热重载配置（config / preset / all）', { authority: 4 })
        .alias('重载配置')
        .action(async ({ session }, target) =>
          state.handleReload({ target: target || 'config' }, { configurable: { session } }))

      ctx
        .command('alison.self.status', '查看 Alison 自己的运行状态', { authority: 3 })
        .alias('自我状态')
        .action(async ({ session }) => state.handleStatus({}, { configurable: { session } }))

      ctx
        .command('alison.self.plan', '看看当前配置和磁盘上的差异（不落盘）', { authority: 3 })
        .action(async ({ session }) => state.handleReload({ target: 'all', dry_run: true }, { configurable: { session } }))
    }
  } catch (err) {
    logger.warn(`管理命令注册失败（不影响工具）：${err && err.message ? err.message : err}`)
  }
}

module.exports = { name, usage, inject, Config, apply }
module.exports.default = module.exports
// 供离线自测使用（Koishi 本体不会读这些）
module.exports.__internals = {
  State,
  parseDelay,
  clamp,
  diffConfig,
  hashValue,
  redact,
  statOf,
  nowIso,
}
