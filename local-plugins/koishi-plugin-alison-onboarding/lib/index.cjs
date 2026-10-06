'use strict'

/**
 * koishi-plugin-alison-onboarding —— 首次部署的拟人化引导
 *
 * 设计要点：
 *   · 人格先行：第一句不是"请配置 API"，而是"你想让我成为什么样的存在？/ 你喜欢什么样的我？"
 *   · 全部通过"对话"完成（网页或 QQ 都能引导），一步一问，答完就有明确的确认与进度（成就感）
 *   · 没有模型也能引导：话术是脚本化的（拟人语气），配好 Key 之后再调模型润色后续话术
 *   · 每一步的答案都会落盘，并**写进系统提示词**（人设实时长出来）
 *   · 配置改动走 alison-core 的热更新（不重启），装插件走 alison-autonomy
 *
 * 状态：data/alison-onboarding/state.json
 */

const fs = require('node:fs')
const path = require('node:path')
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
const DIR = path.join(ROOT, 'data', 'alison-onboarding')
const STATE_FILE = path.join(DIR, 'state.json')
const PERSONA_FILE = path.join(DIR, 'persona.md')
const CONFIG = resolveConfigFile_()

let logger

const STEPS = [
  { id: 'welcome', title: '认识一下', ask: '先说说——你喜欢什么样的我？' },
  { id: 'name', title: '给我起个名字', ask: '我该叫什么？' },
  { id: 'brain', title: '接上我的大脑（模型）', ask: '我需要一个模型 API Key 才能真的开口' },
  { id: 'platform', title: '在哪儿找你', ask: '你想在哪儿跟我说话？' },
  { id: 'abilities', title: '给我装点能力', ask: '要不要记忆 / 日记 / 好感度 / 表情包？' },
  { id: 'done', title: '完工', ask: '好了，看看现在的我' }
]

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }) }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fb } }
function writeJson(f, v) { ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8') }
function readText(f) { try { return fs.readFileSync(f, 'utf8') } catch { return null } }

/* ------------------------------------------------------------------ *
 * 选项：每一步都给"有指向性"的选择（新手点一下就行），也允许自由输入
 * ------------------------------------------------------------------ */
const STEP_OPTIONS = {
  welcome: [
    { key: '1', label: '冷静靠谱的助理', value: '话少、冷静、靠谱。先办事，不废话，偶尔补一句精准的吐槽。' },
    { key: '2', label: '嘴毒损友', value: '嘴毒、爱吐槽、损人不带脏字，但关键时候一定站在主人这边。' },
    { key: '3', label: '黏人的伴儿', value: '黏人、会惦记我有没有吃饭睡觉，愿意听我讲废话，也会主动来找我。' },
    { key: '4', label: '群里的活跃角色', value: '爱玩梗、会接话，在群里热闹但不刷屏，私聊时更认真一点。' },
    { key: '5', label: '我自己描述', free: true }
  ],
  name: [
    { key: '1', label: '就叫 Alison', value: 'Alison' },
    { key: '2', label: '我自己起一个', free: true }
  ],
  brain: [
    { key: '1', label: 'DeepSeek（推荐，便宜好用）', value: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }, hint: '去 platform.deepseek.com → API keys 建一个，形如 sk-...' },
    { key: '2', label: 'OpenAI 官方', value: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }, hint: '去 platform.openai.com → API keys 建一个' },
    { key: '3', label: '通义千问', value: { provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' }, hint: '去阿里云百炼控制台建一个 DashScope Key' },
    { key: '4', label: '我自己的 OpenAI 兼容网关', value: { provider: 'custom', baseUrl: '', model: '' }, free: true },
    { key: '5', label: '我直接贴 Key，你看着办', free: true }
  ],
  platform: [
    { key: '1', label: '网页（现在这个界面，立刻可用）', value: '网页' },
    { key: '2', label: 'QQ（需要 OneBot 桥，如 NapCat）', value: 'QQ' },
    { key: '3', label: '都要', value: '网页 + QQ' }
  ],
  abilities: [
    { key: '1', label: '记忆（记住你说过的事）', value: ['chatluna-livingmemory'] },
    { key: '2', label: '记忆 + 好感度', value: ['chatluna-livingmemory', 'chatluna-affinity'] },
    { key: '3', label: '全都要（记忆 / 好感度 / 日记 / 表情包）', value: ['chatluna-livingmemory', 'chatluna-affinity', 'chatluna-livingdiary', 'memesluna'] },
    { key: '4', label: '先不要，保持最轻', value: [] }
  ]
}

function optionsFor(step) {
  return (STEP_OPTIONS[step] || []).map((o) => ({ key: o.key, label: o.label, free: !!o.free }))
}

/** 把用户输入映射成选项；返回 { opt } 或 { free:true, text } 或 null */
function pickOption(step, text) {
  const t = String(text || '').trim()
  const opts = STEP_OPTIONS[step] || []
  if (!t || !opts.length) return null
  const m = t.match(/^([1-9])\b/) || t.match(/^第([1-9一二三四五六七八九])/)
  if (m) {
    const raw = m[1]
    const n = /[1-9]/.test(raw) ? raw : String('一二三四五六七八九'.indexOf(raw) + 1)
    const hit = opts.find((o) => o.key === n)
    if (hit) return hit.free ? { free: true, needText: true, text: '' } : { opt: hit }
  }
  for (const o of opts) {
    if (!o.free && t.includes(o.label)) return { opt: o }
  }
  return { free: true, text: t }
}

function defaultState() {
  return {
    version: 1,
    startedAt: Date.now(),
    step: 'welcome',
    answers: {},
    transcript: [],
    completedAt: null
  }
}

/* ------------------------------------------------------------------ *
 * 有没有配好"大脑"？—— 判断首次部署
 * ------------------------------------------------------------------ */
function hasModelKey() {
  try {
    const doc = yaml.load(readText(CONFIG))
    const keys = []
    ;(function walk(n) {
      if (!n || typeof n !== 'object') return
      for (const [k, v] of Object.entries(n)) {
        if (/^apiKeys?$/i.test(k.replace(/^~/, '')) && Array.isArray(v)) {
          for (const item of v) {
            if (Array.isArray(item) && typeof item[0] === 'string') keys.push(item[0])
            else if (typeof item === 'string') keys.push(item)
          }
        }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc)
    return keys.some((k) => typeof k === 'string' && k.length > 12 && !/REPLACE_ME|你的|xxx/i.test(k))
  } catch { return false }
}

/* ------------------------------------------------------------------ *
 * 话术：拟人、带进度与确认感（无模型也能跑）
 * ------------------------------------------------------------------ */
function progress(state) {
  const idx = STEPS.findIndex((s) => s.id === state.step)
  const n = Math.max(1, idx + 1)
  const total = STEPS.length
  const bars = '●'.repeat(n) + '○'.repeat(total - n)
  return `（第 ${n}/${total} 步 ${bars}）`
}

const SCRIPTS = {
  welcome: () =>
    '嗨。\n\n' +
    '我是 **Alison**——不过说真的，现在的我还只是一副空壳子：没有性格、没有记忆、也还不会说话。\n' +
    '接下来这几分钟，你说了算。\n\n' +
    '先别管什么配置文件、API —— 我只想知道一件事：\n' +
    '**你喜欢什么样的我？**\n\n' +
    '随便说，越具体越好。比如：\n' +
    '· 话少一点、冷静一点，像个靠谱的助理\n' +
    '· 嘴毒一点、爱吐槽，像群里那种损友\n' +
    '· 黏人一点，会关心我有没有吃饭睡觉\n' +
    '· 或者你心里已经有个角色的样子了，直接描述给我\n\n' +
    '（你也可以顺手告诉我：你想要的是"工具人"还是"伴儿"。）',

  name: (a) =>
    '……好，我大概知道你想让我是个什么样的人了。\n\n' +
    `我把它记下来了：\n> ${String(a.persona || '').slice(0, 200)}\n\n` +
    '那第一个属于你的决定：**我该叫什么？**\n' +
    '（不说也行，那我就继续叫 Alison。）',

  brain: (a) =>
    `「${a.name || 'Alison'}」——好名字，我收下了。\n\n` +
    '接下来是要紧事：我现在只有一个空脑袋，得接上一个模型才能真正开口。\n\n' +
    '把你常用的 **API Key** 贴给我就行（OpenAI 兼容的都行，比如 DeepSeek 的 `sk-...`）。\n' +
    '格式随意，这样也可以：\n' +
    '```\nsk-你的Key\n```\n' +
    '```\nsk-你的Key https://api.deepseek.com deepseek-chat\n```\n\n' +
    '我会把它写进配置、当场试一次，然后告诉你成不成。**Key 只存在你本机的配置文件里。**',

  platform: (a) =>
    '能说话了，真好。\n\n' +
    '现在决定我在哪儿陪你：\n' +
    '· **网页**（就是你现在开着的这个界面，立刻可用）\n' +
    '· **QQ**（需要一个 OneBot 桥，比如 NapCat / LLOneBot；把机器人 QQ 号告诉我）\n' +
    '· 或者 **都要**\n\n' +
    `（当前：${a.platform || '网页'}）`,

  abilities: () =>
    '还差最后一步——你想给我装上哪些能力？这些都是插件，随时能加也能撤：\n\n' +
    '· **记忆** —— 我会记住你说过的事（chatluna-livingmemory）\n' +
    '· **日记** —— 我会往 QQ 空间写日记（chatluna-livingdiary）\n' +
    '· **好感度** —— 我会对人有亲疏（chatluna-affinity）\n' +
    '· **表情包** —— 我会发表情（memesluna）\n\n' +
    '直接说名字就行，比如"记忆和好感度"，或者说"都要 / 先不要"。',

  done: (a) => {
    const on = []
    if (a.platform) on.push(`对话平台：${a.platform}`)
    if (a.model) on.push(`模型：${a.model}`)
    if (a.abilities && a.abilities.length) on.push(`能力：${a.abilities.join('、')}`)
    return '——好啦。\n\n' +
      `我是 **${a.name || 'Alison'}**，${String(a.persona || '').slice(0, 120)}\n\n` +
      '你这几分钟亲手搭出来的东西：\n' +
      on.map((x) => '· ' + x).join('\n') + '\n\n' +
      '以后想改任何东西（人设、模型、平台、插件），直接跟我说就行——我能改自己的配置、装自己的插件、也能给自己做体检。\n' +
      '想重新走一遍引导，就说一句 **「重新引导」**。'
  }
}

/* ------------------------------------------------------------------ *
 * 回答解析
 * ------------------------------------------------------------------ */
function parseKeyAnswer(text) {
  const t = String(text || '').trim()
  const json = t.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const o = JSON.parse(json[0])
      const key = o.key || o.apiKey || o.api_key || o.token
      if (key) return { key, baseUrl: o.baseUrl || o.base_url || o.url, model: o.model }
    } catch { /* ignore */ }
  }
  const key = (t.match(/sk-[A-Za-z0-9._\-]{8,}/) || t.match(/\b[A-Za-z0-9._\-]{24,}\b/) || [])[0]
  const url = (t.match(/https?:\/\/[^\s,，]+/) || [])[0]
  // 先把 URL 抠掉再找模型名，否则 deepseek.com 会被当成模型名（真踩过）
  const rest = url ? t.split(url).join(' ') : t
  const model = (rest.match(/\b(deepseek[\w.\-]*|gpt-[\w.\-]+|claude[\w.\-]+|qwen[\w.\-]*|glm[\w.\-]*|kimi[\w.\-]*|intern[\w.\-]*)\b/i) || [])[0]
  return { key, baseUrl: url, model }
}

function parseAbilities(text) {
  const t = String(text || '')
  if (/都|全部|all|都要/i.test(t) && !/不|别|先不要/i.test(t)) return ['chatluna-livingmemory', 'chatluna-livingdiary', 'chatluna-affinity', 'memesluna']
  const map = [
    [/记忆|memory/i, 'chatluna-livingmemory'],
    [/日记|diary/i, 'chatluna-livingdiary'],
    [/好感|affinity/i, 'chatluna-affinity'],
    [/表情|memes?/i, 'memesluna']
  ]
  const out = []
  for (const [re, plug] of map) if (re.test(t)) out.push(plug)
  return out
}

function parsePlatform(text) {
  const t = String(text || '')
  const web = /网页|web|界面|浏览器/i.test(t)
  const qq = /qq|群|onebot|napcat|llonebot/i.test(t)
  if (web && qq) return '网页 + QQ'
  if (qq) return 'QQ'
  return '网页'
}

/* ------------------------------------------------------------------ *
 * 写配置 / 人设（走热更新）
 * ------------------------------------------------------------------ */
function writePersonaFile(answers) {
  const block = [
    '# AlisonBot 动态人设（由首次引导生成，可随时改）',
    '',
    `- 名字：${answers.name || 'Alison'}`,
    `- 主人希望的性格：${answers.persona || '（未指定，保持默认）'}`,
    answers.platform ? `- 对话平台：${answers.platform}` : null,
    answers.abilities && answers.abilities.length ? `- 已装能力：${answers.abilities.join('、')}` : null,
    '',
    '## 给 Alison 的设定段（会拼进系统提示词）',
    '',
    `主人对我的期望是：${answers.persona || '做一个自然、有自己性格的存在'}`,
    answers.name ? `我现在的名字是「${answers.name}」。` : '',
    '我不只是工具：我会主动关心、会有自己的态度，也会在被需要的时候把事办利索。',
    ''
  ].filter(Boolean).join('\n')
  ensureDir(DIR)
  fs.writeFileSync(PERSONA_FILE, block, 'utf8')
  return block
}

/** 从配置里找出某个插件的条目键（形如 chatluna-deepseek-adapter:v2ku38）；没有就创建一个启用的条目 */
function resolveEntryKey(base) {
  // 返回"配置里真实存在的键名"——可能是 ~name:id（禁用态）。以前把 ~ 剥掉返回，
  // 导致后面的写入落到不存在的键上、配置里多出一个重复条目（首启卡在这一步）。
  try {
    const doc = yaml.load(readText(CONFIG)) || {}
    let found = null
    ;(function walk(node) {
      if (!node || typeof node !== 'object') return
      for (const [k, v] of Object.entries(node)) {
        const raw = k.replace(/^~/, '')
        if (raw.startsWith('group:')) { walk(v); continue }
        const name = raw.split(':')[0]
        // 优先选启用态的那个（同名同时存在启用/禁用时）
        if (name === base && (!found || (found.startsWith('~') && !k.startsWith('~')))) found = k
      }
    })(doc.plugins)
    if (found) return found
  } catch { /* ignore */ }
  return null
}

/** 直接结构化改某个插件条目的字段：自动去掉 ~ 前缀（= 启用），带备份与 YAML 校验 */
function writeEntryFields(base, fields) {
  const entry = resolveEntryKey(base)
  if (!entry) return { ok: false, error: '配置里没有 ' + base + '（可以让 Alison 自己装）' }
  try {
    const doc = yaml.load(readText(CONFIG))
    if (!doc || !doc.plugins) return { ok: false, error: '配置结构异常' }
    // 找到它所在的那一层（通常在 plugins 下，也可能在 group 里）
    let parent = null
    let key = null
    ;(function walk(node) {
      if (!node || typeof node !== 'object' || parent) return
      for (const [k, v] of Object.entries(node)) {
        if (k.replace(/^~/, '') === entry.replace(/^~/, '')) { parent = node; key = k; return }
        if (v && typeof v === 'object') walk(v)
      }
    })(doc.plugins)
    if (!parent) return { ok: false, error: '找不到条目 ' + entry }
    const cur = parent[key] && typeof parent[key] === 'object' ? parent[key] : {}
    const next = { ...cur, ...fields }
    if (key.startsWith('~')) {           // 写 Key 意味着要启用它
      delete parent[key]
      parent[key.replace(/^~/, '')] = next
    } else {
      parent[key] = next
    }
    const text = yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"' })
    yaml.load(text)                       // 校验，坏了不写
    ensureDir(path.join(ROOT, 'data', 'alison-core', 'backups'))
    try { fs.copyFileSync(CONFIG, path.join(ROOT, 'data', 'alison-core', 'backups', 'config-' + Date.now() + '.yml')) } catch { /* ignore */ }
    fs.writeFileSync(CONFIG, text, 'utf8')
    return { ok: true, entry: key.replace(/^~/, ''), enabled: true }
  } catch (e) { return { ok: false, error: e.message } }
}

/** 插件条目不存在时，往 plugins: 下面插一个启用的（新手直接能用，不用自己编辑 YAML） */
function upsertPluginEntry(base, initial) {
  const text = readText(CONFIG)
  if (!text) return { ok: false, error: '找不到配置' }
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => /^plugins:\s*$/.test(l))
  if (idx < 0) return { ok: false, error: '找不到 plugins: 行' }
  const id = Math.random().toString(36).slice(2, 8)
  const body = yaml.dump(initial || {}, { lineWidth: -1, noRefs: true, indent: 4 }).trim().split('\n')
  if (body.length === 1 && body[0] === '{}') {
    lines.splice(idx + 1, 0, `  ${base}:${id}: {}`)
  } else {
    // 形如 "  name:id:" 后面跟缩进 4 个空格的字段
    lines.splice(idx + 1, 0, `  ${base}:${id}:`)
    for (const b of body) lines.splice(idx + 2 + body.indexOf(b), 0, '    ' + b)
  }
  const next = lines.join('\n')
  try { yaml.load(next) } catch (e) { return { ok: false, error: 'YAML 校验失败：' + e.message } }
  ensureDir(path.join(ROOT, 'data', 'alison-core', 'backups'))
  fs.copyFileSync(CONFIG, path.join(ROOT, 'data', 'alison-core', 'backups', `config-${Date.now()}.yml`))
  fs.writeFileSync(CONFIG, next, 'utf8')
  return { ok: true, key: `${base}:${id}`, created: true }
}

