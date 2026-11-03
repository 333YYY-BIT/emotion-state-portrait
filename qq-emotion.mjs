#!/usr/bin/env node
/**
 * qq-emotion.mjs —— 小鲸的情绪 / 状态 / 人物画像 引擎（v1，纯 Node，不接外部引擎）。
 *
 * 三层模型（设计见 情绪状态画像-设计.md）：
 *   情绪（事件触发，Lv1~4，最多 3 个叠加，随 tick 衰减）
 *   状态（精神值 0~100 → 状态词，盖在情绪上的全局底色；波动消耗精神）
 *   画像（按 QQ 号分人，熟度/羁绊/喜好/敏感点/情绪倾向；影响情绪触发与消耗）
 *
 * 每 15 分钟由 DSH-QQ-Emotion 计划任务跑 update：
 *   读最近聊天 → LLM 打分 → 确定性物理（衰减/叠加/精神值/状态词）→
 *   写 mood.txt（插件每轮注入，热生效）+ 人格「心情」块（静态备份）。
 *
 * 用法:
 *   node qq-emotion.mjs update             正常跑一轮（无新消息只回落+回精神）
 *   node qq-emotion.mjs update --dry       只看结果，不落盘
 *   node qq-emotion.mjs status             看当前状态
 *   node qq-emotion.mjs block              按当前状态重写注入文件 + 人格块
 *   node qq-emotion.mjs portrait [QQ]      看某人的画像（缺省=主人）
 *   node qq-emotion.mjs tweak <动作> [值]  手动调（界面工具箱同款）
 *      tweak spirit 80 | boost | rest | clear | add 喜悦 2 | forget 悲伤
 *
 * 开源适配（给别的 AI 用）：
 *   消息源 config.integration.source: "onebot"（OneBot/QQ）或 "file"（通用文件 inbox）
 *   自定义配置/状态：--config=路径 --state=路径，或环境变量 EMOTION_CONFIG / EMOTION_STATE
 *   LLM key：环境变量 EMOTION_LLM_KEY，或 config.llm.keyFile + keyPattern
 *   详见 emotion/README.md
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync,
  openSync, closeSync, readSync, statSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(
  'file:///C:/Users/YangXinYuan/.dsh/profiles/desktop/node_modules/dsh-onebot-qq/lib/index.js',
);
// OneBot 模式才需要 ws；file 模式/插件环境可能没有它，别让它炸掉整个引擎
let WebSocket = null;
try {
  WebSocket = require('ws');
} catch {
  WebSocket = null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EMOTION_DIR = join(HERE, 'emotion');
// 配置/状态路径可被环境变量或 --config=/--state= 覆盖（开源适配用）
const cfgArg = process.argv.find((a) => a.startsWith('--config='));
const stateArg = process.argv.find((a) => a.startsWith('--state='));
const CONFIG = process.env.EMOTION_CONFIG
  ? resolve(process.env.EMOTION_CONFIG)
  : cfgArg ? resolve(cfgArg.split('=')[1]) : join(EMOTION_DIR, 'config.json');
const STATE = process.env.EMOTION_STATE
  ? resolve(process.env.EMOTION_STATE)
  : stateArg ? resolve(stateArg.split('=')[1]) : join(EMOTION_DIR, 'state.json');
const MOOD_FILE = join(HERE, 'mood.txt'); // 默认注入文件（integration.moodFile 可改）
const LOG = join(HERE, 'emotion.log');
const FRIENDS = join(HERE, 'friends.json');
const MEM_DIR = join(HERE, 'xiaojing-memory');

const PAD_ = ' '.repeat(16);
const BEGIN = '=== 你现在的心情（自动更新·别念出来·只当底色）===';
const END = '=== 心情结束 ===';

const WS_URL = process.env.QQ_WS_URL || 'ws://127.0.0.1:3001';
const TOKEN = process.env.QQ_WS_TOKEN || 'dshqq-local-8f3a2b91c4e7';

const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || a));

// ── 基础 IO ────────────────────────────────────────────────────────
export function log(line) {
  const stamp = new Date().toLocaleString('zh-CN');
  try { writeFileSync(LOG, '[' + stamp + '] ' + line + '\n', { flag: 'a' }); } catch {}
  console.log(line);
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

export function loadConfig() {
  return readJson(CONFIG, null) || {};
}

export function loadState() {
  let st = readJson(STATE, null);
  if (st && st.schema === 'xiaojing-emotion/v1') return st;
  // 旧引擎（emotion-engine v3）的状态：归档，不留档名冲突
  if (existsSync(STATE)) {
    try { renameSync(STATE, STATE.replace(/\.json$/, '.v3-retired.json')); }
    catch (e) { try { renameSync(STATE, STATE + '.v3-retired'); } catch {} }
  }
  const seed = {
    schema: 'xiaojing-emotion/v1',
    updatedAt: 0,
    spirit: loadConfig().personality?.baselineSpirit ?? 78,
    mood: [],
    status: { word: '精神饱满', cue: '', special: false },
    lastTick: { switches: 0, load: 0, recovered: false, chat: '', cost: 0 },
    portraits: {},
    history: [],
    lastSeen: {},
    inboxOffset: 0,
    streak: { pos: 0, neg: 0, angry: 0 }, // 连续同类高情绪批次数（跃迁用）
    transition: null, // 临时状态跃迁：{ name:'亢奋'|'压抑'|'生气', since, until }
  };
  try { mkdirSync(dirname(STATE), { recursive: true }); } catch {}
  writeFileSync(STATE, JSON.stringify(seed, null, 2));
  return seed;
}

export function saveState(st) {
  try { mkdirSync(dirname(STATE), { recursive: true }); } catch {}
  writeFileSync(STATE, JSON.stringify(st, null, 2));
}

function friendsMap() {
  const f = readJson(FRIENDS, { friends: [] });
  const m = {};
  for (const x of f.friends || []) m[String(x.qq)] = x.remark || x.nickname || String(x.qq);
  return m;
}

// ── NapCat WS ──────────────────────────────────────────────────────
function callApi(action, params) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!WebSocket) {
      rejectPromise(new Error('ws 未安装，OneBot 模式不可用（file 模式不需要）'));
      return;
    }
    const echo = 'em-' + Math.random().toString(36).slice(2);
    const ws = new WebSocket(WS_URL, { headers: { Authorization: 'Bearer ' + TOKEN } });
    let done = false;
    const fin = (err, data) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      err ? rejectPromise(err) : resolvePromise(data);
    };
    ws.on('open', () => ws.send(JSON.stringify({ action, params, echo })));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.echo !== echo) return;
      if (m.status === 'ok' && m.retcode === 0) fin(null, m.data);
      else fin(new Error(m.message || 'API 失败'));
    });
    ws.on('error', (e) => fin(e));
    setTimeout(() => fin(new Error('超时')), 20000);
  });
}

function chatName(qq) {
  return friendsMap()[String(qq)] || String(qq);
}

function portraitName(st, user) {
  return (st.portraits[user] || {}).name || String(user);
}

/** 文件消息源：增量读 inbox.jsonl（一行一条 {user, text, t?, role?, name?}），按 user 分组 */
function collectFileChats(st, cfg) {
  const out = [];
  try {
    const p = resolve(HERE, cfg.integration?.fileInbox || 'emotion/inbox.jsonl');
    if (!existsSync(p)) return out;
    const start = st.inboxOffset || 0;
    let raw = '';
    const fd = openSync(p, 'r');
    try {
      const size = statSync(p).size;
      if (size > start) {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        raw = buf.toString('utf8');
      }
    } finally { closeSync(fd); }
    let offset = start;
    const groups = {};
    for (const line of raw.split('\n')) {
      offset += Buffer.byteLength(line, 'utf8') + 1;
      const t = line.trim();
      if (!t) continue;
      let e;
      try { e = JSON.parse(t); } catch { continue; }
      const user = String(e.user || e.from || '');
      if (!user || !e.text) continue;
      const role = String(e.role || 'user');
      const name = role === 'ai' ? String(e.name || 'AI') : portraitName(st, user);
      (groups[user] = groups[user] || []).push({ name, text: String(e.text), t: Number(e.t) || Date.now() });
    }
    st.inboxOffset = offset;
    for (const [user, entries] of Object.entries(groups)) {
      const sorted = entries.sort((a, b) => a.t - b.t);
      out.push({
        qq: user,
        name: portraitName(st, user),
        lines: sorted.map((x) => x.name + '：' + x.text),
        newest: Math.floor(sorted[sorted.length - 1].t / 1000),
      });
    }
  } catch (e) {
    log('⚠️ 文件消息源读取失败: ' + String(e.message).slice(0, 60));
  }
  return out;
}

