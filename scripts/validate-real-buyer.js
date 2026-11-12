'use strict';

/**
 * 用真实页面上下文验证回复，不发送、不扣商家回复。
 * 连接 Electron 渲染进程的 B.page.capture()，把真实订单/会话作为事实，
 * 对一组问题调用 /api/reply?test=true。
 */

const fs = require('fs');
const path = require('path');
const API = process.env.API_URL || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'eval', 'real-buyer-validation.json');

const QUESTIONS = [
  '发货了吗',
  '大蒜那单到哪了',
  '尾号2115那单到哪了',
  '还有其他大蒜品种吗',
  '还有货吗',
  '我买的大蒜还有货吗',
  '这个订单里的蒜还有货吗',
  '能开发票吗',
  '怎么清洗',
  '什么时候能到',
  '另外两单退款了吗',
  '花椒木那单发货了吗',
  '抽纸那单到哪了',
  '我买的大蒜是什么规格',
  '大蒜怎么保存',
  '蒜头有多大',
  '能便宜点吗',
  '可以发顺丰吗',
  '退货怎么退',
  '还有人吗',
];

(async () => {
  const list = await (await fetch('http://127.0.0.1:9335/json/list')).json();
  const t = list.find((x) => x.type === 'page' && x.url.startsWith('file://') && x.url.includes('/renderer/index.html'));
  if (!t) throw new Error('找不到渲染进程');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const capRes = await send('Runtime.evaluate', { expression: 'B.page.capture().then(c=>JSON.stringify(c))', awaitPromise: true, returnByValue: true });
  const cap = JSON.parse(capRes.result.result.value);
  ws.close();

  const results = [];
  for (const q of QUESTIONS) {
    const body = {
      storeId: 'smw8rjgmx', engine: 'pro', mode: process.env.MODE || 'suggest', test: true,
      storeName: '露少小店6521', conversationId: 'real-verify-' + Date.now().toString(36) + '-' + results.length,
      buyerName: cap.buyerName || '林**鹿',
      goods: { title: cap.goodsTitle || '' },
      order: cap.order || null,
      orders: cap.orders || [],
      messages: [...(cap.messages || []).slice(-8), { role: 'buyer', text: q }],
    };
    let r = {};
    try {
      const res = await fetch(API + '/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      r = await res.json();
    } catch (e) { r = { error: String(e.message || e) }; }
    results.push({
      q,
      decision: r.decision,
      source: r.source,
      judge: r.judge,
      guard: r.guard || '',
      contract: r.contract || null,
      needInfo: r.needInfo || null,
      used: (r.facts && r.facts.used) || [],
      text: ((r.suggestions || [])[0] || {}).text || '',
      error: r.error || '',
    });
    console.log(`\nQ: ${q}\n  decision=${r.decision} source=${r.source} used=${JSON.stringify((r.facts && r.facts.used) || [])}\n  judge=${JSON.stringify(r.judge || [])} need=${JSON.stringify(r.needInfo || null)}\n  A: ${((r.suggestions || [])[0] || {}).text || '(无)'}`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), buyer: cap.buyerName, orders: (cap.orders || []).length, results }, null, 2));
  console.log('\n写入 ' + OUT);
})();