/** 把 Key 写到"真正存在"的适配器条目上；条目不存在就创建（并热应用） */
function applyModelKey(ctx, provider, key, baseUrl, model) {
  const adapter = (provider && provider.adapter) ? String(provider.adapter).replace(/^koishi-plugin-/, '') : 'chatluna-deepseek-adapter'
  const endpoint = baseUrl || (provider && provider.baseUrl) || 'https://api.deepseek.com'
  const out = { adapter, writes: [] }

  const targets = [[adapter, { apiKeys: [[key, endpoint]] }]]
  if (adapter !== 'chatluna-character' && resolveEntryKey('chatluna-character')) {
    targets.push(['chatluna-character', { apiKeys: [[key, endpoint]] }])
  }

  for (const [base, fields] of targets) {
    let r = writeEntryFields(base, fields)
    if (!r.ok) {
      // 配置里确实没有 → 建一个（此时才用插入式）
      const created = upsertPluginEntry(base, fields)
      out.writes.push({ plugin: base, created: !!created.ok, error: r.error })
      continue
    }
    if (model && base === 'chatluna-character') {
      const m = writeEntryFields(base, { model })
      r = { ...r, model: !!m.ok }
    } else if (model && base === adapter) {
      writeEntryFields(base, { model })
    }
    out.writes.push({ plugin: base, entry: r.entry, ok: true })
  }
  return out
}

