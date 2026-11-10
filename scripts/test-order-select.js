'use strict';

const assert = require('assert');
const { pickOrders } = require('../server/order-select');

const orders = [
  { hasOrder: true, orderNo: '261110-579967424052115', items: [{ title: '26年金乡大蒜精品' }] },
  { hasOrder: true, orderNo: '261109-478171655732115', items: [{ title: '加量520张大包抽纸' }] },
];

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(id); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

check('S1', '点名商品 → 只筛对应订单', () => {
  const r = pickOrders('大蒜那单发货了吗', orders);
  assert.strictEqual(r.orders.length, 1);
  assert.ok(r.orders[0].items[0].title.includes('大蒜'));
});
check('S2', '没点名 → 给全量订单', () => {
  const r = pickOrders('发货了吗', orders);
  assert.strictEqual(r.orders.length, 2);
  assert.strictEqual(r.ambiguous, true);
});
check('S3', '点订单尾号 → 对应订单', () => {
  const r = pickOrders('尾号2115那单', orders);
  assert.strictEqual(r.orders.length, 2); // 两单尾号都是 2115，仍由模型取舍
});
check('S4', '两单都有大蒜 → 两单都给模型', () => {
  const two = [orders[0], { ...orders[1], items: [{ title: '金乡大蒜' }] }];
  const r = pickOrders('大蒜那单', two);
  assert.strictEqual(r.orders.length, 2);
  assert.strictEqual(r.ambiguous, true);
});

console.log(`订单筛选：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
