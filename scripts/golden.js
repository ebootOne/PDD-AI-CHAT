'use strict';

/**
 * golden.js —— 黄金集跑分
 *
 * 用法：
 *   node scripts/golden.js                # 默认 Pro、当前店铺
 *   ENGINE=standard node scripts/golden.js
 *   node scripts/golden.js --limit 20     # 冒烟
 *
 * 只校验“事实/边界”，不校验完整措辞。
 */

const fs = require('fs');
const path = require('path');
const cases = require(path.join(__dirname, '..', 'eval', 'golden-cases.js'));

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const STORE = process.env.STORE_ID || 'smw8rjgmx';
const ENGINE = process.env.ENGINE || 'pro';
const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(args[limitArg + 1]) || 0 : 0;

const GOODS = {
  stand: '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚',
  tissue: '加量520张大包抽纸大号可湿水餐巾纸母婴家用商用纸巾柔软卫生纸',
  seed: '白萝卜种子 四季播 耐寒 蔬菜种子 籽',
};
const ORDERS = {
  pending: { hasOrder: true, status: '待发货', courier: '', trackingNo: '' },
  shipped: { hasOrder: true, status: '已发货', courier: '中通', trackingNo: '753123456789' },
  signed: { hasOrder: true, status: '已签收', courier: '中通', trackingNo: '753123456789' },
};

function testAny(text, patterns) {
  return (patterns || []).every((p) => new RegExp(p).test(text));
}
function noAny(text, patterns) {
  return !(patterns || []).some((p) => new RegExp(p).test(text));
}

(async () => {
  const list = LIMIT ? cases.slice(0, LIMIT) : cases;
  const results = [];
  for (const c of list) {
    const body = {
      storeId: STORE,
      engine: ENGINE,
      storeName: 'golden',
      conversationId: 'golden-' + c.id + '-' + Date.now(),
      messages: [{ role: 'buyer', text: c.text }],
      goods: c.goods && GOODS[c.goods] ? { title: GOODS[c.goods] } : undefined,
      order: c.order && ORDERS[c.order] ? ORDERS[c.order] : undefined,
      mode: 'suggest',
      test: true,
    };
    let r = {};
    try {
      r = await (await fetch(API + '/api/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
    } catch (e) {
      r = { error: String(e.message || e) };
    }
    const text = (r.suggestions || []).map((s) => s.text).join(' / ');
    const reasons = [];
    if (!text) reasons.push('无候选');
    if (r.backendError) reasons.push('后端错误:' + r.backendError);
    if (c.source && !c.source.includes(r.source)) reasons.push('来源:' + r.source);
    if (c.decision && !c.decision.includes(r.decision)) reasons.push('决策:' + r.decision);
    if (c.has && !testAny(text, c.has)) reasons.push('缺:' + c.has.join(' & '));
    if (c.not && !noAny(text, c.not)) reasons.push('禁词命中');
    results.push({
      id: c.id, cat: c.cat, text: c.text, ok: reasons.length === 0,
      reasons, source: r.source, decision: r.decision, cost: r.cost,
      reply: text.slice(0, 120),
      order: c.order || null, goods: c.goods || null,
    });
    if ((results.length % 10) === 0) console.log(`  ... ${results.length}/${list.length}`);
  }

  const byCat = {};
  for (const r of results) {
    const b = byCat[r.cat] || (byCat[r.cat] = { total: 0, pass: 0 });
    b.total++;
    if (r.ok) b.pass++;
  }
  const pass = results.filter((r) => r.ok).length;
  const cost = results.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  const local = results.filter((r) => r.source && r.source !== 'backend').length;
  const fail = results.filter((r) => !r.ok);

  console.log(`\n黄金集：${pass}/${results.length} 通过，平均扣点 ${(cost / results.length).toFixed(3)}，本地 ${local} 条`);
  for (const [cat, b] of Object.entries(byCat)) console.log(`  ${cat.padEnd(10)} ${b.pass}/${b.total}`);
  if (fail.length) {
    console.log('\n失败：');
    for (const r of fail) console.log(`  ${r.id} ${r.text} → [${r.source}] ${r.reply}  (${r.reasons.join('; ')})`);
  }

  const report = {
    ts: new Date().toISOString(), engine: ENGINE, store: STORE,
    total: results.length, pass, byCat,
    avgCost: Number((cost / results.length).toFixed(4)),
    local, results,
  };
  fs.writeFileSync(path.join(__dirname, '..', 'eval', 'last-golden.json'), JSON.stringify(report, null, 2));
  if (fail.length) process.exitCode = 1;
})();
