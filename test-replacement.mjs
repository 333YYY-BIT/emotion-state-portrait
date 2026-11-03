// 情绪更换规则单测：最低档优先替换 + 缓冲区升级
import { readFileSync } from 'node:fs';
import { applyScore } from './qq-emotion.mjs';

const cfg = JSON.parse(readFileSync('D:/YangXinYuan/Documents/deepseek-harness/default-workspace/qq-bridge/emotion/config.json', 'utf8'));
const mkState = (mood, buf = []) => ({
  portraits: { test: { name: 'test', familiarity: 90, bond: 50, emotionBias: [] } },
  mood: mood.map(([n, l, at]) => ({ name: n, level: l, at: at ?? 1 })),
  moodBuffer: buf,
});
const run = (st, emotions) => applyScore(st, cfg, { qq: 'test' }, { emotions }, {});
const fmt = (st) => st.mood.map((m) => m.name + 'Lv' + m.level).join(' · ') || '空';
const fmtBuf = (st) => (st.moodBuffer || []).map((m) => m.name + 'Lv' + m.level).join(' · ') || '空';
const show = (tag, st) => console.log(tag, '| 生效:', fmt(st), '| 缓冲:', fmtBuf(st));

// 1) 最低档是 Lv1 → 直接替换（强情绪不排队）
let st = mkState([['喜悦', 1, 1], ['触动', 3, 2], ['安心', 4, 3]]);
run(st, [{ name: '委屈', level: 2 }]);
show('1 最低Lv1直接换  ', st);

// 2) 最低档 Lv2、新情绪明显更弱（Lv1）→ 进缓冲区，先不换
st = mkState([['触动', 3, 1], ['安心', 3.5, 2], ['体恤', 4, 3]]);
run(st, [{ name: '委屈', level: 1 }]);
show('2 弱情绪进缓冲  ', st);

// 3) 同一情绪再出现 → 缓冲内升级，够得着「最低-1」→ 替换并保留等级
run(st, [{ name: '委屈', level: 1 }]);
show('3 缓冲升级后替换', st);

// 4) 三个都是 Lv4，新情绪也是 Lv4 → 换最早出现的那个
st = mkState([['喜悦', 4, 1], ['触动', 4, 2], ['安心', 4, 3]]);
run(st, [{ name: '委屈', level: 4 }]);
show('4 全Lv4换最早的 ', st);

// 5) 三个都是 Lv4，新情绪只有 Lv1 → 缓冲，反复出现才换
st = mkState([['喜悦', 4, 1], ['触动', 4, 2], ['安心', 4, 3]]);
run(st, [{ name: '委屈', level: 1 }]);
show('5a 全Lv4+弱情绪 ', st);
run(st, [{ name: '委屈', level: 1 }]);
show('5b 第二次        ', st);
run(st, [{ name: '委屈', level: 1 }]);
show('5c 第三次        ', st);

// 6) 新情绪比最低档强 → 直接替换
st = mkState([['喜悦', 2, 1], ['触动', 2.5, 2], ['安心', 4, 3]]);
run(st, [{ name: '生气', level: 3 }]);
show('6 新情绪更强     ', st);
