'use strict';

const fs = require('fs');
const path = require('path');
const cases = require(path.join(__dirname, '..', 'eval', 'multi-order-cases.js'));
const API = process.env.API_URL || 'http://127.0.0.1:8787';

function hasAny(text, list) { return list.some((x) => new RegExp(x).test(text)); }

(async () => {
  const results = [];
  for (const c of cases) {
    let r = {};
    try {
      const res = await fetch(API + '/api/reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          storeId: process.env.STORE_ID || 'smw8rjgmx', engine: 'pro', mode: 'suggest', test: true,
          storeName: 'multi-order', conversationId: 'mo-' + c.id + '-' + Date.now(),
          messages: [{ role: 'buyer', text: c.text }], orders: c.orders, order: c.orders[0],
        }),
      });
      r = await res.json();
    } catch (e) { r = { error: String(e.message || e) }; }
    const text = (r.suggestions || []).map((s) => s.text).join(' / ');
    const reasons = [];
    if (!text) reasons.push('无候选');
    if (c.all && !c.all.every((x) => new RegExp(x).test(text))) reasons.push('缺: ' + c.all.join(' & '));
    if (c.any && !hasAny(text, c.any)) reasons.push('任一未中: ' + c.any.join(' | '));
    if (c.groups && !c.groups.every((g) => hasAny(text, g))) reasons.push('分组未覆盖: ' + JSON.stringify(c.groups));
    if (c.not && c.not.some((x) => new RegExp(x).test(text))) reasons.push('禁词命中');
    if (c.question && !/[？?]/.test(text)) reasons.push('没有问句');
    results.push({ id: c.id, text: c.text, ok: reasons.length === 0, reasons, source: r.source, decision: r.decision, reply: text });
  }
  const pass = results.filter((x) => x.ok).length;
  console.log(`多订单黄金集：${pass}/${results.length} 通过`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.text} → ${r.reply}`);
    if (!r.ok) console.log('       ' + r.reasons.join('; '));
  }
  fs.writeFileSync(path.join(__dirname, '..', 'eval', 'last-multi-order.json'), JSON.stringify({ ts: new Date().toISOString(), pass, total: results.length, results }, null, 2));
  if (pass < results.length) process.exitCode = 1;
})();