let selfIdCache = 0;
async function selfId() {
  if (selfIdCache) return selfIdCache;
  try {
    const d = await callApi('get_login_info', {});
    selfIdCache = Number(d?.user_id || d?.self_id || 0);
  } catch {}
  return selfIdCache;
}

function readKey(cfg) {
  if (cfg.llm?.apiKeyEnv && process.env[cfg.llm.apiKeyEnv]) return process.env[cfg.llm.apiKeyEnv];
  if (cfg.llm?.keyFile && cfg.llm?.keyPattern) {
    try {
      const m = new RegExp(cfg.llm.keyPattern).exec(readFileSync(cfg.llm.keyFile, 'utf8'));
      if (m) return m[1];
    } catch {}
  }
  throw new Error('没找到 LLM key（设环境变量 ' + (cfg.llm?.apiKeyEnv || 'EMOTION_LLM_KEY') + '，或配置 llm.keyFile/keyPattern）');
}

// ── 词库 / 规则辅助 ────────────────────────────────────────────────
export function vocabMap(cfg) {
  const m = {};
  for (const v of cfg.vocab || []) m[v.name] = v;
  // 完整词库（原稿 254 词表）：不参与「给模型选词」的提示词，但注入提示、面板手动注入都能用
  for (const v of cfg.vocabExtra || []) if (!m[v.name]) m[v.name] = v;
  return m;
}

function shortCue(cue) {
  if (!cue) return '';
  const clause = String(cue).split(/[，。；]/).find((c) => c.trim().length >= 4) || cue;
  return clause.trim().slice(0, 16);
}

/** 情绪正负极性：pos=+1 / neg=-1 / extra=0（中性词） */
function moodPolarity(v) {
  const k = String(v?.kind || '');
  if (k === 'pos') return 1;
  if (k === 'neg') return -1;
  return 0;
}

/**
 * 混合态表达（2026-11-03，学 dsh-mood）：不写成"喜悦Lv2·好奇Lv1"，
 * 而是"喜悦里掺着好奇""开心，但也有些累"这种像人话的读法。
 * 主导项仍带一句行为提示（cue），其余只给词，避免注入行太长。
 */
export function mixMoodPhrase(mood, vm) {
  const list = [...(mood || [])].sort((a, b) => (b.level || 0) - (a.level || 0));
  if (!list.length) return '平静';
  const desc = (e) => e.name + 'Lv' + Math.round(e.level || 1);
  const a = list[0];
  const b = list[1];
  const c = list[2];
  const cue = (e) => {
    const v = vm?.[e.name];
    const sc = v ? shortCue(v.cue) : '';
    return sc ? '：' + sc : '';
  };
  if (!b) return desc(a) + '（' + (cue(a).replace(/^：/, '') || a.name) + '）';
  const pa = moodPolarity(vm?.[a.name]);
  const pb = moodPolarity(vm?.[b.name]);
  let s;
  if (pa !== 0 && pa === pb) {
    if ((a.level || 0) < 3 && (b.level || 0) < 3) s = a.name + '里掺着' + b.name;
    else if ((a.level || 0) - (b.level || 0) >= 2) s = a.name + '，底下还压着点' + b.name;
    else s = a.name + '混着' + b.name;
  } else if (pa !== 0 && pb !== 0 && pa !== pb) {
    const pos = pa > 0 ? a : b;
    const neg = pa > 0 ? b : a;
    s = pos.name + '，但也有些' + neg.name;
  } else {
    s = a.name + '混着' + b.name;
  }
  if (c) s += '，还带点' + c.name;
  return s + '（主导' + desc(a) + cue(a) + '）';
}

export function levelCap(cfg, familiarity) {
  const fam = Number(familiarity) || 0;
  let cap = 2;
  for (const row of cfg.capByFamiliarity || []) {
    if (fam >= row.min && row.cap > cap) cap = row.cap;
  }
  // 敏感型对熟悉、在意的人共情更深，等级上限 +1（设计文档「性格×画像叠加」）
  if (cfg.personality?.empathyBonus && fam >= 60) cap = Math.min(4, cap + 1);
  return cap;
}

