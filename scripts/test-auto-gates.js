'use strict';

/**
 * 自动发送闸门测试：只调 /api/reply，不碰页面、不真的发送。
 * 验证：白名单、非白名单、退款、限流、建议模式。
 */

const assert = require('assert');
const API = process.env.API_URL || 'http://127.0.0.1:8787';
const STORE = process.env.STORE_ID || 'smw8rjgmx';
const GOODS = '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚';
const RUN = 'gate-' + Date.now().toString(36);

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

async function ask(text, conversationId, mode = 'auto') {
  const r = await fetch(API + '/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: STORE, engine: 'pro', mode, test: true,
      storeName: 'auto-gate', conversationId: RUN + '-' + conversationId,
      messages: [{ role: 'buyer', text }],
      goods: { title: GOODS },
    }),
  });
  return r.json();
}

(async () => {
  const logistics = await ask('什么时候发货', 'auto-logi');
  check('A01', '物流意图 → 可自动', () => {
    assert.strictEqual(logistics.decision, 'auto_send', logistics.reason);
    assert.ok(logistics.suggestions && logistics.suggestions[0]);
  });

  const arrival = await ask('什么时候能到呢', 'auto-arrival');
  check('A07', '到货时效（模型）通过质检 → 可自动', () => {
    assert.strictEqual(arrival.decision, 'auto_send', arrival.reason);
    assert.strictEqual(arrival.autoModel, true, 'should be model auto');
  });

  const price = await ask('多少钱', 'auto-price');
  check('A02', '价格意图不在白名单 → 不自动', () => {
    assert.notStrictEqual(price.decision, 'auto_send', price.reason);
  });

  const refund = await ask('我要退款', 'auto-refund');
  check('A03', '退款/售后 → 不自动', () => {
    assert.notStrictEqual(refund.decision, 'auto_send', refund.reason);
  });

  const suggest = await ask('什么时候发货', 'auto-suggest-mode', 'suggest');
  check('A04', '建议模式 → 不自动', () => {
    assert.notStrictEqual(suggest.decision, 'auto_send', suggest.reason);
  });

  const first = await ask('什么时候发货', 'auto-dup');
  const dup = await ask('什么时候发货', 'auto-dup');
  check('A05', '同一句重复请求 → 去重且不再自动', () => {
    assert.strictEqual(first.decision, 'auto_send', first.reason);
    assert.ok(dup.deduped, 'should be deduped');
    assert.notStrictEqual(dup.decision, 'auto_send', dup.reason);
  });

  const rate1 = await ask('什么时候发货', 'auto-rate');
  const rate2 = await ask('发什么快递', 'auto-rate');
  check('A06', '同会话限流：连续两条不同消息，第二条转人工', () => {
    assert.strictEqual(rate1.decision, 'auto_send', rate1.reason);
    assert.notStrictEqual(rate2.decision, 'auto_send', rate2.reason);
  });

  console.log(`\n自动发送闸门：${pass} PASS / ${fails.length} FAIL`);
  if (fails.length) process.exit(1);
})();
