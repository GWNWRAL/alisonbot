/**
 * 示例 Alison 插件：点头像（演示热加载与平台无关的对话拦截器）
 *
 * 试试：
 *   1. 在网页聊天里说「点头像」→ 拦截器直接回一句话（不经过模型，省 token）
 *   2. 改这个文件里下面的 REPLIES 数组并保存 → 再问一次，回复已经变了（热加载生效）
 */

const { defineAlisonPlugin } = require('koishi-plugin-alison-core')

const REPLIES = [
  '嗯？在呢在呢，别戳了。',
  '……你喊我干嘛，我正忙着发呆。',
  '点我干嘛，我又不会弹出来。',
  '在的在的，说吧。'
]

module.exports = defineAlisonPlugin({
  id: 'poke',
  name: '点头像',
  version: '0.0.1',
  desc: '示例插件：拦截「点头像」并按心情回一句（演示对话拦截器与热加载）',

  setup(ctx, env) {
    const log = env.logger

    if (env.core && typeof env.core.registerChatInterceptor === 'function') {
      env.core.registerChatInterceptor(async (payload) => {
        const text = String((payload && payload.text) || '').trim()
        if (!/点头像|戳一下|poke/i.test(text)) return null      // 不干预其它消息
        const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]
        return { handled: true, reply }
      }, { id: 'poke', title: '点头像' })
      log.info('「点头像」拦截器已注册（改这个文件保存即生效）')
    }

    return () => log.info('「点头像」插件已卸载')
  }
})
