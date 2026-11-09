'use strict';

const assert = require('assert');
const path = require('path');
const u = require(path.join(__dirname, '..', 'server', 'understand.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}
const ask = (q) => u.extract(q).ask;
const ent = (q) => u.extract(q).entities || {};

check('I01', '支付宝退款几天能到 → 退款，不是支付', () => {
  assert.strictEqual(ask('支付宝退款几天能到'), 'after_sale');
  assert.strictEqual(ent('支付宝退款几天能到').payment, '支付宝');
});
check('I02', '支持支付宝吗 → 支付', () => assert.strictEqual(ask('支持支付宝吗'), 'payment'));
check('I03', '发货了吗 → 状态', () => assert.strictEqual(ask('发货了吗'), 'shipping_status'));
check('I04', '什么时候发货 → 发货时间', () => assert.strictEqual(ask('什么时候发货'), 'shipping_time'));
check('I05', '种子几天发芽 → 用法/生长', () => assert.strictEqual(ask('种子几天发芽'), 'usage'));
check('I06', '几天能到 → 到货时效', () => assert.strictEqual(ask('几天能到'), 'arrival_time'));
check('I07', '内蒙古包邮吗 → 包邮 + 地区实体', () => {
  assert.strictEqual(ask('内蒙古包邮吗'), 'freight');
  assert.strictEqual(ent('内蒙古包邮吗').region, '内蒙古');
});
check('I08', '能发顺丰吗 → 快递（不是发货时间）', () => assert.strictEqual(ask('能发顺丰吗'), 'courier'));
check('I09', '能开专票吗 → 发票', () => assert.strictEqual(ask('能开专票吗'), 'invoice'));
check('I10', '老板电话 → 隐私；老板吃饭 → 不是隐私', () => {
  assert.strictEqual(ask('老板电话多少'), 'privacy');
  assert.strictEqual(ask('老板吃饭了吗'), 'other');
});
check('I11', '在吗 → 问候', () => assert.strictEqual(ask('在吗'), 'greeting'));
check('I12', '几天发货 → 发货时间，不是到货', () => assert.strictEqual(ask('几天发货'), 'shipping_time'));

console.log(`\n意图区分：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
