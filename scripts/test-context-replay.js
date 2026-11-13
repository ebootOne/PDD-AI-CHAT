'use strict';

/**
 * 当前真实会话的上下文回放：只读页面 + 调本地 API（test），不向拼多多发送。
 * 验证：
 *   5 分钟 → 继承上一段话题
 *   1440 分钟 → 不继承旧主题
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const API = process.env.API_URL || 'http://127.0.0.1:8787';
const PORT = Number(process.env.CDP_PORT || 9335);

async function capture() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.startsWith('file://') && x.url.includes('/renderer/index.html'));
  if (!t) throw new Error('没找到渲染层页面');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const r = await send('Runtime.evaluate', { expression: 'B.page.capture().then(c=>JSON.stringify(c))', awaitPromise: true, returnByValue: true });
  ws.close();
  return JSON.parse(r.result.result.value);
}

async function ask(cap, gap, text) {
  const body = {
    storeId: 'smw8rjgmx', engine: 'pro', mode: 'suggest', test: true, storeName: 'replay',
    conversationId: 'replay-' + gap + '-' + Date.now(),
    messages: [...(cap.messages || []), { role: 'buyer', text }],
    orders: cap.orders || [], goods: { title: cap.goodsTitle || '' },
    sessionGapMinutes: gap,
  };
  const r = await fetch(API + '/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

(async () => {
  const cap = await capture();
  const fresh = await ask(cap, 5, '还有货嘛');
  const stale = await ask(cap, 1440, '还有货嘛');
  const freshRef = fresh.facts && fresh.facts.reference && fresh.facts.reference.ref;
  const staleRef = stale.facts && stale.facts.reference && stale.facts.reference.ref;
  assert.ok(freshRef, '5 分钟应继承上一段话题');
  assert.strictEqual(staleRef, null, '跨天不应继承旧话题');
  const staleText = (stale.suggestions || [])[0] && stale.suggestions[0].text || '';
  assert.ok(!/抽纸|大蒜/.test(staleText), '跨天回答不应直接沿用旧商品：' + staleText);

  const out = {
    capturedAt: new Date().toISOString(),
    lastBuyerText: cap.lastBuyerText,
    messageCount: (cap.messages || []).length,
    fresh: { gap: 5, ref: freshRef, text: (fresh.suggestions || [])[0]?.text || '' },
    stale: { gap: 1440, ref: staleRef, text: staleText },
    sent: false,
  };
  fs.mkdirSync(path.join(__dirname, '..', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'eval', 'context-replay.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  console.log('context-replay：5分钟继承 / 跨天重置 PASS（未发送）');
})();