/** 把动态人设拼进系统提示词（网页设置 + ChatLuna 角色预设） */
async function syncSystemPrompt(ctx, answers) {
  const block = writePersonaFile(answers)
  const results = { file: PERSONA_FILE }

  // 1) 网页聊天：写进 alison-platform-web 的设置
  try {
    const settingsFile = path.join(ROOT, 'data', 'alison-platform-web', 'settings.json')
    const settings = readJson(settingsFile, {})
    const base = settings.systemPromptBase || settings.systemPrompt || ''
    if (!settings.systemPromptBase) settings.systemPromptBase = base
    settings.systemPrompt = [settings.systemPromptBase, '', '---', '', block].filter(Boolean).join('\n')
    writeJson(settingsFile, settings)
    results.web = true
  } catch (e) { results.webError = e.message }

  // 2) QQ 侧：改 ChatLuna 角色预设的 system（备份后结构化改）
  try {
    const presetFile = path.join(ROOT, 'data', 'chathub', 'character', 'presets', 'Alison.yml')
    if (fs.existsSync(presetFile)) {
      const raw = readText(presetFile)
      const preset = yaml.load(raw)
      const dir = path.join(ROOT, 'data', 'alison-core', 'backups')
      ensureDir(dir)
      fs.copyFileSync(presetFile, path.join(dir, `preset-Alison-${Date.now()}.yml`))
      if (preset && typeof preset === 'object' && typeof preset.system === 'string') {
        const marker = '\n\n<!-- alison-onboarding -->'
        preset.system = preset.system.split(marker)[0] + marker + '\n' + block
        fs.writeFileSync(presetFile, yaml.dump(preset, { lineWidth: -1, noRefs: true }), 'utf8')
        results.preset = true
      }
    }
  } catch (e) { results.presetError = e.message }

  return results
}