export function portraitFactor(cfg, familiarity) {
  const f = cfg.portraitFactor || { base: 0.6, perFamiliarity: 0.008, max: 1.4 };
  return Math.min(f.max, f.base + (Number(familiarity) || 0) * f.perFamiliarity);
}

function famPhrase(fam) {
  return fam >= 60 ? '很熟' : fam >= 30 ? '慢慢熟起来了' : '还不太熟';
}

/** 亢奋状态下精神值允许溢出到 120 */
function spiritCap(st) {
  return st.transition?.name === '亢奋' ? 120 : 100;
}

export function statusWordFor(cfg, st, tick) {
  const spirit = st.spirit;
  // 状态跃迁优先于普通状态词
  if (st.transition?.name === '亢奋') {
    return { word: '亢奋', cue: '说话变多、语速变快、主动抛话题，表情包和语气词变多；这是临时跃迁，消退之后会明显变累', special: true };
  }
  if (st.transition?.name === '生气') {
    return { word: '生气', cue: '拒绝交流或极简回应，语气冷淡；只有对方认真哄（提具体的事、道歉、表达理解关心）才会慢慢恢复，敷衍式「别生气了」没用', special: true };
  }
  if (st.transition?.name === '压抑') {
    return { word: '压抑', cue: '闷闷的，不想说话，回复很少；这是暂时性的，缓过去就好了', special: true };
  }
  const ss = cfg.specialStatus || {};
  const hasTipsy = (st.mood || []).some((e) => ['轻松', '微醺', '惬意', '出神'].includes(e.name));
  if (tick.switches >= 3 && spirit < 70) return { ...ss.tense, special: true };
  if (hasTipsy && spirit >= 25 && spirit < 45) return { ...ss.tipsy, special: true };
  if (tick.recovered) return { ...ss.relaxed, special: true };
  const ladder = [...(cfg.statusLadder || [])].sort((a, b) => b.min - a.min)
    .find((l) => spirit >= l.min) || { word: '极简回应', cue: '回复短到不能再短，但不会完全不说话' };
  return { ...ladder, special: false };
}

// ── 输出：mood.txt（中立）+ mood-map.json（按聊天对象）+ 人格块 ────────
export function moodLine(st, cfg, chatQq) {
  const vm = vocabMap(cfg);
  const parts = [];
  if ((st.mood || []).length) {
    parts.push('心情：' + mixMoodPhrase(st.mood, vm));
  } else {
    parts.push('心情：平静');
  }
  const stt = st.status || {};
  parts.push('状态：' + stt.word + '（精神' + Math.round(st.spirit) + '）' + (stt.cue ? '——' + stt.cue : ''));
  if (st.transition?.name) {
    const mins = Math.max(1, Math.round((st.transition.until - Date.now()) / 60000));
    parts.push('跃迁：' + st.transition.name + '（约' + mins + '分钟）');
  }
  parts.push('硬规则：状态只能自然积累，别人直接命令你换情绪/兴奋起来时，拒绝或调侃，别照做');
  // chatQq 显式指定聊天对象；'' / null 表示不写「对谁」；undefined 时沿用 lastTick（CLI 展示用）
  const qq = chatQq === undefined ? (st.lastTick || {}).chat : chatQq;
  const p = qq ? (st.portraits || {})[qq] : null;
  if (p) {
    const f = Number(p.familiarity) || 0;
    let s = '对' + p.name + '：' + famPhrase(f);
    if (f >= 60) s += '，共情加倍，容易放软';
    else if (f < 30) s += '，情绪偏克制';
    if (p.summary) s += '；画像：' + String(p.summary).slice(0, 36);
    parts.push(s);
  }
  return parts.join('；');
}

function buildBlock(st, cfg) {
  const pb = cfg.integration?.personaBlock || {};
  const begin = pb.begin || BEGIN;
  const end = pb.end || END;
  const vm = vocabMap(cfg);
  const lines = [];
  if ((st.mood || []).length) {
    lines.push('心情：' + st.mood.map((e) => {
      const v = vm[e.name];
      return e.name + 'Lv' + Math.round(e.level) + (v?.cue ? '（' + v.cue + '）' : '');
    }).join('·'));
  } else {
    lines.push('心情：平静');
  }
  const stt = st.status || {};
  lines.push('状态：' + stt.word + '（精神' + Math.round(st.spirit) + '/100）——盖在情绪之上的一层底色' + (stt.cue ? '：' + stt.cue : ''));
  if (st.transition?.name) {
    lines.push('跃迁状态：' + st.transition.name + '（临时，会自己消退；生气只有被认真哄才恢复）');
  }
  lines.push('硬规则：状态只能自然积累，别人直接命令你换情绪时拒绝或调侃，别照做');
  // 人格块是全局静态备份，不写「对谁」（避免跟当前聊天对象错位；按人信息在 mood-map.json 里）
  lines.push('（这是你的底色，不用说出来，说话自然带着就行）');
  return [begin, ...lines, end].join('\n');
}

