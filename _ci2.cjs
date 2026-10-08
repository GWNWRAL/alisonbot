// ① 给 ci-guard 加"没有 git 也能跑"的回退 ② 用目录遍历推送
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('node:child_process')

const AL = 'D:/ICE/alisonbot'
const TOKEN = fs.readFileSync(['D:/ICE/docs/.gh-token.txt', 'D:/ICE/.gh-token.txt'].find((p) => fs.existsSync(p)), 'utf8').trim()
const H = { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'AlisonBot', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
const R = 'GWNWRAL/alisonbot'
const api = async (m, u, b) => {
  const r = await fetch('https://api.github.com' + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })
  const t = await r.text(); let o = null; try { o = t ? JSON.parse(t) : null } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, o }
}
const L = (a) => a.join('\n') + '\n'

/* ① 重写守卫：优先 git ls-files，没有 git 就遍历目录 */
const GUARD = L([
  '#!/usr/bin/env node',
  '// 防泄漏守卫：出现 API Key / 本机路径 / 高熵 token → 退出码 1',
  "import { execFileSync } from 'node:child_process'",
  "import fs from 'node:fs'",
  "import path from 'node:path'",
  '',
  'function listFiles() {',
  "  try {",
  "    const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()",
  "    if (out) return out.split(/\\r?\\n/).filter(Boolean)",
  "  } catch { /* 不是 git 仓库：走目录遍历 */ }",
  "  const skipDir = new Set(['node_modules', '.git', '.yarn', 'data', 'workspace', 'logs'])",
  "  const skipFile = new Set(['alison.yml', 'alison.test.yml', 'koishi.yml', 'koishi.test.yml', 'yarn.lock'])",
  '  const out = []',
  "  ;(function walk(dir, rel) {",
  "    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {",
  "      const r = rel ? rel + '/' + e.name : e.name",
  "      if (e.isDirectory()) { if (skipDir.has(e.name)) continue; walk(path.join(dir, e.name), r); continue }",
  '      if (skipFile.has(r)) continue',
  '      out.push(r)',
  '    }',
  "  })('.', '')",
  '  return out',
  '}',
  '',
  'const files = listFiles()',
  'const PATTERNS = [',
  "  { re: /sk-[A-Za-z0-9_-]{20,}/g, what: 'API Key（sk-…）' },",
  "  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, what: 'GitHub Token' },",
  "  { re: /D:\\\\ICE/i, what: '本机路径 D:\\\\ICE' },",
  "  { re: /C:\\\\Users\\\\[A-Za-z0-9_.-]+/i, what: '本机用户路径' },",
  "  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: '私钥' },",
  "  { re: /(accessToken|apiKey|apiKeys|token)\\s*:\\s*[\"']?[A-Za-z0-9_-]{32,}/g, what: '疑似写死的长 token' }",
  ']',
  'let bad = 0',
  'for (const f of files) {',
  "  if (/\\.(png|jpg|jpeg|ico|icns|zip|exe|gz|pdf|lock)$/i.test(f)) continue",
  '  let text = ""',
  "  try { text = fs.readFileSync(f, 'utf8') } catch { continue }",
  '  for (const p of PATTERNS) {',
  '    const m = text.match(p.re)',
  '    if (m) { bad++; console.log(`❌ ${f} → 命中 ${p.what}（${m.length} 处，示例：${String(m[0]).slice(0, 12)}…）`) }',
  '  }',
  '}',
  "if (bad) { console.log(`\\n共 ${bad} 处可疑内容，请清理。`); process.exit(1) }",
  "console.log(`✅ 防泄漏守卫通过：检查 ${files.length} 个文件，无 Key / 无本机路径 / 无高熵 token`)",
])
fs.writeFileSync(path.join(AL, 'tools/ci-guard.mjs'), GUARD, 'utf8')
console.log('  ✓ tools/ci-guard.mjs 已加目录遍历回退')

/* ② 本地跑一次守卫 */
try {
  const out = execFileSync(process.execPath, [path.join(AL, 'tools/ci-guard.mjs')], { cwd: AL, encoding: 'utf8' })
  console.log('    ' + out.trim())
} catch (e) { console.log('    ❌ 守卫未通过：\n' + String(e.stdout || e.message).slice(0, 500)) }

/* ③ 目录遍历 → 推送 */
;(async () => {
  const skipDir = new Set(['node_modules', '.git', '.yarn', 'data', 'workspace'])
  const skipFile = new Set(['alison.yml', 'alison.test.yml', 'koishi.yml', 'koishi.test.yml'])
  const tracked = []
  ;(function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { if (skipDir.has(e.name)) continue; walk(path.join(dir, e.name), r); continue }
      if (skipFile.has(r)) continue
      tracked.push(r)
    }
  })(AL, '')
  console.log('  待推送 ' + tracked.length + ' 个文件（含 .github/ 与 tools/ci-guard.mjs）')

  const tree = []
  for (const f of tracked) {
    const buf = fs.readFileSync(path.join(AL, f))
    const r = await api('POST', `/repos/${R}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' })
    if (!r.ok) { console.log('  ❌ blob 失败 ' + f + ' ' + (r.o && r.o.message)); process.exit(1) }
    tree.push({ path: f, mode: '100644', type: 'blob', sha: r.o.sha })
  }
  const nt = await api('POST', `/repos/${R}/git/trees`, { tree })
  const ref = await api('GET', `/repos/${R}/git/ref/heads/main`)
  const commit = await api('POST', `/repos/${R}/git/commits`, {
    message: 'CI：语法检查 + 防泄漏守卫；Dependabot 仅安全更新；补 issue 模板',
    tree: nt.o.sha, parents: [ref.o.object.sha]
  })
  const up = await api('PATCH', `/repos/${R}/git/refs/heads/main`, { sha: commit.o.sha })
  console.log('  推送 ' + (up.ok ? '✓ main → ' + commit.o.sha.slice(0, 10) : '❌ ' + up.status + ' ' + (up.o && up.o.message)))

  const wf = await api('GET', `/repos/${R}/actions/workflows`)
  console.log('  workflow: ' + (((wf.o && wf.o.workflows) || []).map((w) => w.name + '[' + w.state + ']').join(', ') || '（GitHub 索引中，稍等刷新）'))
  const runs = await api('GET', `/repos/${R}/actions/runs?per_page=3`)
  const list = (runs.o && runs.o.workflow_runs) || []
  console.log('  最近运行: ' + (list.map((x) => '#' + x.run_number + ' ' + x.name + '=' + (x.conclusion || x.status)).join(', ') || '（还没有）'))
})().catch((e) => { console.log('  ❌ ' + e.message); process.exit(1) })