/* ------------------------------------------------------------------ *
 * 引导主流程
 * ------------------------------------------------------------------ */
async function handle(ctx, state, text, payload) {
  const core = ctx.alison || ctx.get?.('alison')
  const step = state.step
  const ans = state.answers

  if (/重新引导|重新设置|reset/i.test(text || '')) {
    const fresh = defaultState()
    writeJson(STATE_FILE, fresh)
    return { handled: true, reply: '好，我们从头来。\n\n' + SCRIPTS.welcome(), step: 'welcome' }
  }

  switch (step) {
    case 'welcome': {
      const picked = pickOption('welcome', text)
      if (picked && picked.needText) return { handled: true, reply: '那你直接用自己的话告诉我：你希望我是什么样的？', step }
      ans.persona = picked && picked.opt ? picked.opt.value : String(text || '').trim().slice(0, 800)
      state.step = 'name'
      return { handled: true, reply: `好，我记住了：\n> ${ans.persona.slice(0, 120)}\n\n` + SCRIPTS.name(ans), step: state.step }
    }
    case 'name': {
      const picked = pickOption('name', text)
      if (picked && picked.needText) return { handled: true, reply: '那你直接说一个名字给我就行。', step }
      if (picked && picked.opt) {
        ans.name = picked.opt.value
      } else {
        const t = String(text || '').trim()
        ans.name = (t && t.length <= 24 ? t : (t.split(/[\s，,。]/)[0] || 'Alison')).replace(/^我叫|^名字是/, '') || 'Alison'
      }
      state.step = 'brain'
      await syncSystemPrompt(ctx, ans)
      return { handled: true, reply: SCRIPTS.brain(ans), step: state.step }
    }
    case 'brain': {
      // 先看是不是在选"用哪家模型"
      const picked = pickOption('brain', text)
      if (picked && picked.needText && !parseKeyAnswer(text).key) return { handled: true, reply: '那把你那家的地址和 Key 一起贴给我，例如：\n```\nsk-你的Key https://你的地址/v1 你的模型名\n```', step }
      if (picked && picked.opt && !parseKeyAnswer(text).key) {
        ans.provider = picked.opt.value
        state.pending = 'key'
        return {
          handled: true,
          reply: `好，用 **${picked.opt.label}**。\n\n${picked.opt.hint || '去服务商后台建一个 Key'}\n\n` +
            '把 Key 贴给我就行（只写进你本机配置，我不会说出去）。想连地址/模型一起换就写成：\n```\nsk-你的Key https://地址 模型名\n```',
          step,
          pending: 'key'
        }
      }
      const parsed = parseKeyAnswer(text)
      if (!parsed.key) {
        const chosen = ans.provider ? `（已选：${ans.provider.label || ans.provider.provider}，差一个 Key）\n\n` : ''
        return {
          handled: true,
          reply: chosen + '我没能从里面认出 API Key。\n\n直接把这串贴给我（`sk-` 开头），或者先回一个数字选服务商：\n' +
            optionsFor('brain').map((o) => `**${o.key}.** ${o.label}`).join('\n'),
          step
        }
      }
      if (ans.provider && ans.provider.baseUrl) {
        parsed.baseUrl = parsed.baseUrl || ans.provider.baseUrl
        parsed.model = parsed.model || ans.provider.model
      }
      applyModelKey(ctx, ans.provider, parsed.key, parsed.baseUrl, parsed.model)
      ans.key = parsed.key
      ans.baseUrl = parsed.baseUrl
      ans.model = parsed.model
      const test = await testModel(ctx, parsed)
      if (!test.ok) {
        // 情况一：Key 已经写好、但这个平台的模型列表还是空的 —— 说明适配器还没重载
        // （ChatLuna/适配器在加载时建立客户端与模型列表，写完配置不会立刻刷新）。
        // 这种情况不能把用户卡在这里：放行，并明确告诉他重启一次就能用。
        const have = platformModelNames(ctx, (parsed.provider && parsed.provider.provider) || 'deepseek')
        if (!have.length) {
          ans.keyWritten = true
          state.step = 'platform'
          state.pending = null
          await syncSystemPrompt(ctx, ans)
          return {
            handled: true,
            reply: 'Key 我已经写进配置并启用了 ✓\n' +
              '不过模型列表要**重启一次**才会加载（适配器只在启动时建客户端）——重启后就能用了：\n' +
              '· 关掉 Alison.exe 再双击启动，或者说一句「重启我」，我让热更新插件排一个重启。\n' +
              '（界面里「系统设置 → 可用模型」下拉在重启后就会列出模型。）\n\n' +
              '咱们先把剩下的补完：\n\n' + SCRIPTS.platform(ans),
            step: state.step
          }
        }
        // 情况二：平台里已经有模型，说明 Key 或模型名不对 → 继续问
        return { handled: true, reply: `Key 我写进配置了，但试的时候出了问题：\n> ${test.error}\n\n检查一下 Key，或者回数字换一家模型服务，再贴一次给我。`, step }
      }
      state.step = 'platform'
      state.pending = null
      await syncSystemPrompt(ctx, ans)
      return { handled: true, reply: `成了——我刚刚真的说了一句话（${test.ms}ms）：\n> ${test.reply}\n\n${SCRIPTS.platform(ans)}`, step: state.step }
    }
    case 'platform': {
      const picked = pickOption('platform', text)
      ans.platform = (picked && picked.opt && picked.opt.value) || parsePlatform(text)
      state.step = 'abilities'
      await syncSystemPrompt(ctx, ans)
      return { handled: true, reply: SCRIPTS.abilities(), step: state.step }
    }
    case 'abilities': {
      const picked = pickOption('abilities', text)
      const wants = (picked && picked.opt && Array.isArray(picked.opt.value)) ? picked.opt.value : parseAbilities(text)
      ans.abilities = wants
      const enabled = []
      const missing = []
      const autonomy = ctx.autonomy || ctx.get?.('autonomy')
      for (const plug of wants) {
        const base = plug.replace(/^koishi-plugin-/, '')
        let r = autonomy && typeof autonomy.setPluginEnabled === 'function'
          ? autonomy.setPluginEnabled(base, true)
          : patchToggle(base, true)
        if (r && r.ok) { enabled.push(base); continue }
        // 没装过：Alison 自己去装（这就是"极度简单的配置"）
        const pilot = ctx.alisonAutonomy || (ctx.root && ctx.root.alisonAutonomy)
        if (pilot && typeof pilot.install === 'function') {
          try {
            const ir = await pilot.install(base)
            if (ir && ir.ok) { enabled.push(base + '（刚装上）'); continue }
            missing.push(base + (ir && ir.error ? '：' + ir.error : ''))
            continue
          } catch (e) { missing.push(base + '：' + e.message); continue }
        }
        missing.push(base)
      }
      ans.enabled = enabled
      ans.missing = missing
      state.step = 'done'
      state.completedAt = Date.now()
      await syncSystemPrompt(ctx, ans)
      const extra = missing.length
        ? `\n\n（这几个还没装上：${missing.join('、')}——跟我说一声"装上 xxx"，我自己去 npm 装。）`
        : ''
      return { handled: true, reply: SCRIPTS.done(ans) + extra, step: state.step, done: true }
    }
    default:
      return { handled: true, reply: SCRIPTS.done(ans), step: state.step, done: true }
  }
}

