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

run('库存题订单状态 → 问库存', { ask: 'stock', buyerText: '还有货吗', text: '您的大蒜已发货，申通尾号9410', orders, facts: { used: ['O1'] } },
  (r) => { assert.ok(r && /库存/.test(r.text) && !/已发货|物流/.test(r.text)); });
run('多订单只答一单 → 问哪一单', { ask: 'shipping_status', buyerText: '发货了吗', text: '已发货，申通尾号9410', orders, facts: { used: ['O1'] } },
  (r) => { assert.ok(r && /哪一单/.test(r.text) && /退款成功/.test(r.text)); });
const tailOrders = orders.map((o) => ({ ...o, orderNo: 'X2115' }));
run('尾号重复 → 不默认第一单', { ask: 'shipping_status', buyerText: '尾号2115那单到哪了', text: '已发货，申通尾号9410', orders: tailOrders, facts: { used: ['O1'] } },
  (r) => { assert.ok(r && /2115/.test(r.text) && /哪一单/.test(r.text)); });
run('点名退款单 → 说明退款', { ask: 'shipping_status', buyerText: '花椒木那单发货了吗', text: '这一单进度以订单页为准', orders, facts: { used: ['O2'] } },
  (r) => { assert.ok(r && /退款成功/.test(r.text)); });
run('价格题订单状态 → 价格口径', { ask: 'price', buyerText: '能便宜点吗', text: '已发货，申通尾号9410', orders, facts: { used: ['O1'] } },
  (r) => { assert.ok(r && /价格|优惠/.test(r.text) && !/已发货|物流/.test(r.text)); });
run('干净回复 → 不触发', { ask: 'courier', buyerText: '发什么快递', text: '这单发的是申通，尾号9410', orders: [orders[0]], facts: { used: ['O1'] } },
  (r) => assert.strictEqual(r, null));
console.log('answer-guard：6 PASS');
