// 打分改造测试：确定性单测（词池/近期情绪/冷却记账/提示词内容）+ --live 真 API 冒烟
// 用法: node test-scoring.mjs            （只跑确定性部分，无网络）
//       node test-scoring.mjs --live     （加真 API 冒烟，验证分层打分与词库约束）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  wordPool, recentTopNames, updateExplore, topMoodName,
  buildScorePrompts, pickCategory, scoreInCategory,
} from './qq-emotion.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'emotion', 'config.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

console.log('── ① 词池 ──');
const all = wordPool(cfg, null);
ok(all.length === (cfg.vocab || []).length + (cfg.vocabExtra || []).length, '全量词池 = 303', 'got ' + all.length);
const pos = wordPool(cfg, 'pos');
ok(pos.length > 0 && pos.every((v) => v.kind === 'pos' || cfg.extraKind[v.name] === 'pos'), 'pos 词池全部归类正确', 'got ' + pos.length);
ok(pos.some((v) => v.name === '安心'), 'pos 池含安心');
ok(pos.some((v) => !cfg.vocab.some((c) => c.name === v.name)), 'pos 池含 extra 词');
for (const k of ['pos', 'neg', 'think', 'social', 'subtle', 'combo']) {
  ok(wordPool(cfg, k).length > 10, k + ' 词池规模 >10', 'got ' + wordPool(cfg, k).length);
}

console.log('── ② 近期情绪清单 ──');
const stH = { history: [
  { mood: '安心Lv3·戏谑Lv2' }, { mood: '平静' }, { mood: '期待Lv2·忐忑Lv1' },
  { mood: '安心Lv2' }, { mood: '体恤Lv1·触动Lv2' },
] };
eq(recentTopNames(stH, 10), ['体恤', '触动', '安心', '期待', '忐忑', '戏谑'], '倒序、剥 Lv、去重、跳过平静');
ok(recentTopNames({ history: [] }).length === 0, '空历史返回空');

console.log('── ③ 冷却记账 ──');
const stE = { explore: undefined };
updateExplore(stE, '安心'); updateExplore(stE, '安心'); updateExplore(stE, '安心');
ok(stE.explore.sameStreak === 3 && stE.explore.ban === '安心', '连续 3 轮同一词 → 禁用');
updateExplore(stE, '期待');
ok(stE.explore.ban === '' && stE.explore.lastTop === '期待' && stE.explore.sameStreak === 1, '换词即解禁并重置连击');
updateExplore(stE, '');
ok(stE.explore.sameStreak === 1, '空情绪不参与记账');
eq(topMoodName({ mood: [{ name: '戏谑', level: 2 }, { name: '安心', level: 3 }] }), '安心', '主导情绪取最高级');

console.log('── ④ 提示词内容（无网络） ──');
const stP = {
  mood: [{ name: '安心', level: 3 }],
  history: [{ mood: '安心Lv3' }, { mood: '安心Lv2' }],
  explore: { lastTop: '安心', sameStreak: 4, ban: '安心' },
  portraits: { 'u-test': { name: 'u-test', familiarity: 95, bond: 60, summary: '心思细的老朋友' } },
  spirit: 70,
};
const chatP = { qq: 'u-test', name: 'u-test', lines: ['u-test: 今天好累', '她: 怎么啦'] };
const pp = buildScorePrompts(cfg, stP, chatP, 'pos');
ok(!pp.system.includes('冷漠：'), 'pos 提示词不含 neg 类词（如 冷漠）', pp.system.slice(0, 60));
ok(pp.system.includes('轻微倾向'), 'boost 措辞已软化');
ok(pp.system.includes('优先挑这份名单之外'), '探索奖励行存在');
ok(pp.system.includes('本轮不要再用「安心」'), '冷却禁用行存在');
ok(pp.system.includes('安心：'), '类内词池含安心');
const pp2 = buildScorePrompts(cfg, { mood: [], history: [], explore: {}, portraits: {} }, chatP, null);
ok(pp2.system.includes('冷漠：'), 'category=null 时回退全词库');
ok(!pp2.system.includes('本轮不要再用'), '无 ban 时没有冷却行');

console.log('── ⑤ 生气锁类（无网络） ──');
const angryCat = await pickCategory(cfg, { transition: { name: '生气' }, portraits: {}, mood: [], history: [] }, chatP);
eq(angryCat, 'neg', '生气状态 pickCategory 直接锁 neg，不发 API');

if (process.argv.includes('--live')) {
  console.log('── ⑥ 真 API 冒烟 ──');
  const stLive = {
    mood: [], history: [], explore: {},
    transition: null,
    portraits: { 'u-live': { name: 'u-live', familiarity: 95, bond: 70, summary: '无话不谈的好友' } },
    spirit: 80,
  };
  const chats = [
    { qq: 'u-live', name: 'u-live', lines: ['u-live: 今天吃到一家超好吃的火锅', '她: 哇真的吗快说说'] },
    { qq: 'u-live', name: 'u-live', lines: ['u-live: 跟你说个事，我家里出事了，心情很差', '她: 我在呢，你说'] },
    { qq: 'u-live', name: 'u-live', lines: ['u-live: 我考砸了，估计要被骂了', '她: 别慌，慢慢说'] },
  ];
  const keys = new Set();
  for (const [i, chat] of chats.entries()) {
    const cat = await pickCategory(cfg, stLive, chat);
    const sc = await scoreInCategory(cfg, stLive, chat, cat);
    const pool = new Set(wordPool(cfg, cat).map((v) => v.name));
    const names = (sc.emotions || []).map((e) => e.name);
    ok(names.every((n) => pool.has(n)), `冒烟${i + 1} 情绪都在词池内 (类别=${cat})`, 'got ' + names.join('/'));
    ok((sc.emotions || []).length <= 3, `冒烟${i + 1} 情绪 ≤3`);
    keys.add(cat);
    console.log(`  冒烟${i + 1}: 类别=${cat} 情绪=` + names.map((n, j) => n + ' Lv' + sc.emotions[j].level).join('、'));
    await new Promise((r) => setTimeout(r, 800));
  }
  ok(keys.size >= 2, '不同场景分类有区分度', 'got ' + [...keys].join('/'));
}

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + `：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
