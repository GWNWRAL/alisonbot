#!/usr/bin/env node
'use strict'

/**
 * restart-helper.js —— Alison 自重启的「脱离进程树」助手
 *
 * 由 koishi-plugin-alison-hotreload 用 detached 方式拉起。它有两个身份：
 *   - **mode=app**：插件已经自己在进程里请求了 fullReload（退出码 51，koishi start 原地重开 worker），
 *     助手只负责**盯着**：端口有没有断过、有没有回来；没断过或没回来就自动升级。
 *   - **mode=launcher / legacy**：助手自己动手，让启动器（koi restart）或旧脚本重启实例。
 *
 * 升级阶梯（每一步失败才走下一步）：
 *   app（自重启）→ launcher（koi restart）→ legacy（强杀脚本，需显式允许）→ launcher-script（启动脚本兜底）
 *
 * 为什么必须独立进程：
 *   Alison 跑在 Koishi 里面，实例被停掉时它自己也死了，没法在「之后」做任何事。
 *
 * 为什么用启动器而不是 taskkill：
 *   `koish.db` 是 SQLite，强杀进程有小概率损坏。
 *   `koi restart <instance>` 走的是托盘菜单「重启」同一条路：优雅停 + 再拉起。
 *
 * 只依赖 Node 内置模块，故意不 require 任何东西 —— 它必须在 Koishi 挂了的时候也能跑。
 *
 * 用法（一般不用手敲）：
 *   node restart-helper.js --delay 12 --port 5140 --instance default \
 *     --koi "C:\Program Files\Koishi\Desktop\koi.exe" \
 *     --launcher "D:\Alison\koishi\tools\启动Alison.cmd" \
 *     --legacy "D:\Alison\koishi\tools\restart-koishi.cmd" \
 *     --dir "D:\Alison\koishi\instance\data\alison-hotreload" --token ab12cd34 \
 *     --wait-back 120 --mode auto --intent "…\intent.json" --allow-hard-kill 0
 *
 * --mode：app / launcher / legacy / auto（auto 由助手当成 launcher 处理）
 */

const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i++
    }
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))
const options = {
  delay: Math.max(0, Number(argv.delay) || 0),
  port: Number(argv.port) || 5140,
  instance: String(argv.instance || 'default'),
  koi: String(argv.koi || ''),
  launcher: String(argv.launcher || ''),
  legacy: String(argv.legacy || ''),
  dir: String(argv.dir || process.cwd()),
  token: String(argv.token || 'nokey'),
  waitBack: Math.max(10, Number(argv['wait-back']) || 120),
  mode: String(argv.mode || 'auto'),
  intent: String(argv.intent || ''),
  allowHardKill: String(argv['allow-hard-kill'] || '0') === '1',
}

/* ------------------------------------------------------------------ *
 * 基础设施
 * ------------------------------------------------------------------ */

const logFile = path.join(options.dir, 'restart-helper.log')
const lastFile = path.join(options.dir, 'last-restart.json')

function log(message) {
  const line = `[${new Date().toISOString()}] [${options.token}] ${message}\n`
  try {
    fs.mkdirSync(options.dir, { recursive: true })
    fs.appendFileSync(logFile, line, 'utf8')
  } catch {}
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 万一被 CTRL_C 波及，也别死：我们的活儿就是在实例死掉之后接着干
for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
  try {
    process.on(signal, () => log(`收到 ${signal}，忽略（助手要继续做重启）`))
  } catch {}
}

/** 一次 TCP 连接判断端口在不在听。 */
function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      resolve(value)
    }
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeout)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

async function waitUntilDown(port, seconds, label) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) {
      log(`${label}：实例已经停了（端口 ${port} 不再监听）`)
      return true
    }
    await sleep(1000)
  }
  log(`${label}：${seconds}s 内端口 ${port} 一直在听，没看到它停`)
  return false
}