function patchToggle(base, enabled) {
  const text = readText(CONFIG)
  if (!text) return { ok: false, error: '找不到配置文件' }
  const lines = text.split('\n')
  const re = new RegExp('^(\\s*)(~?)(' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(:[a-z0-9]+:.*)$', 'i')
  let hit = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue
    lines[i] = m[1] + (enabled ? '' : '~') + m[3] + m[4]
    hit++
  }
  if (!hit) return { ok: false, error: `配置里没有 ${base}` }
  return patchConfigDirect('__noop__', undefined) && (() => {
    try {
      fs.writeFileSync(CONFIG, lines.join('\n'), 'utf8')
      yaml.load(lines.join('\n'))
      return { ok: true, needRestart: true }
    } catch (e) { return { ok: false, error: e.message } }
  })()
}

function platformModelNames(ctx, platform) {
  try {
    const pf = ctx.chatluna && ctx.chatluna.platform
    if (!pf || typeof pf.listPlatformModels !== 'function') return []
    const ref = pf.listPlatformModels(platform || 'deepseek', 1) // ModelType.llm = 1
    const arr = (ref && (Array.isArray(ref) ? ref : ref.value)) || []
    return arr.map((m) => m && m.name).filter(Boolean)
  } catch { return [] }
}

async function testModel(ctx, parsed) {
  const t0 = Date.now()
  if (!ctx.chatluna) return { ok: false, error: 'chatluna 服务还没起来' }
  const platform = 'deepseek' // 目前引导里的服务商都走 OpenAI 兼容的 deepseek 平台
  const wanted = parsed.model || 'deepseek-chat'

  const listPlatformModels = () => {
    try {
      const pf = ctx.chatluna.platform
      if (!pf || typeof pf.listPlatformModels !== 'function') return []
      const ref = pf.listPlatformModels(platform, 1) // ModelType.llm = 1
      const arr = (ref && (Array.isArray(ref) ? ref : ref.value)) || []
      return arr.map((m) => m && m.name).filter(Boolean)
    } catch { return [] }
  }

  // Key 刚写进配置时适配器往往还没重新加载（拉模型列表是异步的），
  // 所以这里重试几次；如果始终拿不到指定的模型，就退而用该平台"现有"的第一个模型试。
  const tried = []
  for (let i = 0; i < 6; i++) {
    const name = i < 5 ? wanted : (listPlatformModels()[0] || wanted)
    if (!tried.includes(name)) tried.push(name)
    try {
      const ref = await ctx.chatluna.createChatModel(`${platform}/${name}`)
      const model = ref && ref.value
      if (model) {
        const reply = await model.invoke([{ role: 'user', content: '用一句话自我介绍，20 字以内。' }])
        const text = String((reply && reply.content) || '').slice(0, 120)
        return {
          ok: true,
          model: name,
          ms: Date.now() - t0,
          reply: text || '（模型返回了空内容，但连接是通的）',
          note: name === wanted ? null : `你写的 ${wanted} 在 ${platform} 上没找到，用了现有的 ${name}`
        }
      }
    } catch (e) { /* 继续重试 */ }
    await new Promise((r) => setTimeout(r, 1200))
  }

  const have = listPlatformModels()
  return {
    ok: false,
    error: `模型不可用：${platform}/${wanted}` +
      (have.length ? `（这个平台现在有：${have.slice(0, 8).join(', ')}）` : '（这个平台还没加载出任何模型，Key 可能不对）')
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */
const name = 'alison-onboarding'
const inject = { optional: ['chatluna', 'server', 'database', 'alison'] }

const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用首次部署的对话式引导'),
  reGuideKeywords: Schema.string().default('重新引导,重新设置,开始引导').description('触发重新引导的关键词（逗号分隔）'),
  askPersonaFirst: Schema.boolean().default(true).description('人格先行：先问"你喜欢什么样的我"，再问 API Key')
})

