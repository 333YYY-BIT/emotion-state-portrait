<p align="center"><img src="assets/cover.jpg" alt="emotion-state-portrait" width="760"></p>

# emotion-state-portrait · 情绪 · 状态 · 人物画像引擎

> 给 AI 角色装上「会累、会变、记得你」的情绪系统。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](https://nodejs.org) [![Platform](https://img.shields.io/badge/platform-file%20%E6%A8%A1%E5%BC%8F%20%7C%20OneBot-9c6ade.svg)](#quick-start)

给 AI 角色用的三层「连续性」引擎，让任何 LLM 聊天角色拥有：

- **情绪**：由对话事件触发（Lv1~4，最多 3 个叠加，随时间衰减）
- **状态**：精神值 0~100 → 状态词（精神饱满 / 微微疲惫 / 困倦昏沉 / 亢奋…），情绪波动消耗精神，说话底色跟着变
- **画像**：按人维护（熟度 / 羁绊 / 喜好 / 敏感点 / 情绪倾向）——**同样一句话，对不同的人触发的情绪不同**，且与 AI 性格倾向**可叠加**

> LLM 负责「感知」，引擎负责「记住 + 衰减 + 叠加 + 状态物理」。全部逻辑可配置，不绑平台，file 模式可接任何 AI。

## 为什么做这个

大部分 AI 角色的「情绪」是一次性的：这一句热情，下一句冷淡，聊十句也记不住你是谁。
我们在一个真实运行的 QQ 机器人（小鲸）上磨出这套东西——她会因为被逗乐而雀跃，也会因为长时间共情而「累」；同一句难过的话，对老友会放软安慰，对刚认识的人会保持克制。最后这套逻辑被抽成了与平台无关的引擎。

## 效果示例

```
心情：体恤Lv2（体察对方的难处）·触动Lv2（被一句话轻轻打动）
状态：微微疲惫（精神59）——反应变慢一点点，短句变多
对老友：很熟（熟度 97），容易共情放软；画像：心思细腻，怕被冷落
```

这行字每轮自动注入到角色提示词里，不需要改角色任何设定，说话方式就变了。

## 特性

- 情绪词库 303 条（每条带「注入提示词」，直接改变说话方式）
- 情绪叠加：最多 3 个同时存在，同名取最高等级
- 情绪衰减：每 tick 掉 0.4 级，低于 0.5 清掉
- 状态跃迁（彩蛋式）：连续 2 批 Lv3+ 同类情绪解锁——亢奋（精神溢出 120、消退回 60）/ 压抑（压低后净恢复）/ 生气（只有认真哄才恢复）
- 两级情绪映射（可叠加）：性格倾向（敏感型容易点燃触动/委屈…）+ 画像倾向（熟人更容易体恤/暖心）
- 精神值物理：情绪切换、深度思考、高强度共情扣精神；平静对话恢复
- 状态词：精神值分档 + 修饰态（紧绷 / 微醺 / 放松松弛）+ 保底「极简回应」（绝不沉默）
- 人物画像：熟度/羁绊决定情绪等级上限与共情消耗系数
- 网页面板：现在情绪 / AI 状态 / 人物画像 / 时间线 / 工具箱
- 每轮注入：写 `mood.txt`，宿主每轮读出来拼进 prompt，改完立刻生效，不用重启
- 协议：MIT

## 安装

### npm（推荐，任何项目里都能用）

```bash
npm i emotion-state-portrait
# 或 pnpm add emotion-state-portrait / yarn add emotion-state-portrait
```

装完直接：

```bash
npx emotion-state-portrait update     # 跑一轮情绪更新
npx emotion-state-portrait status     # 看当前状态
```

包地址：https://www.npmjs.com/package/emotion-state-portrait

### 作为 DSH 插件安装

```bash
# 方式一：从仓库装
dsh plugin --profile <你的profile> add github:333YYY-BIT/emotion-state-portrait

# 方式二：从 npm 装
dsh plugin --profile <你的profile> add emotion-state-portrait
```

装完自动获得：每 5 分钟一轮的自动情绪更新 + 三个工具（`emotion_status` / `emotion_tweak` / `emotion_update`）。
LLM 配置：设环境变量 `EMOTION_LLM_KEY`，或改插件目录 `emotion/config.json` 里的 `llm.keyFile/keyPattern`。
网页面板：`node <插件目录>/qq-emotion-ui.mjs` → http://127.0.0.1:5191

### 手动用源码

```bash
git clone https://github.com/333YYY-BIT/emotion-state-portrait
cd emotion-state-portrait
npm i ws          # 可选：只有 onebot 模式需要
```

## 快速开始（给任何 AI 用：file 模式）

### 1. 准备

```bash
# 从 npm 装的话，配置模板在 node_modules/emotion-state-portrait/emotion/config.example.json
cp emotion/config.example.json emotion/config.json
```

修改 `emotion/config.json`：

```jsonc
{
  "llm": {
    "api": "你的 OpenAI 兼容地址",
    "model": "你的模型",
    "apiKeyEnv": "EMOTION_LLM_KEY"        // 或 keyFile + keyPattern
  },
  "integration": {
    "source": "file",
    "fileInbox": "emotion/inbox.jsonl",   // 消息进这里
    "moodFile": "mood.txt",               // 状态出这里
    "personaBlock": { "enabled": false }  // 不写人格文件就关掉
  },
  "personality": {
    "name": "你的角色性格",
    "desc": "一句话描述（写进打分提示词）",
    "churnCost": 9, "loadCost": 32, "intenseCost": 4, "recovery": 5,
    "emotionAffinity": {
      "boost": ["触动", "暖心", "委屈"],   // 这个性格容易点燃的情绪（等级+1）
      "damp": ["冷漠", "不屑"]            // 这个性格身上偏淡的情绪（等级-1）
    }
  }
}
```

### 2. 消息喂进来（你的机器人代码里加一行）

```js
// 每收到一条用户消息，追加一行 JSON：
fs.appendFileSync('emotion/inbox.jsonl', JSON.stringify({
  user: '用户id',          // 画像按这个分人
  text: '用户说了什么',
  t: Date.now(),
  role: 'user',            // 你自己的回复用 role:'ai', name:'角色名'
}) + '\n');
```

### 3. 定时跑一轮（cron / 计划任务）

```bash
# Linux/Mac: 每 15 分钟
*/15 * * * * node /path/to/qq-emotion.mjs update
```

设置 LLM key（或配置 keyFile）：

```bash
export EMOTION_LLM_KEY=sk-xxx
```

### 4. 回复前把状态注进 prompt

每轮生成回复前读 `mood.txt`，把它放在系统提示里（在用户消息之外）：

```
你现在的状态：心情：触动Lv2（被一句话轻轻打动）·感激Lv1；状态：微微疲惫（精神62）——反应变慢一点点，短句变多
这是你的底色，别念出来，说话自然带着就行。
```

改完 mood.txt 不用重启，下一句就生效。

## 面板

```bash
node qq-emotion-ui.mjs            # 打开 http://127.0.0.1:5191
# 用自定义配置/状态时：
EMOTION_CONFIG=/path/config.json EMOTION_STATE=/path/state.json node qq-emotion-ui.mjs
```

面板有：现在情绪、AI 状态（精神条 + 状态词 + 叠加系数）、人物画像、时间线、工具箱（提神 / 注入情绪 / 一键平静，改完立即写 mood 文件）。

## 定制点（全部在 config.json，不动代码）

| 想改什么 | 改哪里 |
|---|---|
| 角色的性格（消耗 / 恢复 / 情绪上限） | `personality.*` |
| 性格容易 / 不易触发的情绪 | `personality.emotionAffinity.boost/damp` |
| 情绪词库（增删词、改提示词） | `vocab[]`（name/kind/cue） |
| 状态词与阈值 | `statusLadder`、`specialStatus` |
| 熟度 → 等级上限 / 消耗系数 | `capByFamiliarity`、`portraitFactor` |
| 情绪叠加数量、衰减速度 | `mood.maxActive`、`mood.decayPerTick` |
| LLM 地址 / 模型 / key | `llm.*` |
| 消息源 / 注入文件 / 人格块 | `integration.*` |

## 两级情绪映射（可叠加）

```
最终等级 = LLM 感知等级
         + 性格映射（boost 词 +1，damp 词 -1）
         + 画像映射（熟度≥30 且 ∈ 对方 emotionBias → +1）
         → 截断到 [1, 等级上限]，上限 = f(熟度)，敏感型对熟人再 +1
```

例子：角色是「敏感型」，对方画像倾向「体恤」——
新朋友：LLM 给体恤 Lv2 → 性格 +1 → 上限 3 → **体恤 Lv3**；
老朋友：LLM 给体恤 Lv2 → 性格 +1 + 画像 +1 → 上限 4 → **体恤 Lv4**（极致，情绪压过理性）。

## OneBot / QQ 模式

`integration.source: "onebot"` 时，引擎直接连 OneBot 11 WS（NapCat 等）拉 `get_friend_msg_history`，还会每轮轮转扫好友补画像；`personaBlock.enabled: true` 会同步把状态写进人格文件的标记区（静态备份）。需要 `ws` 包。

## 命令速查

```
node qq-emotion.mjs update [--dry]        跑一轮（自动处理无新消息的回落 + 恢复）
node qq-emotion.mjs status                看当前状态
node qq-emotion.mjs portrait <用户id>     看某人画像
node qq-emotion.mjs tweak boost|rest|clear|add 词 [等级]|forget 词|spirit 0~100
node qq-emotion-ui.mjs [端口]             打开面板
```

## 目录

```
qq-emotion.mjs        引擎本体（CLI + 可被 import）
qq-emotion-ui.mjs     面板服务
emotion/config.json   词库 / 性格系数 / 状态词 / 画像系数 / LLM / 集成方式
emotion/ui.html       面板页面
docs/设计.md          设计文档（三层模型、公式、取舍）
examples/inbox.example.jsonl   file 模式消息示例
```

## 关于「情绪提示词」

每个情绪词自带一句「说话表现」（如：委屈——觉得自己被误解、没有被公平对待，带着难过和不甘），注入时连同等级一起写进 prompt。状态词同样自带说话方式（微微疲惫——反应变慢一点点，短句变多）。所以模型不需要理解这套系统，照着注入行说就行。

## License

MIT，见 LICENSE。
