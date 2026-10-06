'use strict'

/**
 * 自检脚本（不依赖 Koishi 运行时）：
 *   node test/verify.cjs
 *
 * 1. 校验插件模块能加载、导出契约齐全
 * 2. 校验 prompt_cache_key 注入逻辑（这是本适配器存在的理由）
 * 3. 用**网关真实** /v1/models 数据跑一遍 refreshModels，校验能力/上下文解析
 */

const path = require('node:path')
const assert = require('node:assert')

const plugin = require(path.join(__dirname, '..', 'lib', 'index.cjs'))
const { InternAIRequester, InternAIClient } = plugin.__internals

const KEY = process.env.INTERN_API_KEY
const ENDPOINT =
  process.env.INTERN_API_ENDPOINT || 'https://discovery-api.intern-ai.org.cn/v1'

let failed = 0
function check(name, fn) {
  try {
    const r = fn()
    console.log(`  ✅ ${name}${r ? ' — ' + r : ''}`)
  } catch (e) {
    failed++
    console.log(`  ❌ ${name} — ${e.message}`)
  }
}

console.log('\n=== 1. 模块导出契约 ===')
check('name', () => assert.equal(plugin.name, 'chatluna-intern-ai-adapter') && plugin.name)
check('inject', () => assert.deepEqual(plugin.inject, ['chatluna']) && 'chatluna')
check('apply 是函数', () => assert.equal(typeof plugin.apply, 'function') && 'ok')
check('Config 可被 Schema 编译（与官方 openai-like 适配器同样方式）', () => {
  const { Schema } = require(path.join(
    __dirname,
    '..',
    '..',
    '..',
    'node_modules',
    'koishi'
  ))
  const official = require(path.join(
    __dirname,
    '..',
    '..',
    '..',
    'node_modules',
    'koishi-plugin-chatluna-openai-like-adapter'
  ))
  const mine = JSON.stringify(Schema.resolve(plugin.Config))
  const theirs = JSON.stringify(Schema.resolve(official.Config))
  assert.ok(mine.length > 500, `序列化结果太小: ${mine.length}`)
  assert.ok(theirs.length > 500, '官方适配器都编译不出来，环境有问题')
  for (const needle of [
    'intern-ai',
    'conversation',
    'prompt_cache_key',
    'prompt_cache_retention',
    'maxContextRatio'
  ]) {
    assert.ok(mine.includes(needle), `schema 里缺少 ${needle}`)
  }
  return `本适配器 ${mine.length} 字节 / 官方 ${theirs.length} 字节`
})

/* ------------------------------------------------------------------ */

function makeRequester(pluginConfig, client) {
  const pool = {
    getConfig: () => ({
      value: { apiKey: 'test-key', apiEndpoint: 'https://example.test/v1' }
    })
  }
  const sent = []
  const fakePlugin = {
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body), headers: init.headers })
      return new Response('data: [DONE]\n\n', { status: 200 })
    }
  }
  const requester = new InternAIRequester(
    {},
    pool,
    pluginConfig,
    fakePlugin,
    client
  )
  return { requester, sent }
}

const iceSystem = '大学生日常聊天协议栈 v4.0 —— 我是 Alison'
const otherSystem = '另一个角色的预设'

console.log('\n=== 2. prompt_cache_key 注入（核心功能）===')

check('conversation 模式下会补上 key', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: true })
  requester.post('chat/completions', {
    model: 'deepseek-v4-flash-0731',
    messages: [{ role: 'system', content: iceSystem }]
  })
  const key = sent[0].body.prompt_cache_key
  assert.ok(key, 'body 里没有 prompt_cache_key')
  assert.match(key, /^chatluna-intern-ai-[0-9a-f]{32}$/)
  return key
})

check('同一角色预设 → key 跨请求稳定', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: true })
  const body1 = { model: 'm', messages: [{ role: 'system', content: iceSystem }] }
  const body2 = { model: 'm', messages: [{ role: 'system', content: iceSystem }] }
  requester.post('chat/completions', body1)
  requester.post('chat/completions', body2)
  assert.equal(sent[0].body.prompt_cache_key, sent[1].body.prompt_cache_key)
  return sent[0].body.prompt_cache_key
})

check('不同角色预设 → key 不同', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: true })
  requester.post('chat/completions', {
    model: 'm',
    messages: [{ role: 'system', content: iceSystem }]
  })
  requester.post('chat/completions', {
    model: 'm',
    messages: [{ role: 'system', content: otherSystem }]
  })
  assert.notEqual(sent[0].body.prompt_cache_key, sent[1].body.prompt_cache_key)
  return 'ok'
})

check('CacheMiss: undefined 的 key 不会被 JSON 序列化丢掉', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: true })
  requester.post('chat/completions', {
    model: 'm',
    messages: [{ role: 'system', content: iceSystem }],
    // ChatLuna 原链路就是把这个字段设成 undefined，然后被基类删掉
    prompt_cache_key: undefined,
    id: undefined
  })
  assert.ok('prompt_cache_key' in sent[0].body, 'key 又被丢了')
  return '存在'
})