function apply(ctx, config) {
  logger = ctx.logger('alison-onboarding')
  ensureDir(DIR)
  if (!fs.existsSync(STATE_FILE)) writeJson(STATE_FILE, defaultState())

  const loadState = () => readJson(STATE_FILE, defaultState())
  const saveState = (s) => writeJson(STATE_FILE, s)

  const needOnboarding = () => {
    const s = loadState()
    if (s.completedAt) return false
    return !hasModelKey() || s.step !== 'done'
  }

  const api = {
    state() {
      const s = loadState()
      const idx = STEPS.findIndex((x) => x.id === s.step)
      const firstRun = needOnboarding()
      let opening = null
      if (firstRun) {
        const script = SCRIPTS[s.step]
        opening = typeof script === 'function' ? script(s.answers) : String(script || '')
      }
      return {
        ok: true,
        firstRun,
        step: s.step,
        index: idx < 0 ? STEPS.length : idx + 1,
        total: STEPS.length,
        steps: STEPS.map((x, i) => ({ id: x.id, title: x.title, done: i < idx || !!s.completedAt })),
        options: config.guidedOptions !== false ? optionsFor(s.step) : [],
        pending: s.pending || null,
        answers: { ...s.answers, key: s.answers.key ? s.answers.key.slice(0, 6) + '…' : undefined },
        opening,
        personaFile: PERSONA_FILE,
        transcript: s.transcript.slice(-20)
      }
    },
    reset() { writeJson(STATE_FILE, defaultState()); return { ok: true } },
    answer(text) {
      const s = loadState()
      return handle(ctx, s, text, {}).then((res) => {
        s.transcript.push({ at: Date.now(), role: 'user', text: String(text).slice(0, 500) })
        s.transcript.push({ at: Date.now(), role: 'alison', text: String(res.reply || '').slice(0, 1500) })
        saveState(s)
        return res
      })
    }
  }
  const rootCtx = ctx.root || ctx
  if (rootCtx.set) rootCtx.set('alisonOnboarding', api)
  rootCtx.alisonOnboarding = api
  ctx.alisonOnboarding = api
  ctx.alison?.registerPlugin?.({ name, version: '0.0.1', kind: 'onboarding' })

  // 注册"引导步骤"到微内核（控制中心能显示进度）
  if (ctx.alison && typeof ctx.alison.registerSetupStep === 'function') {
    for (const s of STEPS) {
      ctx.alison.registerSetupStep({ id: s.id, title: s.title, done: () => loadState().answers && Object.keys(loadState().answers).length > 0 })
    }
  }

  // 对话拦截器：没配好之前，所有对话先经过引导
  const core = ctx.alison || (ctx.root && ctx.root.alison)
  if (config.enabled && core && typeof core.registerChatInterceptor === 'function') {
    core.registerChatInterceptor(async (payload, core) => {
      const s = loadState()
      if (s.completedAt) return null              // 引导已完成 → 正常聊天
      const text = payload && payload.text
      if (!text) return { handled: true, reply: SCRIPTS.welcome() }
      let res = await handle(ctx, s, text, payload)
      if (res && res.reply && !res.done) {
        const opts = optionsFor(res.step)
        if (opts.length) res = { ...res, reply: res.reply + '\n\n' + opts.map((o) => '**' + o.key + '.** ' + o.label).join('\n') }
      }
      s.transcript.push({ at: Date.now(), role: 'user', text: String(text).slice(0, 500) })
      if (res && res.reply) s.transcript.push({ at: Date.now(), role: 'alison', text: String(res.reply).slice(0, 1500) })
      saveState(s)
      return res
    }, { id: 'onboarding', title: '首次部署引导', priority: 100 })
    logger.info(config.askPersonaFirst ? '引导已就绪（人格先行）' : '引导已就绪')
  }

  // HTTP：控制中心的引导进度 / 手动推进
  ctx.inject(['server'], (serverCtx) => {
    const base = '/alison/api/onboarding'
    const wrap = (fn) => async (koa) => {
      const ip = koa.request?.ip || koa.ip || ''
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) { koa.status = 403; koa.body = { error: '仅允许本机' }; return }
      try { koa.body = await fn(koa) } catch (e) { koa.status = 500; koa.body = { ok: false, error: e.message } }
    }
    serverCtx.server.get(base + '/state', wrap(async () => api.state()))
    serverCtx.server.post(base + '/answer', wrap(async (koa) => api.answer((koa.request.body || {}).text)))
    serverCtx.server.post(base + '/reset', wrap(async () => api.reset()))
    logger.info(`引导接口：${base}/*`)
  })

  ctx.command('alison.setup', '重新走一遍首次部署引导').action(() => {
    api.reset()
    return '好，我们从头来：\n\n' + SCRIPTS.welcome()
  })
}

module.exports = { name, inject, Config, apply }
module.exports.default = module.exports
module.exports.__internals = { STEPS, hasModelKey, parseKeyAnswer, parseAbilities, parsePlatform, syncSystemPrompt }