async function waitUntilUp(port, seconds, label) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (await portOpen(port)) {
      log(`${label}：实例回来了（端口 ${port} 已监听）`)
      return true
    }
    await sleep(2000)
  }
  log(`${label}：等了 ${seconds}s，端口 ${port} 还是没起来`)
  return false
}

/** 跑一条命令并等它结束（用于 koi restart）。 */
function runAndWait(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let child
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: 'ignore' })
    } catch (err) {
      return finish({ ok: false, error: String((err && err.message) || err) })
    }
    const timer = setTimeout(() => {
      log(`${cmd} 超时（${Math.round(timeoutMs / 1000)}s），放弃等它`)
      try { child.kill() } catch {}
      finish({ ok: false, error: 'timeout', code: null })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: String((err && err.message) || err) })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      finish({ ok: code === 0, code, signal })
    })
  })
}

/** 起一条完全脱离的进程（兜底脚本用）。 */
function startDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return true
  } catch (err) {
    log(`起进程失败 ${cmd}：${String((err && err.message) || err)}`)
    return false
  }
}

function runLauncherScript(label) {
  if (!options.launcher || !fs.existsSync(options.launcher)) {
    log(`${label}：找不到启动脚本 ${options.launcher || '(未配置)'}`)
    return false
  }
  log(`${label}：跑启动脚本 ${options.launcher}`)
  return startDetached('cmd.exe', ['/c', 'start', '', '/min', options.launcher])
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now()
  const readyFile = path.join(options.dir, `helper-${options.token}.json`)

  // ① 先握手：插件要靠这个文件确认「排期真的生效了」
  writeJson(readyFile, {
    pid: process.pid,
    startedAt: new Date(startedAt).toISOString(),
    delaySeconds: options.delay,
    mode: options.mode,
    instance: options.instance,
    port: options.port,
  })
  log(`助手已就绪 pid=${process.pid} delay=${options.delay}s mode=${options.mode} instance=${options.instance}`)

  // ② 等，让 Alison 把当前这轮回复发出去
  if (options.delay > 0) await sleep(options.delay * 1000)

  const result = {
    token: options.token,
    at: new Date().toISOString(),
    delaySeconds: options.delay,
    mode: options.mode,
    instance: options.instance,
    port: options.port,
    endedAt: null,
    ok: false,
    path: null,
    notes: [],
  }

  const aliveAtStart = await portOpen(options.port)
  const koiExists = !!options.koi && fs.existsSync(options.koi)
  let observedDown = false

  const escalateNotes = []

  // ③ 台阶一（mode=app）：插件已经自己在进程里调了 loader.fullReload()，
  //    退出码 51 会让 koi 里那层 `koishi start` 原地重新 fork 一个 worker。
  //    我们在这里只做一件事：盯着端口，看它有没有真的断过、又有没有回来。
  if (options.mode === 'app') {
    if (!aliveAtStart) {
      escalateNotes.push('开始盯梢时实例就没在监听 —— 判断不了自重启有没有发生，直接交给后面的台阶。')
      log(escalateNotes[escalateNotes.length - 1])
    } else {
      log('等着看实例有没有自己退出（进程内自重启，退出码 51）')
      // worker 重新 fork 只要一两秒；30 秒还没动静就说明这条路人根本没走通
      observedDown = await waitUntilDown(options.port, 30, '进程内自重启')
      if (!observedDown) {
        escalateNotes.push('等了 30 秒实例都没停过：进程内自重启没有生效，改用启动器重启。')
        log(escalateNotes[escalateNotes.length - 1])
      } else if (await waitUntilUp(options.port, Math.min(options.waitBack, 45), '进程内自重启')) {
        result.ok = true
        result.path = 'app'
      } else {
        escalateNotes.push('实例退出了但一直没回来：升级到启动器重启。')
        log(escalateNotes[escalateNotes.length - 1])
      }
    }
  }

  // ④ 台阶二：让启动器优雅重启实例（koi restart = 托盘「重启」同一条路）
  const wantLauncher = !result.ok && (options.mode === 'app' || options.mode === 'auto' || options.mode === 'launcher')
  if (wantLauncher) {
    if (!koiExists) {
      result.notes.push(`找不到启动器 ${options.koi || '(未配置)'}，跳过启动器重启`)
      log(result.notes[result.notes.length - 1])
    } else {
      const koiResult = await runAndWait(options.koi, ['restart', options.instance], 120000)
      log(`koi restart ${options.instance} → ${JSON.stringify(koiResult)}`)
      result.launcherExit = koiResult

      const down = observedDown || (await waitUntilDown(options.port, 30, '启动器重启'))
      observedDown = observedDown || down
      if (down && (await waitUntilUp(options.port, options.waitBack, '启动器重启'))) {
        result.ok = true
        result.path = 'launcher'
      } else if (!down) {
        result.notes.push('启动器这条路上实例一直没停过（端口一直在听）—— 重启多半没真的发生。')
      }
    }
  }

  // ⑤ 台阶三：旧的重启脚本（强杀 + 拉起）。只有显式要求、或开着 allowHardKill 时才用
  const wantLegacy = !result.ok && (options.mode === 'legacy'
    || (options.allowHardKill && !!options.legacy && fs.existsSync(options.legacy)))
  if (wantLegacy) {
    log('退回旧的重启脚本（强杀 + 拉起）')
    result.notes.push('用了旧的重启脚本（强杀 node + 启动脚本），SQLite 有小概率风险。')
    startDetached('cmd.exe', ['/c', 'start', '', '/min', 'cmd', '/c', options.legacy, '5'])
    const down = observedDown || (await waitUntilDown(options.port, 25, '旧脚本重启'))
    observedDown = observedDown || down
    const up = await waitUntilUp(options.port, options.waitBack, '旧脚本重启')
    if (up && (down || !aliveAtStart)) {
      result.ok = true
      result.path = 'legacy-script'
    }
  }

  // ⑥ 台阶四：跑启动脚本。它自己会判断「已经在跑就跳过」，所以是幂等的 ——
  //    但也正因如此：如果实例从没停过，这里跑完端口当然是通的，那不算重启成功。
  if (!result.ok) {
    if (runLauncherScript('兜底')) {
      result.notes.push('跑了启动脚本兜底。')
      const up = await waitUntilUp(options.port, Math.max(90, options.waitBack), '兜底启动脚本')
      if (up && (observedDown || !aliveAtStart)) {
        result.ok = true
        result.path = 'launcher-script'
      } else if (up) {
        result.notes.push('实例本来就一直活着（端口没断过），启动脚本按「已在运行」跳过了：这次重启其实没发生。')
      }
    }
  }

  if (escalateNotes.length) result.notes.push(...escalateNotes)
  if (!result.ok && !observedDown && aliveAtStart) {
    result.notes.push('实例其实一直活着（端口一直在听），只是重启请求没生效。什么都没坏，可以稍后再试，或者让用户从托盘图标重启。')
  }

  result.endedAt = new Date().toISOString()
  result.elapsedMs = Date.now() - startedAt
  writeJson(lastFile, result)
  try { fs.unlinkSync(readyFile) } catch {}
  if (options.intent) {
    writeJson(options.intent, { ...(safeReadJson(options.intent) || {}), finishedAt: result.endedAt, ok: result.ok, path: result.path })
  }
  log(`结束：ok=${result.ok} path=${result.path} elapsed=${Math.round(result.elapsedMs / 1000)}s`)
  process.exit(result.ok ? 0 : 1)
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

main().catch((err) => {
  log(`助手崩了：${(err && err.stack) || err}`)
  writeJson(lastFile, { token: options.token, at: new Date().toISOString(), ok: false, error: String((err && err.message) || err) })
  process.exit(1)
})