check('cacheKeyMode=off → 不发送', () => {
  const { requester, sent } = makeRequester({
    enablePromptCache: true,
    cacheKeyMode: 'off'
  })
  requester.post('chat/completions', {
    model: 'm',
    messages: [{ role: 'system', content: iceSystem }]
  })
  assert.equal(sent[0].body.prompt_cache_key, undefined)
  return 'ok'
})

check('enablePromptCache=false → 不发送（可一键关闭）', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: false })
  requester.post('chat/completions', {
    model: 'm',
    messages: [{ role: 'system', content: iceSystem }]
  })
  assert.equal(sent[0].body.prompt_cache_key, undefined)
  return 'ok'
})

check('cacheKeyMode=fixed → 用固定值', () => {
  const { requester, sent } = makeRequester({
    enablePromptCache: true,
    cacheKeyMode: 'fixed',
    cacheKey: 'my-fixed-key'
  })
  requester.post('chat/completions', { model: 'm', messages: [] })
  assert.equal(sent[0].body.prompt_cache_key, 'my-fixed-key')
  return 'my-fixed-key'
})

check('prompt_cache_retention 可透传', () => {
  const { requester, sent } = makeRequester({
    enablePromptCache: true,
    promptCacheRetention: '24h'
  })
  requester.post('chat/completions', { model: 'm', messages: [] })
  assert.equal(sent[0].body.prompt_cache_retention, '24h')
  return '24h'
})

check('请求地址拼接正确', () => {
  const { requester, sent } = makeRequester({ enablePromptCache: true })
  requester.post('chat/completions', { model: 'm', messages: [] })
  assert.equal(sent[0].url, 'https://example.test/v1/chat/completions')
  return sent[0].url
})

/* ------------------------------------------------------------------ */

async function testEndToEnd() {
  console.log(
    '\n=== 6. 进程内全链路（completionStream → 网关请求体 → SSE 解析）==='
  )
  const http = require('node:http')
  const { HumanMessage } = require('@langchain/core/messages')

  const received = []
  const sse = [
    'data: ' +
      JSON.stringify({
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, delta: { content: '你好' }, finish_reason: null }
        ]
      }),
    '',
    'data: ' +
      JSON.stringify({
        id: '1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 2,
          total_tokens: 1002,
          prompt_tokens_details: { cached_tokens: 900 }
        }
      }),
    '',
    'data: [DONE]',
    ''
  ].join('\n')

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push(JSON.parse(raw))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(sse)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const pool = {
    getConfig: () => ({
      value: { apiKey: 'test-key', apiEndpoint: `http://127.0.0.1:${port}/v1` }
    })
  }
  const requester = new InternAIRequester(
    {},
    pool,
    { enablePromptCache: true, cacheKeyMode: 'conversation' },
    { fetch: globalThis.fetch },
    null
  )

  let text = ''
  // 捕获日志：断言"缓存命中 x/y token (z%)"这条真的会打出来
  const logLines = []
  plugin.__internals.setLogger({
    info: (m) => logLines.push(String(m)),
    debug: () => {},
    warn: () => {},
    error: () => {}
  })
  try {
    for await (const chunk of requester.completionStream({
      model: 'deepseek-v4-flash-0731',
      input: [new HumanMessage('只回两个字')],
      maxTokens: 64,
      temperature: 0
    })) {
      text += chunk.text ?? ''
    }
  } finally {
    plugin.__internals.setLogger(null)
  }
  server.close()

  check('完整流式请求跑通并解析出内容', () => {
    assert.ok(text.includes('你好'), 'text=' + JSON.stringify(text))
    return JSON.stringify(text)
  })
  check('链路请求体带 prompt_cache_key（端到端）', () => {
    assert.ok(received[0]?.prompt_cache_key, '没有 key')
    return received[0].prompt_cache_key
  })
  check('消息转换生效（messages 数组）', () => {
    assert.ok(Array.isArray(received[0].messages) && received[0].messages.length)
    return received[0].messages.map((m) => m.role).join(',')
  })
  check('请求以 stream=true 发出', () =>
    assert.equal(received[0].stream, true) && 'true'
  )
  check('usage 里的 cached_tokens 能被读到并打进日志（命中率可观测）', () => {
    const hit = logLines.find((l) => l.includes('缓存命中'))
    assert.ok(hit, '没有打出缓存命中日志，logLines=' + JSON.stringify(logLines))
    assert.ok(hit.includes('900/1000'), '数字不对: ' + hit)
    assert.ok(hit.includes('(90%)'), '百分比不对: ' + hit)
    return hit
  })
}

/* ------------------------------------------------------------------ */

