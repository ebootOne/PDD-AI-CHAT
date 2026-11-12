'use strict';
const assert = require('assert');
const { guard } = require('../server/answer-guard');

const orders = [
  { hasOrder: true, orderNo: 'A9410', status: '已发货，待签收', items: [{ title: '金乡大蒜' }] },
  { hasOrder: true, orderNo: 'B6789', status: '未发货，退款成功', items: [{ title: '天然花椒木站杆' }] },
  { hasOrder: true, orderNo: 'C1234', status: '未发货，退款成功', items: [{ title: '抽纸' }] },
];
function run(name, input, test) {
  const r = guard(input);
  test(r);
  console.log('  PASS ' + name);
}

run('泛问快递 → 不按多订单问哪一单', { ask: 'courier', buyerText: '可以发顺丰吗', text: '这单发的是申通，尾号9410，顺丰以页面为准', orders, facts: { used: ['O1'] } },
  (r) => assert.strictEqual(r, null));
run('绝对否定配送 → 页面可选', { ask: 'courier', buyerText: '可以发顺丰吗', text: '这单发的是申通，顺丰发不了', orders, facts: { used: [] } },
  (r) => { assert.ok(r && /可选/.test(r.text) && !/发不了/.test(r.text)); });
run('干净回复 → 不触发', { ask: 'courier', buyerText: '发什么快递', text: '这单发的是申通，尾号9410', orders: [orders[0]], facts: { used: ['O1'] } },
  (r) => assert.strictEqual(r, null));
console.log('answer-guard：3 PASS');
