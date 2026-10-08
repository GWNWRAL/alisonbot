#!/usr/bin/env node
// 防泄漏守卫：出现 API Key / 本机路径 / 高熵 token → 退出码 1
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (out) return out.split(/\r?\n/).filter(Boolean)
  } catch { /* 不是 git 仓库：走目录遍历 */ }
  const skipDir = new Set(['node_modules', '.git', '.yarn', 'data', 'workspace', 'logs'])
  const skipFile = new Set(['alison.yml', 'alison.test.yml', 'koishi.yml', 'koishi.test.yml', 'yarn.lock'])
  const out = []
  ;(function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (e.isDirectory()) { if (skipDir.has(e.name)) continue; walk(path.join(dir, e.name), r); continue }
      if (skipFile.has(r)) continue
      out.push(r)
    }
  })('.', '')
  return out
}

const files = listFiles()
const PATTERNS = [
  { re: /sk-[A-Za-z0-9_-]{20,}/g, what: 'API Key（sk-…）' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, what: 'GitHub Token' },
  { re: /D:\\ICE/i, what: '本机路径 D:\\ICE' },
  { re: /C:\\Users\\[A-Za-z0-9_.-]+/i, what: '本机用户路径' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: '私钥' },
  { re: /(accessToken|apiKey|apiKeys|token)\s*:\s*["']?[A-Za-z0-9_-]{32,}/g, what: '疑似写死的长 token' }
]
let bad = 0
for (const f of files) {
  if (/\.(png|jpg|jpeg|ico|icns|zip|exe|gz|pdf|lock)$/i.test(f)) continue
  let text = ""
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  for (const p of PATTERNS) {
    const m = text.match(p.re)
    if (m) { bad++; console.log(`❌ ${f} → 命中 ${p.what}（${m.length} 处，示例：${String(m[0]).slice(0, 12)}…）`) }
  }
}
if (bad) { console.log(`\n共 ${bad} 处可疑内容，请清理。`); process.exit(1) }
console.log(`✅ 防泄漏守卫通过：检查 ${files.length} 个文件，无 Key / 无本机路径 / 无高熵 token`)
