'use strict'

/**
 * 端到端自测：**真的会重启 Koishi**（Alison 自己）。
 *
 *   node test/e2e-restart.cjs --yes --delay 5 [--reason "..."] [--owner 1000000001]
 *
 * 它做的事和 Alison 调 alison_restart 完全一样：
 *   - 用一个假的 ctx 把插件里的 State 直接 new 出来（不需要启动第二个 Koishi）；
 *   - 先确认非管理员会被拒绝（权限闸门有效）；
 *   - 再以管理员身份排一次重启，然后自己退出，剩下的交给 detached 助手。
 *
 * 跑完之后看：
 *   - 控制台端口有没有断过再回来（`netstat -ano | findstr ":5140 "` 的 PID 变没变）
 *   - `instance/data/alison-hotreload/last-restart.json` 里的 ok / path
 *   - `instance/data/alison-hotreload/restart-helper.log`
 */

const fs = require('node:fs')
const path = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const pluginDir = path.resolve(__dirname, '..')
const instanceDir = path.resolve(pluginDir, '..', '..')

if (!args.yes) {
  console.error('这会真的重启 Koishi（Alison 会断线几秒）。确认要跑就加 --yes。')
  process.exit(2)
}

const { __internals, Config } = require(path.join(pluginDir, 'lib', 'index.js'))
const { State } = __internals

const owner = String(args.owner || '1000000001')
const delay = String(args.delay || '5')
const reason = String(args.reason || 'alison-hotreload 端到端自测')

const logs = []
const logger = {
  info: (m) => { logs.push(`[I] ${m}`); console.log(`[I] ${m}`) },
  warn: (m) => { logs.push(`[W] ${m}`); console.log(`[W] ${m}`) },
  error: (m) => { logs.push(`[E] ${m}`); console.log(`[E] ${m}`) },
  debug: () => {},
}

const ctx = {
  baseDir: instanceDir,
  loader: { filename: path.join(instanceDir, 'koishi.yml'), config: null, entry: null },
  logger: () => logger,
  root: { scope: { update() {} }, emit() {} },
}

async function main() {
  const config = Config({ ownerIds: [owner], defaultDelaySeconds: 12 })
  const state = new State(ctx, config)

  console.log(`实例目录：${instanceDir}`)
  console.log(`配置文件：${state.paths.configPath}`)
  console.log(`助手脚本：${state.paths.helperScript}`)
  console.log(`启动器  ：${state.paths.koiPath}（存在：${fs.existsSync(state.paths.koiPath)}）`)
  console.log(`启动脚本：${state.paths.launcherScript}（存在：${fs.existsSync(state.paths.launcherScript)}）`)

  // ① 权限闸门：陌生人必须被拒
  const stranger = JSON.parse(await state.handleRestart({ delay: '60' }, { configurable: { session: { userId: '10000' } } }))
  if (stranger.ok !== false || stranger.error !== 'forbidden') {
    console.error('权限闸门失效了：非管理员竟然能排重启 →', stranger)
    process.exit(1)
  }
  console.log('权限闸门 ok：非管理员被拒绝，且没有排期。')

  // ② 管理员：真的排一次
  const result = JSON.parse(await state.handleRestart(
    { delay, reason },
    { configurable: { session: { userId: owner } } },
  ))
  console.log('排期结果：', JSON.stringify(result, null, 2))
  if (!result.ok) {
    console.error('排期失败，什么都没发生。')
    process.exit(1)
  }
  console.log(`\n已排期：约 ${result.delay_seconds}s 后由启动器重启（助手 pid ${result.helper_pid}）。`)
  console.log(`看进度：Get-Content -Wait "${path.join(state.paths.dataDir, 'restart-helper.log')}"`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
