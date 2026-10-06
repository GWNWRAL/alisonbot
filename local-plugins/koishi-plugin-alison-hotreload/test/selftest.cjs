'use strict'

/**
 * alison-hotreload 离线自测 —— 不需要启动 Koishi。
 *
 *   node D:\Alison\koishi\instance\local-plugins\koishi-plugin-alison-hotreload\test\selftest.cjs
 *
 * 覆盖：
 *   1. delay 解析 / 夹取
 *   2. 配置差异：只报键路径，绝不返回值（密钥不进聊天记录）
 *   3. 输出脱敏（sk-… 一律变成 sk-***）
 *   4. 插件模块导出形状（name / inject / Config / apply）
 *   5. 助手脚本的接线：跑一次「注定失败」的重启，确认它会写日志与 last-restart.json，
 *      并且**不会**误报成功
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const pluginDir = path.resolve(__dirname, '..')
const instanceDir = path.resolve(pluginDir, '..', '..')
const { __internals, name, inject, Config, apply } = require(path.join(pluginDir, 'lib', 'index.js'))
const { parseDelay, clamp, diffConfig, redact, State } = __internals

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}\n       期望 ${b}\n       实际 ${a}`)
  }
}

function ok(label, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok   ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`)
  }
}

console.log('\n[1] parseDelay / clamp')
check('数字', parseDelay(30, 12), 30)
check('"20"', parseDelay('20', 12), 20)
check('"20s"', parseDelay('20s', 12), 20)
check('"2m"', parseDelay('2m', 12), 120)
check('"1h"', parseDelay('1h', 12), 3600)
check('"90 秒"', parseDelay('90 秒', 12), 90)
check('"3分钟"', parseDelay('3分钟', 12), 180)
check('空 → 兜底', parseDelay('', 12), 12)
check('乱七八糟 → 兜底', parseDelay('等会儿', 12), 12)
check('undefined → 兜底', parseDelay(undefined, 7), 7)
check('clamp 下限', clamp(1, 3, 600), 3)
check('clamp 上限', clamp(99999, 3, 600), 600)
check('clamp 非数字', clamp('abc', 3, 600), 3)

console.log('\n[2] diffConfig：只报键路径，不返回值')
const before = {
  nickname: ['Alison'],
  plugins: {
    server: { port: 5140 },
    group: { iceout: { 'alison-outreach:iceout1': { enabled: true, minIntervalSeconds: 30 } } },
  },
}
const after = {
  nickname: ['Alison', '冰'],
  plugins: {
    server: { port: 5140, host: '127.0.0.1' },
    group: { iceout: { 'alison-outreach:iceout1': { enabled: true, minIntervalSeconds: 60 } }, 'foo:bar1': {} },
  },
}
const diff = diffConfig(before, after, 100)
const paths = diff.map((d) => `${d.kind}:${d.path}`).sort()
check('改动键路径', paths, [
  'added:plugins.group.foo:bar1',
  'added:plugins.server.host',
  'changed:nickname',
  'changed:plugins.group.iceout.alison-outreach:iceout1.minIntervalSeconds',
])
const serialized = JSON.stringify(diff)
ok('没有泄露任何配置值', !serialized.includes('60') && !serialized.includes('127.0.0.1') && !serialized.includes('冰'),
  `diff = ${serialized}`)
check('无差异', diffConfig(before, before, 100), [])

console.log('\n[3] redact 脱敏')
const secret = 'key is REPLACE_ME ok'
ok('sk- 被抹掉', !redact(secret).includes('458af2d5e7d5444d8d2cc33755e6a607'), redact(secret))
ok('token 被抹掉', !redact('token: abcdefghijklmnop').includes('abcdefghijklmnop'), redact('token: abcdefghijklmnop'))
check('普通文本不动', redact('端口 5140 正常'), '端口 5140 正常')

console.log('\n[4] 模块形状')
check('name', name, 'alison-hotreload')
ok('inject 里 chatluna 是可选的（chatluna 坏了也要能自愈）', Array.isArray(inject.optional) && inject.optional.includes('chatluna'), JSON.stringify(inject))
ok('Config 存在', !!Config)
ok('apply 是函数', typeof apply === 'function')
ok('ownerIds 默认是空表（靠配置填）', JSON.stringify(Config({}).ownerIds) === '[]', JSON.stringify(Config({}).ownerIds))
check('requireOwner 默认 true', Config({}).requireOwner, true)
check('端口默认 5140', Config({}).serverPort, 5140)
check('延迟默认 12s', Config({}).defaultDelaySeconds, 12)
ok('allowHardKillFallback 默认 false', Config({}).allowHardKillFallback === false)

console.log('\n[5] State.userIdOf')
check('userId', State.userIdOf({ userId: 12345 }), '12345')
check('author.id', State.userIdOf({ author: { id: 'abc' } }), 'abc')
check('event.user.id', State.userIdOf({ event: { user: { id: 999 } } }), '999')
check('空', State.userIdOf({}), null)
check('null', State.userIdOf(null), null)

console.log('\n[5b] 重启方式的选择（resolveMode / canSelfRestart）')
function makeState(config) {
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const ctx = {
    baseDir: instanceDir,
    loader: { filename: path.join(instanceDir, 'koishi.yml'), config: {}, entry: null, fullReload() {} },
    logger: () => logger,
    root: { scope: { update() {} }, emit() {}, stop() {} },
  }
  return new State(ctx, Config(Object.assign({ ownerIds: ['1'] }, config || {})))
}

// 普通 node 进程没有 IPC channel，process.send 不存在 —— 正是「不在 koishi start 底下」的样子
const hadSend = typeof process.send === 'function'
if (!hadSend) {
  check('没有 IPC → canSelfRestart=false', makeState().canSelfRestart(), false)
  check('auto 且不能自重启 → 交给启动器', makeState().resolveMode(null), 'launcher')
  check('auto 且不能自重启（显式 auto）→ 交给启动器', makeState().resolveMode('auto'), 'launcher')
  // 有 IPC 但没有 KOISHI_SHARED：正是 koi.exe 直接起的那个进程，fullReload 会静默失败
  process.send = () => {}
  check('有 IPC 但没有 KOISHI_SHARED → 仍不敢自重启', makeState().canSelfRestart(), false)
  check(' → 仍然交给启动器', makeState().resolveMode(null), 'launcher')
  // 假装自己就是 koishi start 重新 fork 出来的 worker
  process.env.KOISHI_SHARED = JSON.stringify({ startTime: Date.now() })
  check('有 IPC + KOISHI_SHARED → canSelfRestart=true', makeState().canSelfRestart(), true)
  check('auto 且能自重启 → 进程内自重启', makeState().resolveMode(null), 'app')
  // 缺 fullReload 也不行
  const broken = makeState()
  broken.ctx.loader.fullReload = undefined
  check('没有 fullReload → false', broken.canSelfRestart(), false)
  delete process.send
  delete process.env.KOISHI_SHARED
} else {
  ok('本进程带 IPC，跳过「没有 IPC」的分支', true)
}
check('显式 mode=launcher 不被改写', makeState().resolveMode('launcher'), 'launcher')
check('显式 mode=app 不被改写', makeState().resolveMode('app'), 'app')
check('显式 mode=legacy 不被改写', makeState().resolveMode('legacy'), 'legacy')
check('配置写死 legacy → legacy', makeState({ restartMode: 'legacy' }).resolveMode(null), 'legacy')
check('配置写死 launcher → launcher', makeState({ restartMode: 'launcher' }).resolveMode(null), 'launcher')

console.log('\n[6] 助手脚本接线（注定失败的一次重启，必须诚实报告失败）')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alison-hotreload-selftest-'))
const token = 'selftest'
const helper = path.join(pluginDir, 'lib', 'restart-helper.js')
const res = spawnSync(process.execPath, [
  helper,
  '--delay', '0',
  '--port', '59999',            // 没人听
  '--instance', 'default',
  '--koi', '',                  // 没有启动器
  '--launcher', '',             // 没有兜底脚本
  '--legacy', '',
  '--dir', tmpDir,
  '--token', token,
  '--wait-back', '10',
  '--mode', 'launcher',
  '--allow-hard-kill', '0',
], { encoding: 'utf8', timeout: 60000 })

ok('助手退出码非 0（诚实报告）', res.status !== 0, `status=${res.status} stderr=${res.stderr}`)
const lastFile = path.join(tmpDir, 'last-restart.json')
ok('写了 last-restart.json', fs.existsSync(lastFile))
if (fs.existsSync(lastFile)) {
  const last = JSON.parse(fs.readFileSync(lastFile, 'utf8'))
  check('ok = false', last.ok, false)
  ok('带上了 notes 说明', Array.isArray(last.notes) && last.notes.length > 0, JSON.stringify(last.notes))
  check('token 对上', last.token, token)
}
const logFile = path.join(tmpDir, 'restart-helper.log')
ok('写了 restart-helper.log', fs.existsSync(logFile))
if (fs.existsSync(logFile)) {
  const log = fs.readFileSync(logFile, 'utf8')
  ok('日志里有「助手已就绪」', log.includes('助手已就绪'), log.slice(0, 400))
  ok('日志里有结束行', log.includes('结束：ok=false'), log.slice(-300))
}
ok('ready 文件已清理', !fs.existsSync(path.join(tmpDir, `helper-${token}.json`)))

console.log('\n[7] 助手 mode=app：判断不了自重启时要如实升级，而不是假报成功')
const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'alison-hotreload-selftest-app-'))
const res2 = spawnSync(process.execPath, [
  helper,
  '--delay', '0',
  '--port', '59999',
  '--instance', 'default',
  '--koi', '',
  '--launcher', '',
  '--legacy', '',
  '--dir', tmpDir2,
  '--token', 'selftest-app',
  '--wait-back', '10',
  '--mode', 'app',
  '--allow-hard-kill', '0',
], { encoding: 'utf8', timeout: 60000 })

ok('mode=app 也诚实报失败', res2.status !== 0, `status=${res2.status}`)
const lastFile2 = path.join(tmpDir2, 'last-restart.json')
if (fs.existsSync(lastFile2)) {
  const last2 = JSON.parse(fs.readFileSync(lastFile2, 'utf8'))
  check('mode 记为 app', last2.mode, 'app')
  check('ok = false', last2.ok, false)
  ok('notes 里说明了「判断不了自重启」', JSON.stringify(last2.notes).includes('判断不了'), JSON.stringify(last2.notes))
} else {
  failed++
  console.log('  FAIL 没有写 last-restart.json（mode=app）')
}
try { fs.rmSync(tmpDir2, { recursive: true, force: true }) } catch {}

try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`)
process.exit(failed ? 1 : 0)
