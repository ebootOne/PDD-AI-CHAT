'use strict';

/**
 * watch-first-chat.js —— 等第一条真实会话出现，出现后立刻抓页面结构
 *
 * 用途：商家用另一个账号发消息时，工具自己发现"会话来了"，不用人盯着屏幕。
 * 运行：node scripts/watch-first-chat.js   （最多等 30 分钟）
 */

const { spawnSync } = require('child_process');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9335);
const MAX_MS = Number(process.env.WAIT_MS || 30 * 60 * 1000);
const STEP = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && /chat-merchant/.test(x.url || ''));
  if (!t) return { ok: false, reason: 'no-page' };

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id);
      pending.delete(m.id);
      q(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true });
    return r.result && r.result.value;
  };

  const state = await ev(`(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
    const input = [...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(vis).length;
    const items = [...document.querySelectorAll('div,li')].filter((el) => {
      const t = (el.innerText || '').trim();
      return vis(el) && t.length > 2 && t.length < 40 && /\\d{2}:\\d{2}/.test(t);
    }).length;
    const bubbleLike = [...document.querySelectorAll('div')].filter((el) => {
      const r = el.getBoundingClientRect();
      return vis(el) && r.height > 16 && r.height < 120 && r.width > 40 && r.width < 520 && (el.innerText || '').trim().length > 2;
    }).length;
    return { input, items, bubbleLike, body: document.body.innerText.length };
  })()`);

  ws.close();
  return { ok: true, ...state, url: t.url };
}

(async () => {
  const start = Date.now();
  console.log('等待第一条真实会话…（最多 30 分钟）');
  let last = '';
  while (Date.now() - start < MAX_MS) {
    try {
      const s = await probe();
      const line = `输入框 ${s.input} · 会话项 ${s.items} · 气泡候选 ${s.bubbleLike}`;
      if (line !== last) {
        console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), line);
        last = line;
      }
      if (s.input > 0 && s.items > 0) {
        console.log('\n检测到会话，开始抓结构…');
        const r = spawnSync(process.execPath, [path.join(__dirname, 'capture-live-page.js')], { stdio: 'inherit' });
        process.exit(r.status || 0);
      }
    } catch (e) {
      /* 页面刷新中，忽略 */
    }
    await sleep(STEP);
  }
  console.log('等待超时，未检测到会话');
  process.exit(2);
})();
