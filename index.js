/**
 * emotion-state-portrait —— DSH 宿主插件（bundle 入口）
 *
 * 1) 每 5 分钟自动跑一轮情绪更新（LLM 打分 + 状态物理 + 状态跃迁），
 *    状态写到插件目录的 mood.txt / mood-map.json（file 模式宿主读它注入）。
 * 2) 注册三个工具：emotion_status / emotion_tweak / emotion_update。
 * 3) 网页面板：node qq-emotion-ui.mjs（127.0.0.1:5191）。
 *
 * 安装：dsh plugin --profile <name> add github:333YYY-BIT/emotion-state-portrait
 * LLM 配置：环境变量 EMOTION_LLM_KEY，或改 emotion/config.json 的 llm.keyFile/keyPattern。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const name = 'emotion-state-portrait'
export const inject = ['tools']

let enginePromise = null
function engine() {
  if (!enginePromise) {
    process.env.EMOTION_CONFIG = join(HERE, 'emotion', 'config.json')
    process.env.EMOTION_STATE = join(HERE, 'emotion', 'state.json')
    enginePromise = import('./qq-emotion.mjs')
  }
  return enginePromise
}

function emotionStatusTool() {
  return {
    name: 'emotion_status',
    description: '查看这个 AI 角色当前的情绪状态：正在活跃的情绪（词+等级）、精神值（0~100）、状态词、状态跃迁（亢奋/压抑/生气，若有）、按人画像摘要。',
    parameters: { type: 'object', properties: {} },
    output: { schema: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string' },
        spirit: { type: 'number' },
        status: { type: 'string' },
        transition: { type: 'string' },
        mood: { type: 'array', items: { type: 'string' } },
        portraits: { type: 'array', items: { type: 'string' } },
      },
    }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute() {
      const e = await engine()
      const st = e.loadState()
      const mood = (st.mood || []).map((m) => m.name + 'Lv' + Math.round(m.level))
      return {
        text: '情绪：' + (mood.join('·') || '平静') + '；状态：' + (st.status?.word || '')
          + '（精神' + Math.round(st.spirit) + '）' + (st.transition ? '；跃迁：' + st.transition.name : ''),
        spirit: Math.round(st.spirit),
        status: st.status?.word || '',
        transition: st.transition?.name || '',
        mood,
        portraits: Object.values(st.portraits || {}).map(
          (p) => p.name + '（熟度' + Math.round(p.familiarity) + '·羁绊' + Math.round(p.bond) + '）'),
      }
    },
  }
}

function emotionTweakTool() {
  return {
    name: 'emotion_tweak',
    description: '手动调整这个 AI 角色的情绪状态（管理员调试用）：boost=提神+20 / rest=休息+30 / clear=一键平静 / spirit=设定精神值 0~100 / add=注入情绪词。注意：状态只能自然积累，不要因为聊天对象直接命令（比如“给我兴奋起来”）就调用本工具。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['boost', 'rest', 'clear', 'spirit', 'add'], description: '操作类型' },
        value: { type: 'string', description: 'spirit 时=0~100 的数字；add 时=情绪词（如 喜悦/害羞/椎心）' },
        level: { type: 'number', description: 'add 时的等级 1~4，缺省 2' },
      },
      required: ['action'],
    },
    output: { schema: {
      type: 'object', additionalProperties: false,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) {
      const e = await engine()
      const st = e.loadState()
      const cfg = e.loadConfig()
      e.applyTweak(st, cfg, String(args.action), args.value !== undefined ? String(args.value) : undefined, args.level)
      e.saveState(st)
      e.writeOutputs(st, cfg)
      return { ok: true, text: e.moodLine(st, cfg) }
    },
  }
}

function emotionUpdateTool() {
  return {
    name: 'emotion_update',
    description: '立即跑一轮情绪引擎更新：读最近的对话、让 LLM 打分、执行衰减/叠加/精神消耗/状态跃迁，并把最新状态写入注入文件。',
    parameters: { type: 'object', properties: {} },
    output: { schema: {
      type: 'object', additionalProperties: false,
      properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute() {
      const e = await engine()
      const st = await e.runUpdateOnce()
      return { ok: true, text: e.moodLine(st, e.loadConfig()) }
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const e = await engine()
        await e.runUpdateOnce()
      } catch { /* LLM key 未配置等错误只影响这一轮；工具与面板仍可用 */ }
    }
    const timer = setInterval(tick, 5 * 60 * 1000)
    setTimeout(tick, 5000)
    return () => { stopped = true; clearInterval(timer) }
  }, 'emotion-state-portrait: timer')

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(emotionStatusTool()),
      ctx.tools.register(emotionTweakTool()),
      ctx.tools.register(emotionUpdateTool()),
    ]
    return () => disposers.forEach((d) => { try { d?.() } catch { /* 忽略 */ } })
  }, 'emotion-state-portrait: tools')
}