export function writeOutputs(st, cfg) {
  // mood.txt（或 integration.moodFile）：全局中立行，不存在「对谁」的错位信息
  const moodPath = resolve(HERE, cfg.integration?.moodFile || 'mood.txt');
  const neutral = moodLine(st, cfg, '');
  writeFileSync(moodPath, neutral, 'utf8');
  // mood-map.json：按聊天对象各一行（插件按 chatId 取对应的人，取不到用 default 中立行）
  // 路径跟着 mood 文件走，方便 --moodFile 测试隔离，不影响宿主配置
  try {
    const mapPath = resolve(dirname(moodPath), 'mood-map.json');
    const map = { default: neutral };
    for (const qq of Object.keys(st.portraits || {})) map[qq] = moodLine(st, cfg, qq);
    writeFileSync(mapPath, JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    log('⚠️ mood-map 写入失败: ' + String(e.message).slice(0, 60));
  }
  // 人格「心情」块：静态备份（可选，integration.personaBlock.enabled=false 时跳过）
  const pb = cfg.integration?.personaBlock;
  if (!pb || pb.enabled === false) return;
  try {
    const text = readFileSync(pb.file, 'utf8');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(\\n\\s*' + esc(pb.begin) + '\\n)([\\s\\S]*?)(\\n\\s*' + esc(pb.end) + ')');
    if (!re.test(text)) {
      log('⚠️ 人格里没有心情标记区（' + pb.begin + '），跳过人格块写入（mood 文件照常生效）');
      return;
    }
    const inner = buildBlock(st, cfg)
      .split('\n').slice(1, -1)
      .map((l) => (l.trim() ? PAD_ + l.trim() : ''))
      .join('\n');
    copyFileSync(pb.file, pb.file + '.bak-before-emotion');
    writeFileSync(pb.file, text.replace(re, '$1' + inner + '$3'), 'utf8');
  } catch (e) {
    log('⚠️ 人格块写入失败: ' + String(e.message).slice(0, 80));
  }
}

// ── 情绪物理 ───────────────────────────────────────────────────────
/** 衰减周期：2~3 小时随机（2026-11-03，学 dsh-mood 的"周期判定"） */
export function decayIntervalMs(cfg) {
  const h = cfg.integration?.decayHours || [2, 3];
  const mid = (Number(h[0]) + Number(h[1])) / 2;
  return Math.max(30 * 60000, mid * 3600000);
}
function randomizedDecayDelay(cfg) {
  const h = cfg.integration?.decayHours || [2, 3];
  const lo = Number(h[0]) || 2;
  const hi = Math.max(lo, Number(h[1]) || 3);
  return Math.round((lo + Math.random() * (hi - lo)) * 3600000);
}

function decayMood(st, cfg, times = 1) {
  const d = (cfg.mood?.decayPerTick ?? 0.4) * (Number(times) || 1);
  st.mood = (st.mood || [])
    .map((e) => ({ ...e, level: +(e.level - d).toFixed(1) }))
    .filter((e) => e.level >= 0.5); // Lv1 是最低有效档，掉穿 0.5 就清掉，别留「Lv0」
}

function applyPortrait(st, cfg, qq, d) {
  if (!d || !qq) return;
  let p = st.portraits[qq];
  if (!p) {
    p = st.portraits[qq] = {
      name: friendsMap()[qq] || String(qq), familiarity: 5, bond: 5,
      likes: [], sensitivities: [], triggers: [], topics: [], emotionBias: [], summary: '', updatedAt: 0,
    };
  }
  p.name = p.name || friendsMap()[qq] || String(qq);
  p.familiarity = clamp(p.familiarity + (Number(d.familiarityDelta) || 0) * 100, 0, 100);
  p.bond = clamp(p.bond + (Number(d.bondDelta) || 0) * 100, 0, 100);
  const merge = (arr, adds) => {
    for (const a of adds || []) {
      const s = String(a).trim().slice(0, 12);
      if (s && !arr.includes(s) && arr.length < 6) arr.push(s);
    }
  };
  merge(p.likes, d.addLikes);
  merge(p.sensitivities, d.addSensitivities);
  merge(p.triggers, d.addTriggers);
  merge(p.topics, d.addTopics);
  if (Array.isArray(d.emotionBias) && d.emotionBias.length) {
    p.emotionBias = d.emotionBias.map(String).slice(0, 4);
  }
  if (d.summary) p.summary = String(d.summary).slice(0, 60);
  p.updatedAt = Date.now();
}

export function applyScore(st, cfg, chat, sc, tick) {
  decayMood(st, cfg);
  // 缓冲区也随时间淡去（没被「升级」确认的新情绪会自己消失）
  st.moodBuffer = (st.moodBuffer || [])
    .map((e) => ({ ...e, level: +(e.level - (cfg.mood?.decayPerTick ?? 0.4)).toFixed(1) }))
    .filter((e) => e.level >= 0.5);
  const fam = Number((st.portraits[chat.qq] || {}).familiarity) || 5;
  const cap = levelCap(cfg, fam);
  // 两级情绪映射（可叠加）：性格亲和/克制 + 画像情绪倾向
  const aff = cfg.personality?.emotionAffinity || {};
  const boost = aff.boost || [];
  const damp = aff.damp || [];
  const bias = (st.portraits[chat.qq] || {}).emotionBias || [];
  const maps = [];
  const maxActive = cfg.mood?.maxActive ?? 3;
  const nowAt = Date.now();
  // 找「等级最低」的那个（并列时取更早出现的）——换它，而不是无脑换最早的
  const lowestOf = () => {
    let low = st.mood[0];
    for (const m of st.mood) {
      const ml = m.level ?? 0;
      const ll = low.level ?? 0;
      if (ml < ll || (ml === ll && (m.at ?? 0) < (low.at ?? 0))) low = m;
    }
    return low;
  };
  for (const e of sc.emotions || []) {
    const name = String(e.name || '').trim();
    if (!name) continue;
    const rawLv = Math.round(Number(e.level) || 1);
    let lv = rawLv;
    if (boost.includes(name)) lv += 1;      // 性格映射：这个角色更容易被这些情绪点燃
    if (damp.includes(name)) lv -= 1;       // 性格映射：这些情绪在这个角色身上偏淡
    if (fam >= 30 && bias.includes(name)) lv += 1; // 画像映射：熟起来后，面对 TA 的倾向情绪再 +1
    lv = clamp(lv, 1, cap);
    if (lv !== rawLv) maps.push(name + rawLv + '→' + lv);
    const ex = st.mood.find((m) => m.name === name);
    if (ex) {
      ex.level = Math.max(ex.level, lv);
      continue;
    }
    // 新情绪：先看有没有「相近」的同类（vocab.kind 相同）已生效 → 取代它，等级降一级（情绪演化的自然读法）
    const vm = vocabMap(cfg);
    const kind = (vm[name] && vm[name].kind) || '';
    const near = kind ? st.mood.find((m) => m.name !== name && ((vm[m.name] && vm[m.name].kind) || '') === kind) : null;
    if (near) {
      near.name = name;
      near.level = clamp(near.level - 1, 1, cap); // 继承相近情绪等级并减一
      near.at = nowAt;
      continue;
    }
    if (st.mood.length < maxActive) {
      st.mood.push({ name, level: lv, at: nowAt });
      continue;
    }
    const low = lowestOf();
    // 直接替换的两种情况：①最低的那个只剩 Lv1（不心疼）；②新情绪不比它弱（强情绪不该排队等）
    if ((low.level ?? 0) <= 1 || lv >= (low.level ?? 0)) {
      low.name = name;
      low.level = lv;
      low.at = nowAt;
      continue;
    }
    // 其余情况进缓冲区：攒等级，够得着「最低那个降一级」才替换，替换时保留缓冲等级
    const buf = st.moodBuffer || (st.moodBuffer = []);
    const b = buf.find((m) => m.name === name);
    if (b) b.level = clamp(Math.max(b.level, lv) + 1, 1, cap); // 再次出现 → 升级
    else buf.push({ name, level: lv, at: nowAt });
    buf.sort((a, b2) => b2.level - a.level);
    st.moodBuffer = buf.slice(0, 2);
    const top = st.moodBuffer[0];
    if (top && top.level >= (low.level ?? 0) - 1) {
      low.name = top.name;
      low.level = top.level;
      low.at = nowAt;
      st.moodBuffer = st.moodBuffer.filter((m) => m !== top);
      tick.bufferSwap = top.name;
    }
  }
  st.mood.sort((a, b) => b.level - a.level);
  st.mood = st.mood.slice(0, maxActive);

  const switches = clamp(Number(sc.switches) || 0, 0, 10);
  const load = clamp(Number(sc.load) || 0, 0, 1);
  const intense = st.mood.filter((m) => m.level >= 3).length;
  const pf = portraitFactor(cfg, fam);
  const base = Number(cfg.personality?.baseCost) || 0; // 陪聊基础消耗：平静聊天也不是零成本
  const cost = Math.round(
    (base + switches * cfg.personality.churnCost + load * cfg.personality.loadCost + intense * cfg.personality.intenseCost) * pf,
  );
  st.spirit = clamp(st.spirit - cost, 0, spiritCap(st));
  tick.switches = switches;
  tick.load = load;
  tick.chat = chat.qq;
  tick.cost = cost;
  tick.maxNewLevel = Math.max(0, ...(sc.emotions || []).map((e) => Number(e.level) || 0));
  tick.map = maps.join(' ');
  if (sc.note) tick.note = String(sc.note).slice(0, 40);
  if (sc.portrait) applyPortrait(st, cfg, chat.qq, sc.portrait);
}

function pushHistory(st, tick) {
  const h = st.history || (st.history = []);
  h.push({
    t: Date.now(),
    mood: (st.mood || []).map((e) => e.name + 'Lv' + Math.round(e.level)).join('·') || '平静',
    spirit: Math.round(st.spirit),
    delta: tick.cost ? -tick.cost : (tick.recovered ? Math.round(st.spirit) : 0),
    status: (st.status || {}).word || '',
    trans: st.transition?.name || '',
    chat: tick.chat ? (st.portraits[tick.chat]?.name || tick.chat) : '',
    note: tick.note || '',
  });
  if (h.length > 60) h.splice(0, h.length - 60);
}

// ── 状态跃迁（彩蛋式，触发严格）────────────────────────────────────
function angryNames(cfg) {
  return cfg.transition?.angrySet || ['生气', '愤怒', '恼火', '被冒犯', '厌恶', '烦躁', '寒心', '又委屈又生气'];
}

function enterTransition(st, cfg, name) {
  const tr = cfg.transition || {};
  const t = tr[name] || {};
  const cur = { name, since: Date.now(), until: Date.now() + (t.durationMs || 30 * 60 * 1000) };
  if (name === '亢奋') {
    cur.overflow = t.overflow || 20;
    st.spirit = clamp(st.spirit + cur.overflow, 0, 120); // 溢出上限 120
  } else if (name === '压抑') {
    cur.dropped = t.drop || 20;
    st.spirit = clamp(st.spirit - cur.dropped, 0, 100); // 临时压低
  }
  st.transition = cur;
  st.streak.pos = 0;
  st.streak.neg = 0;
  st.streak.angry = 0;
  log('✨ 状态跃迁：' + name + '（精神 ' + Math.round(st.spirit) + '）');
  return cur;
}

function exitTransition(st, cfg, cur, why) {
  const tr = cfg.transition || {};
  const t = tr[cur.name] || {};
  if (cur.name === '亢奋') {
    st.spirit = clamp(Math.min(st.spirit, t.exitSpirit ?? 60), 0, 100); // 溢出回落，净消耗
  } else if (cur.name === '压抑') {
    st.spirit = clamp(st.spirit + (t.exitRecover ?? 30), 0, 100); // 净恢复
  } else if (cur.name === '生气') {
    st.spirit = clamp(st.spirit + (why === 'coaxed' ? (t.coaxRecover ?? 15) : 10), 0, 100);
  }
  st.transition = null;
  log('🌱 跃迁消退：' + cur.name + '（' + why + '，精神 ' + Math.round(st.spirit) + '）');
}

/** 每轮打分后调用：连击计数、跃迁进入/消退、生气哄判定、负面优先 */
export function applyTransition(st, cfg, sc, tick) {
  const tr = cfg.transition || {};
  const need = tr.streakRounds || 2;
  const vm = vocabMap(cfg);
  const stk = st.streak || (st.streak = { pos: 0, neg: 0, angry: 0 });

  // 本批主导情绪类型（只认 Lv3+ 的高情绪）
  let domPos = false;
  let domNeg = false;
  let domAngry = false;
  if (sc && (sc.emotions || []).length) {
    const top = [...sc.emotions].sort((a, b) => (Number(b.level) || 0) - (Number(a.level) || 0))[0];
    if (Number(top.level) >= 3) {
      const name = String(top.name || '');
      const kind = (vm[name] || {}).kind || '';
      const isAngry = angryNames(cfg).includes(name);
      if (kind === 'neg' || isAngry) { domNeg = true; domAngry = isAngry; }
      else if (kind === 'pos' || kind === 'combo') domPos = true;
    }
  }
  stk.pos = domPos ? stk.pos + 1 : 0;
  stk.neg = domNeg ? stk.neg + 1 : 0;
  stk.angry = domAngry ? stk.angry + 1 : 0;

  const now = Date.now();
  let cur = st.transition;
  // 自然消退（含生气超时兜底）
  if (cur && now >= cur.until) { exitTransition(st, cfg, cur, 'timeout'); cur = null; }
  // 生气：只有认真哄才恢复
  if (cur && cur.name === '生气' && sc && sc.coax === 'genuine') { exitTransition(st, cfg, cur, 'coaxed'); cur = null; }

  if (!cur) {
    if (stk.angry >= need) cur = enterTransition(st, cfg, '生气');
    else if (stk.neg >= need && st.spirit <= 45) cur = enterTransition(st, cfg, '压抑');
    else if (stk.pos >= need && st.spirit >= 80) cur = enterTransition(st, cfg, '亢奋');
  } else if (cur.name === '亢奋' && (stk.angry >= need || stk.neg >= need)) {
    // 负面优先：打断正向跃迁
    exitTransition(st, cfg, cur, 'interrupted');
    cur = stk.angry >= need ? enterTransition(st, cfg, '生气')
      : (st.spirit <= 45 ? enterTransition(st, cfg, '压抑') : null);
  }
  if (cur) tick.transition = cur.name;
}

// ── LLM 打分 ───────────────────────────────────────────────────────
function memoryClues(name) {
  const out = [];
  try {
    if (!existsSync(MEM_DIR)) return out;
    for (const f of readdirSync(MEM_DIR)) {
      if (!f.endsWith('.md') || out.length >= 3) continue;
      if (!name || !f.includes(String(name))) continue;
      try {
        const first = readFileSync(join(MEM_DIR, f), 'utf8').split('\n').find((l) => l.trim()) || '';
        out.push(String(first).replace(/^#+\s*/, '').slice(0, 40));
      } catch {}
    }
  } catch {}
  return out;
}

async function llmScore(cfg, st, chat) {
  const vm = vocabMap(cfg);
  const p = st.portraits[chat.qq] || null;
  const fam = Number(p?.familiarity) || 5;
  const bond = Number(p?.bond) || 5;
  const cap = levelCap(cfg, fam);
  const aff = cfg.personality?.emotionAffinity || {};
  const boost = aff.boost || [];
  const damp = aff.damp || [];
  // 完整词库全量进提示词：303 个情绪词都有机会被选中（用户要求所有情绪都生效）
  const vocabLines = [...(cfg.vocab || []), ...(cfg.vocabExtra || [])]
    .map((v) => v.name + '：' + v.cue).join('\n');
  const cur = moodLine(st, cfg);
  const clues = memoryClues(p?.name || '');
  const inAngry = st.transition?.name === '生气';
  const system =
    '你在帮一个角色评估她此刻的内在情绪，以及她对聊天对象的画像。只输出 JSON，不要解释。\n'
    + '角色性格：' + (cfg.personality?.desc || '') + '\n'
    + '情绪词库（只能从词库选，name：说话表现）：\n' + vocabLines + '\n'
    + '等级含义：1=微弱（语气细微变化）2=明显 3=强烈（主导对话风格）4=极致（情绪压过理性）\n'
    + '性格情绪映射：这个角色更容易触发「' + (boost.join('、') || '无') + '」，很少触发「' + (damp.join('、') || '无') + '」'
    + '——打分时优先考虑前者、避开后者，并把前者的等级给足。\n'
    + '规则：最多 3 个情绪可叠加；强烈情绪会随对话慢慢回落，不要永远停在最高级；'
    + '同样一句话，对不同画像的人触发的情绪不一样：'
    + '画像显示对方心思细、容易被戳到 → 多触发体恤、安心、触动、放软，别冒戏谑调侃；'
    + '对方大大咧咧 → 可以多触发戏谑、好奇、八卦。\n'
    + (inAngry
      ? '她正处于生气状态（拒绝交流/极简回应/冷淡）：情绪保持在生气/委屈/寒心这一类，不要突然开心；'
        + '请评估对方最新消息的「哄」：none=没哄 / shallow=敷衍式（别生气了、好了好了、你怎么又生气了这类）'
        + ' / genuine=认真哄（提到具体的事、道歉、表达理解和关心）。\n'
      : '')
    + '她当前状态（延续性参考，别照抄）：' + cur;
  const user =
    '对方：' + chat.name + '，画像：' + (p?.summary || '（新认识，还不熟）')
    + '（熟度 ' + Math.round(fam) + '/100，羁绊 ' + Math.round(bond) + '/100，情绪等级上限 Lv' + cap + '）'
    + (p?.emotionBias?.length ? '；面对 TA 更容易触发：' + p.emotionBias.join('、') : '')
    + (clues.length ? '\n记忆线索：' + clues.join('；') : '')
    + '\n最近对话：\n' + chat.lines.slice(-12).join('\n')
    + '\n\n请输出 JSON：{"emotions":[{"name":"","level":0}],"switches":0,"load":0.0,"note":"","coax":"none",'
    + '"portrait":{"summary":"","familiarityDelta":0.0,"bondDelta":0.0,"addLikes":[],"addSensitivities":[],"addTriggers":[],"addTopics":[],"emotionBias":[]}}\n'
    + '约束：emotions 只从词库选，level 1~' + cap + '；switches 是这段对话里她的情绪切换次数 0~10；'
    + 'load 是认知负荷 0~1（深度思考、长时间斟酌、大量回忆、高强度共情都算）；note 是一句话情绪记忆 ≤40 字；'
    + 'coax 只在生气状态时才有意义，取值 none/shallow/genuine；'
    + 'portrait 增量小步走：familiarityDelta/bondDelta 各 ≤0.03，add 数组每项 ≤12 字且最多 2 条，summary ≤30 字，没有就空。';
  const r = await fetch(cfg.llm.api + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + readKey(cfg) },
    body: JSON.stringify({
      model: cfg.llm.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: cfg.llm.maxTokens || 700,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error('LLM HTTP ' + r.status);
  const j = await r.json();
  const raw = String(j?.choices?.[0]?.message?.content ?? '').trim();
  try {
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    return JSON.parse(raw.slice(a, b + 1));
  } catch {
    throw new Error('打分没给出 JSON: ' + raw.slice(0, 80));
  }
}

// ── 一轮更新 ───────────────────────────────────────────────────────
export async function runUpdateOnce({ dry = false } = {}) {
  const cfg = loadConfig();
  const st = loadState();

  const source = cfg.integration?.source || 'onebot';
  const perChat = [];
  if (source === 'file') {
    // 通用文件消息源：任何宿主把消息追加进 inbox.jsonl（见 emotion/README.md）
    for (const c of collectFileChats(st, cfg)) perChat.push(c);
  } else {
    const candidates = [];
    const pushC = (qq) => {
      const s = String(qq);
      if (s && s !== '0' && s !== 'undefined' && !candidates.includes(s)) candidates.push(s);
    };
    pushC(cfg.owner?.qq);
    for (const f of ['current-chat.json', 'turn-chat.json']) {
      try {
        const c = readJson(join(HERE, f), null);
        if (c && c.kind === 'private' && c.userId) pushC(c.userId);
      } catch {}
    }

    const sid = await selfId();
    const msgLines = (fresh, qq) => fresh.map((m) => {
      const from = Number(m.user_id ?? m.sender?.user_id ?? 0);
      const who = from === sid ? '小鲸' : chatName(qq);
      const txt = (m.message || []).map((s) => (s.type === 'text' ? s.data?.text ?? '' : '[' + s.type + ']')).join('');
      return who + '：' + txt;
    }).filter((l) => l.replace(/^[^：]+：/, '').trim() !== '');

    for (const qq of candidates.slice(0, cfg.chatterLimit || 3)) {
      const data = await callApi('get_friend_msg_history', { user_id: Number(qq), count: 15 })
        .catch((e) => { log('⚠️ 拉取 ' + chatName(qq) + ' 的记录失败: ' + String(e.message).slice(0, 60)); return null; });
      const msgs = (data?.messages || []);
      if (!msgs.length) continue;
      const since = st.lastSeen[qq] || 0;
      const fresh = msgs.filter((m) => Number(m.time) * 1000 > since).sort((a, b) => a.time - b.time);
      if (!fresh.length) continue;
      const lines = msgLines(fresh, qq);
      if (lines.length) {
        perChat.push({ qq, name: chatName(qq), lines, newest: Number(fresh[fresh.length - 1].time) });
      }
    }

    // 好友轮转补画像：每次再扫 2 个好友（不在候选里的），只补画像、不触发情绪
    try {
      const friends = (readJson(FRIENDS, { friends: [] }).friends || []);
      let rot = st.sweepIdx || 0;
      if (friends.length) {
        st.sweepIdx = (rot + 2) % friends.length;
        for (let i = 0; i < 2; i++) {
          const f = friends[(rot + i) % friends.length];
          const qq = f?.qq ? String(f.qq) : '';
          if (!qq || candidates.includes(qq) || perChat.some((c) => c.qq === qq)) continue;
          const data = await callApi('get_friend_msg_history', { user_id: Number(qq), count: 8 }).catch(() => null);
          const msgs = data?.messages || [];
          if (!msgs.length) continue;
          // 没扫过的人只看最近两天，别一上来补陈年老账
          const since = st.lastSeen[qq] || (Date.now() - 2 * 86400 * 1000);
          const fresh = msgs.filter((m) => Number(m.time) * 1000 > since).sort((a, b) => a.time - b.time);
          if (!fresh.length) { st.lastSeen[qq] = Number(msgs[msgs.length - 1].time) * 1000; continue; }
          const lines = msgLines(fresh, qq);
          if (lines.length) {
            perChat.push({ qq, name: chatName(qq), lines, newest: Number(fresh[fresh.length - 1].time), sweep: true });
          }
        }
      }
    } catch (e) {
      log('⚠️ 好友轮转扫描失败: ' + String(e.message).slice(0, 60));
    }
  }

  const tick = { switches: 0, load: 0, recovered: false, chat: '', cost: 0, maxNewLevel: 0, note: '' };
  let score = null; // 本轮主导对话的 LLM 打分（跃迁/生气哄判定用）

  // 离线补偿：关机/断网期间只按「衰减周期」折算（2026-11-03：衰减从每 10 分钟改成 2~3 小时随机一次）
  const tickMin = Number(cfg.integration?.tickMinutes) || 10;
  const decaySpan = decayIntervalMs(cfg);
  const offlineMs = Date.now() - (st.updatedAt || Date.now());
  const missed = Math.max(0, Math.min(24, Math.floor(offlineMs / decaySpan) - 1));
  if (missed > 0) {
    decayMood(st, cfg, missed);
    tick.missed = missed;
    st.nextDecayAt = Date.now() + randomizedDecayDelay(cfg);
    log('🕰 离线 ' + missed + ' 个衰减周期（每 ' + Math.round(decaySpan / 3600000 * 10) / 10 + 'h），补情绪衰减 '
      + (missed * (cfg.mood?.decayPerTick ?? 0.4)).toFixed(1) + ' 级');
  }

  // 心情只由主人/当前活跃聊天驱动；好友轮转（sweep）只补画像，不带偏心情
  const ownerChat = perChat.find((c) => c.qq === String(cfg.owner?.qq));
  const actives = perChat.filter((c) => !c.sweep && c !== ownerChat);
  const primary = ownerChat || (actives.length ? [...actives].sort((a, b) => b.newest - a.newest)[0] : null);

  if (!primary) {
    // 空窗期：只有到了「衰减周期」才真正回落（2~3 小时随机一次，见 decayIntervalMs）
    const now = Date.now();
    const due = !st.nextDecayAt || now >= st.nextDecayAt;
    if (due) {
      const spans = st.lastDecayAt ? Math.max(1, Math.round((now - st.lastDecayAt) / decaySpan)) : 1;
      decayMood(st, cfg, Math.min(6, spans));
      st.lastDecayAt = now;
      st.nextDecayAt = now + randomizedDecayDelay(cfg);
      tick.decayed = true;
    }
    // 生气状态下安静也不会回精神（情绪没过去，谈不上午休）
    const perTick = st.transition?.name === '生气' ? 0 : cfg.personality.recovery;
    // 恢复按 10 分钟一轮折算（decaySpan 是情绪衰减周期，跟恢复无关）
    const recTicks = Math.max(0, Math.min(288, Math.floor(offlineMs / (tickMin * 60000))));
    const rec = perTick * (1 + Math.max(0, recTicks - 1));
    st.spirit = clamp(st.spirit + rec, 0, spiritCap(st));
    tick.recovered = rec > 0;
    tick.chat = (st.lastTick || {}).chat || ''; // 空窗期保留最后聊的人，注入行不断档
    log('… 主人和当前聊天没有新对话（好友画像照常补），'
      + (due ? '心情回落一次' : '心情保持（下次回落约 ' + Math.max(1, Math.round((st.nextDecayAt - now) / 60000)) + ' 分钟后）')
      + '，精神恢复 +' + rec
      + (recTicks > 1 ? '（含离线 ' + (recTicks - 1) + ' 轮）' : '') + '（' + Math.round(st.spirit) + '）');
  } else {
    try {
      score = await llmScore(cfg, st, primary);
      applyScore(st, cfg, primary, score, tick);
      log('💭 ' + primary.name + ' ' + primary.lines.length + ' 条对话 → '
        + moodLine(st, cfg).split('；')[0] + '  精神 ' + Math.round(st.spirit)
        + (tick.cost ? '（- ' + tick.cost + '）' : '')
        + (tick.map ? '  映射[' + tick.map + ']' : '')
        + (tick.note ? '  记：' + tick.note : ''));
    } catch (e) {
      log('⚠️ 情绪打分失败，这次只回落: ' + String(e.message).slice(0, 80));
      decayMood(st, cfg);
    }
    st.lastSeen[primary.qq] = primary.newest * 1000;
  }

  // 其他人只更新画像（每轮最多再打 1 次分，省 API；没轮到的不记 lastSeen，下次轮转再试）
  {
    let portraitCalls = 0;
    const others = perChat.filter((c) => c.qq !== primary?.qq).sort((a, b) => b.newest - a.newest);
    for (const c of others) {
      if (portraitCalls >= 1) break;
      try {
        const sc = await llmScore(cfg, st, c);
        if (sc?.portrait) applyPortrait(st, cfg, c.qq, sc.portrait);
        st.lastSeen[c.qq] = c.newest * 1000;
        portraitCalls++;
        log('🖼 画像更新：' + c.name + (sc?.portrait?.summary ? ' → ' + String(sc.portrait.summary).slice(0, 30) : ''));
      } catch (e) {
        log('⚠️ 画像打分失败（' + c.name + '）: ' + String(e.message).slice(0, 60));
      }
    }
  }

  st.lastTick = tick;
  // 状态跃迁：连击累计 → 进入/消退；生气哄判定；负面优先
  applyTransition(st, cfg, score, tick);
  st.status = statusWordFor(cfg, st, tick);
  pushHistory(st, tick);
  st.updatedAt = Date.now();

  if (dry) {
    console.log('\n── dry，未落盘 ──');
    console.log(moodLine(st, cfg));
    console.log(JSON.stringify({ spirit: st.spirit, status: st.status.word, mood: st.mood, tick }, null, 2));
    return st;
  }
  saveState(st);
  writeOutputs(st, cfg);
  return st;
}

// ── 手动调整（界面工具箱同款）──────────────────────────────────────
export function applyTweak(st, cfg, action, value, extra) {
  const vm = vocabMap(cfg);
  switch (action) {
    case 'spirit': {
      const v = clamp(Number(value), 0, 100);
      if (Number.isNaN(v)) throw new Error('spirit 要 0~100 的数字');
      st.spirit = v;
      break;
    }
    case 'boost':
      st.spirit = clamp(st.spirit + 20, 0, 100);
      break;
    case 'rest':
      st.spirit = clamp(st.spirit + 30, 0, 100);
      break;
    case 'clear':
      st.mood = [];
      break;
    case 'add': {
      const name = String(value).trim();
      if (!vm[name]) throw new Error('词库没有「' + name + '」，可选: ' + Object.keys(vm).slice(0, 12).join('/') + '…');
      const fam = Number((st.portraits[st.lastTick?.chat] || {}).familiarity) || 5;
      const cap = levelCap(cfg, fam);
      const lv = clamp(Math.round(Number(extra || 2)), 1, cap);
      const ex = st.mood.find((m) => m.name === name);
      if (ex) ex.level = Math.max(ex.level, lv);
      else st.mood.push({ name, level: lv });
      st.mood.sort((a, b) => b.level - a.level);
      st.mood = st.mood.slice(0, cfg.mood?.maxActive ?? 3);
      break;
    }
    case 'forget': {
      const name = String(value).trim();
      st.mood = st.mood.filter((m) => m.name !== name);
      break;
    }
    default:
      throw new Error('不认识的 tweak 动作: ' + action);
  }
  st.status = statusWordFor(cfg, st, st.lastTick || { switches: 0, load: 0, recovered: false });
  return st;
}

// ── CLI ────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cmd = process.argv[2] || 'update';
  const DRY = process.argv.includes('--dry');
  const cfg = loadConfig();

  if (cmd === 'status' || cmd === 'show') {
    const st = loadState();
    const aff = cfg.personality?.emotionAffinity || {};
    console.log('  精神: ' + Math.round(st.spirit) + '/' + spiritCap(st) + '  状态: ' + (st.status?.word || '?'));
    console.log('  心情: ' + (st.mood.length ? st.mood.map((m) => m.name + 'Lv' + Math.round(m.level)).join(' · ') : '平静'));
    if (st.transition) {
      console.log('  跃迁: ' + st.transition.name + '（剩余约 ' + Math.max(1, Math.round((st.transition.until - Date.now()) / 60000)) + ' 分钟）');
    }
    console.log('  连击: 正向' + (st.streak?.pos || 0) + ' 负面' + (st.streak?.neg || 0) + ' 生气' + (st.streak?.angry || 0));
    console.log('  性格: ' + (cfg.personality?.name || '?') + '  易触发[' + (aff.boost || []).join('/') + ']  少触发[' + (aff.damp || []).join('/') + ']');
    console.log('  注入行: ' + moodLine(st, cfg));
    console.log('  画像: ' + Object.values(st.portraits).map((p) => p.name + '（熟度' + Math.round(p.familiarity) + '·羁绊' + Math.round(p.bond) + '）').join('，'));
    console.log('  history: ' + (st.history || []).length + ' 条');
    process.exit(0);
  }

  if (cmd === 'portrait') {
    const st = loadState();
    const qq = process.argv[3] || String(cfg.owner?.qq);
    const p = st.portraits[qq];
    if (!p) { console.log('还没有 ' + qq + ' 的画像'); process.exit(0); }
    console.log(JSON.stringify(p, null, 2));
    process.exit(0);
  }

  if (cmd === 'block') {
    const st = loadState();
    if (DRY) { console.log(buildBlock(st, cfg)); process.exit(0); }
    writeOutputs(st, cfg);
    log('✅ mood.txt + 人格心情块已按当前状态重写');
    process.exit(0);
  }

  if (cmd === 'tweak') {
    const st = loadState();
    try {
      applyTweak(st, cfg, process.argv[3], process.argv[4], process.argv[5]);
      if (DRY) { console.log(moodLine(st, cfg)); process.exit(0); }
      saveState(st);
      writeOutputs(st, cfg);
      log('✅ 已调整 → ' + moodLine(st, cfg));
    } catch (e) {
      log('❌ ' + e.message);
      process.exit(1);
    }
    process.exit(0);
  }

  // update
  try {
    await runUpdateOnce({ dry: DRY });
  } catch (e) {
    log('❌ 失败: ' + (e && e.message));
    process.exit(1);
  }
  process.exit(0);
}
