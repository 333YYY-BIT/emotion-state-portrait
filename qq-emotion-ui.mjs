#!/usr/bin/env node
/**
 * qq-emotion-ui.mjs —— 小鲸情绪/状态/画像 的本地网页面板。
 *
 * 用法: node qq-emotion-ui.mjs [端口]   （默认 127.0.0.1:5191，只绑本机）
 * 然后浏览器打开 http://127.0.0.1:5191
 *
 * 数据全部来自 emotion/state.json + config.json，5 秒轮询；
 * 工具箱的调整走 qq-emotion.mjs 同一套 applyTweak，改完立刻重写 mood.txt
 * （插件每轮注入），下一句就生效。
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadState, saveState, loadConfig, writeOutputs, applyTweak, runUpdateOnce,
} from './qq-emotion.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, 'emotion', 'ui.html');
const PORT = Number(process.argv[2] || process.env.EMOTION_UI_PORT || 5191);

function apiState() {
  const st = loadState();
  const cfg = loadConfig();
  const hist = (st.history || []).slice(-30).reverse();
  return {
    state: {
      updatedAt: st.updatedAt,
      spirit: Math.round(st.spirit),
      mood: st.mood,
      status: st.status,
      lastTick: st.lastTick,
      portraits: st.portraits,
      transition: st.transition || null,
      streak: st.streak || { pos: 0, neg: 0, angry: 0 },
    },
    config: {
      personality: cfg.personality,
      statusLadder: cfg.statusLadder,
      specialStatus: cfg.specialStatus,
      capByFamiliarity: cfg.capByFamiliarity,
      portraitFactor: cfg.portraitFactor,
      vocab: [...(cfg.vocab || []), ...(cfg.vocabExtra || [])],
    },
    history: hist,
  };
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const html = readFileSync(HTML, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/state') {
      sendJson(res, 200, apiState());
      return;
    }
    if (req.method === 'POST' && (req.url === '/api/tweak' || req.url === '/api/update')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const cfg = loadConfig();
      const st = loadState();
      if (req.url === '/api/update') {
        const fresh = await runUpdateOnce();
        sendJson(res, 200, { ok: true, state: apiState().state, note: '已跑一轮 update' });
        return;
      }
      const j = JSON.parse(body || '{}');
      applyTweak(st, cfg, j.action, j.value, j.extra);
      saveState(st);
      writeOutputs(st, cfg);
      sendJson(res, 200, { ok: true, state: apiState().state });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e).slice(0, 200) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('🐳 小鲸情绪面板: http://127.0.0.1:' + PORT + '  (Ctrl+C 退出)');
});
