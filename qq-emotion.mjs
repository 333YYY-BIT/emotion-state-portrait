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
const WebSocket = require('ws');

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

export function statusWordFor(cfg, st, tick) {
  const spirit = st.spirit;
  const ss = cfg.specialStatus || {};
  const hasTipsy = (st.mood || []).some((e) => ['轻松', '微醺', '惬意', '出神'].includes(e.name));
  if (tick.switches >= 2 && tick.maxNewLevel >= 3 && spirit >= 80) return { ...ss.excited, special: true };
  if (tick.switches >= 3 && spirit < 70) return { ...ss.tense, special: true };
  if (hasTipsy && spirit >= 25 && spirit < 45) return { ...ss.tipsy, special: true };
  if (tick.recovered) return { ...ss.relaxed, special: true };
  const ladder = [...(cfg.statusLadder || [])].sort((a, b) => b.min - a.min)
    .find((l) => spirit >= l.min) || { word: '恍惚出神', cue: '' };
  return { ...ladder, special: false };
}

// ── 输出：mood.txt + 人格块 ────────────────────────────────────────
export function moodLine(st, cfg) {
  const vm = vocabMap(cfg);
  const parts = [];
  if ((st.mood || []).length) {
    parts.push('心情：' + st.mood.map((e) => {
      const v = vm[e.name];
      const sc = v ? shortCue(v.cue) : '';
      return e.name + 'Lv' + Math.round(e.level) + (sc ? '（' + sc + '）' : '');
    }).join('·'));
  } else {
    parts.push('心情：平静');
  }
  const stt = st.status || {};
  parts.push('状态：' + stt.word + '（精神' + Math.round(st.spirit) + '）' + (stt.cue ? '——' + stt.cue : ''));
  const qq = (st.lastTick || {}).chat;
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
  const qq = (st.lastTick || {}).chat;
  const p = qq ? (st.portraits || {})[qq] : null;
  if (p) {
    lines.push('对' + p.name + '：' + famPhrase(Number(p.familiarity) || 0)
      + '（熟度' + Math.round(Number(p.familiarity) || 0) + '·羁绊' + Math.round(Number(p.bond) || 0) + '）'
      + (p.summary ? '；画像：' + String(p.summary).slice(0, 48) : ''));
  }
  lines.push('（这是你的底色，不用说出来，说话自然带着就行）');
  return [begin, ...lines, end].join('\n');
}

export function writeOutputs(st, cfg) {
  // mood.txt（或 integration.moodFile）：宿主每轮读它注入，热生效
  const moodPath = resolve(HERE, cfg.integration?.moodFile || 'mood.txt');
  writeFileSync(moodPath, moodLine(st, cfg), 'utf8');
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
function decayMood(st, cfg) {
  st.mood = (st.mood || [])
    .map((e) => ({ ...e, level: +(e.level - (cfg.mood?.decayPerTick ?? 0.4)).toFixed(1) }))
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

function applyScore(st, cfg, chat, sc, tick) {
  decayMood(st, cfg);
  const fam = Number((st.portraits[chat.qq] || {}).familiarity) || 5;
  const cap = levelCap(cfg, fam);
  // 两级情绪映射（可叠加）：性格亲和/克制 + 画像情绪倾向
  const aff = cfg.personality?.emotionAffinity || {};
  const boost = aff.boost || [];
  const damp = aff.damp || [];
  const bias = (st.portraits[chat.qq] || {}).emotionBias || [];
  const maps = [];
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
    if (ex) ex.level = Math.max(ex.level, lv);
    else st.mood.push({ name, level: lv });
  }
  st.mood.sort((a, b) => b.level - a.level);
  st.mood = st.mood.slice(0, cfg.mood?.maxActive ?? 3);

  const switches = clamp(Number(sc.switches) || 0, 0, 10);
  const load = clamp(Number(sc.load) || 0, 0, 1);
  const intense = st.mood.filter((m) => m.level >= 3).length;
  const pf = portraitFactor(cfg, fam);
  const cost = Math.round(
    (switches * cfg.personality.churnCost + load * cfg.personality.loadCost + intense * cfg.personality.intenseCost) * pf,
  );
  st.spirit = clamp(st.spirit - cost, 0, 100);
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
    chat: tick.chat ? (st.portraits[tick.chat]?.name || tick.chat) : '',
    note: tick.note || '',
  });
  if (h.length > 60) h.splice(0, h.length - 60);
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
  const vocabLines = (cfg.vocab || []).map((v) => v.name + '：' + v.cue).join('\n');
  const cur = moodLine(st, cfg);
  const clues = memoryClues(p?.name || '');
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
    + '她当前状态（延续性参考，别照抄）：' + cur;
  const user =
    '对方：' + chat.name + '，画像：' + (p?.summary || '（新认识，还不熟）')
    + '（熟度 ' + Math.round(fam) + '/100，羁绊 ' + Math.round(bond) + '/100，情绪等级上限 Lv' + cap + '）'
    + (p?.emotionBias?.length ? '；面对 TA 更容易触发：' + p.emotionBias.join('、') : '')
    + (clues.length ? '\n记忆线索：' + clues.join('；') : '')
    + '\n最近对话：\n' + chat.lines.slice(-12).join('\n')
    + '\n\n请输出 JSON：{"emotions":[{"name":"","level":0}],"switches":0,"load":0.0,"note":"",'
    + '"portrait":{"summary":"","familiarityDelta":0.0,"bondDelta":0.0,"addLikes":[],"addSensitivities":[],"addTriggers":[],"addTopics":[],"emotionBias":[]}}\n'
    + '约束：emotions 只从词库选，level 1~' + cap + '；switches 是这段对话里她的情绪切换次数 0~10；'
    + 'load 是认知负荷 0~1（深度思考、长时间斟酌、大量回忆、高强度共情都算）；note 是一句话情绪记忆 ≤40 字；'
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

  // 心情只由主人/当前活跃聊天驱动；好友轮转（sweep）只补画像，不带偏心情
  const ownerChat = perChat.find((c) => c.qq === String(cfg.owner?.qq));
  const actives = perChat.filter((c) => !c.sweep && c !== ownerChat);
  const primary = ownerChat || (actives.length ? [...actives].sort((a, b) => b.newest - a.newest)[0] : null);

  if (!primary) {
    decayMood(st, cfg);
    st.spirit = clamp(st.spirit + cfg.personality.recovery, 0, 100);
    tick.recovered = true;
    tick.chat = (st.lastTick || {}).chat || ''; // 空窗期保留最后聊的人，注入行不断档
    log('… 主人和当前聊天没有新对话（好友画像照常补），心情回落中，精神恢复 +' + cfg.personality.recovery + '（' + Math.round(st.spirit) + '）');
  } else {
    try {
      const sc = await llmScore(cfg, st, primary);
      applyScore(st, cfg, primary, sc, tick);
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
    console.log('  精神: ' + Math.round(st.spirit) + '/100  状态: ' + (st.status?.word || '?'));
    console.log('  心情: ' + (st.mood.length ? st.mood.map((m) => m.name + 'Lv' + Math.round(m.level)).join(' · ') : '平静'));
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