async function testWire() {
  console.log('\n=== 4. 线上线路验证（本地服务器 + 真 fetch 走完整 post()）===')
  const http = require('node:http')
  const received = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      received.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(raw)
      })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const pool = {
    getConfig: () => ({
      value: { apiKey: 'test-key', apiEndpoint: `http://127.0.0.1:${port}/v1` }
    })
  }
  const requester = new InternAIRequester(
    {},
    pool,
    { enablePromptCache: true, cacheKeyMode: 'conversation' },
    { fetch: globalThis.fetch },
    null
  )

  await requester.post(
    'chat/completions',
    {
      model: 'deepseek-v4-flash-0731',
      messages: [{ role: 'system', content: iceSystem }],
      // ChatLuna 原链路就是这样把这些字段设成 undefined 的
      prompt_cache_key: undefined,
      prompt_cache_retention: undefined,
      temperature: undefined,
      stream: true
    },
    {}
  )
  server.close()

  const got = received[0]
  check('请求真的打到了服务器', () => {
    assert.equal(received.length, 1)
    return got.url
  })
  check('网线上的 body 带 prompt_cache_key（核心断言）', () => {
    assert.ok(got.body.prompt_cache_key, '网线上没有 key！')
    assert.match(got.body.prompt_cache_key, /^chatluna-intern-ai-[0-9a-f]{32}$/)
    return got.body.prompt_cache_key
  })
  check('undefined 字段确实被基类剥掉了', () => {
    assert.ok(!('temperature' in got.body), 'temperature 还在')
    assert.ok(!('prompt_cache_retention' in got.body), 'prompt_cache_retention 还在')
    return 'temperature / prompt_cache_retention 已剥离'
  })
  check('鉴权头正确', () => assert.equal(got.auth, 'Bearer test-key') && got.auth)

  if (!KEY) return
  console.log('\n=== 5. 把同一份 body 发给真网关（确认带 key 被接受）===')
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ ...got.body, stream: false, max_tokens: 8 })
  })
  const text = await res.text()
  check('真网关接受带 prompt_cache_key 的请求', () => {
    assert.equal(res.status, 200, `HTTP ${res.status}: ${text.slice(0, 200)}`)
    const json = JSON.parse(text)
    return `HTTP 200, served=${json.model}, prompt_tokens=${json.usage?.prompt_tokens}`
  })
}

/* ------------------------------------------------------------------ */

async function testModels() {
  console.log('\n=== 3. 网关真实 /v1/models 解析 ===')
  if (!KEY) {
    console.log('  ⏭  跳过（未设置 INTERN_API_KEY）')
    return
  }
  const res = await fetch(`${ENDPOINT}/models`, {
    headers: { Authorization: `Bearer ${KEY}` }
  })
  const json = await res.json()
  const raw = json.data ?? []
  console.log(`  网关返回 ${raw.length} 个模型`)

  const client = Object.create(InternAIClient.prototype)
  client.platform = 'intern-ai'
  client._imageModels = new Set()
  client._config = { pullModels: true, blacklistModels: [], additionalModels: [] }
  client._requester = { getModels: async () => raw }

  const models = await client.refreshModels()
  for (const m of models) {
    console.log(
      `   · ${m.name.padEnd(24)} type=${String(m.type).padEnd(10)} ` +
        `maxTokens=${String(m.maxTokens).padEnd(8)} caps=[${m.capabilities.join(',')}]`
    )
  }
  check('拉取到 10 个模型', () => assert.equal(models.length, 10) && '10')
  check('vision 模型被标记图片输入', () => {
    const m = models.find((x) => x.name === 'deepseek-v4-flash-vision')
    assert.ok(m.capabilities.includes('image_input'), '缺 image_input')
    return `caps=[${m.capabilities.join(',')}]`
  })
  check('非 vision 命名但网关声明图片的模型也被标记（kimi-k2.6）', () => {
    const m = models.find((x) => x.name === 'kimi-k2.6')
    assert.ok(m.capabilities.includes('image_input'), '缺 image_input')
    return `caps=[${m.capabilities.join(',')}]`
  })
  check('文本模型带 tool_call', () => {
    const m = models.find((x) => x.name === 'glm-5.3')
    assert.ok(m.capabilities.includes('tool_call'), '缺 tool_call')
    return `caps=[${m.capabilities.join(',')}]`
  })
  check('上下文长度取自元数据（0731 = 1048576）', () => {
    const m = models.find((x) => x.name === 'deepseek-v4-flash-0731')
    assert.equal(m.maxTokens, 1048576)
    return String(m.maxTokens)
  })
  check('图片模型集合已建立', () => {
    assert.ok(client._imageModels.size >= 5, `只有 ${client._imageModels.size} 个`)
    return [...client._imageModels].join(', ')
  })
}

testEndToEnd()
  .then(() => testWire())
  .then(() => testModels())
  .catch((e) => {
    failed++
    console.log('  ❌ 集成阶段异常: ' + e.message)
  })
  .finally(() => {
    console.log(
      failed === 0
        ? '\n全部通过 ✅\n'
        : `\n有 ${failed} 项失败 ❌\n`
    )
    process.exit(failed === 0 ? 0 : 1)
  })
