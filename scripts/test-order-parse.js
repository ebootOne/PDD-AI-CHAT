'use strict';

const assert = require('assert');
const path = require('path');
const { parseOrderPanel } = require(path.join(__dirname, '..', 'desktop', 'order-parse.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

const pending = `待发货

订单编号: 261110-067140339252115
下单时间: 2026/11/10 12:08
天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚
直径1.0-1.5cm适合小型鸟,单头螺丝10cm【1根】
x1
￥4.54
地址 添加备注 小额打款`;

const shipped = `已发货
中通快递
运单号：753123456789
收件人：张三
手机号：13800000000
地址：上海市某路1号`;

check('O01', '真实待发货面板', () => {
  const r = parseOrderPanel(pending);
  assert.strictEqual(r.hasOrder, true);
  assert.strictEqual(r.status, '待发货');
  assert.strictEqual(r.trackingNo, '');
});
check('O02', '已发货 + 快递 + 运单号', () => {
  const r = parseOrderPanel(shipped);
  assert.strictEqual(r.status, '已发货');
  assert.strictEqual(r.courier, '中通');
  assert.strictEqual(r.trackingNo, '753123456789');
});
check('O03', '隐藏「没有相关订单」但有真实订单 → 不能判空', () => {
  const r = parseOrderPanel(`没有相关订单\n0条数据\n${shipped}`);
  assert.strictEqual(r.hasOrder, true);
  assert.strictEqual(r.status, '已发货');
});
check('O04', '只有空态 → hasOrder false', () => {
  const r = parseOrderPanel('没有相关订单\n0条数据');
  assert.strictEqual(r.hasOrder, false);
});
check('O05', '只有订单号 → 不把订单号当运单号', () => {
  const r = parseOrderPanel('待发货\n订单编号: 261110-067140339252115');
  assert.strictEqual(r.status, '待发货');
  assert.strictEqual(r.trackingNo, '');
});
check('O06', '隐私字段不进入结果', () => {
  const r = parseOrderPanel(shipped);
  assert.deepStrictEqual(Object.keys(r).sort(), ['courier', 'hasOrder', 'source', 'status', 'trackingNo']);
  assert.ok(!JSON.stringify(r).includes('张三'));
  assert.ok(!JSON.stringify(r).includes('13800000000'));
});

console.log(`\n订单解析：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
