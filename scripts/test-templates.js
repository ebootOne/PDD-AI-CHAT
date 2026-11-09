'use strict';

/** 四个常规模板：常见说法命中，带条件的交模型 */

const assert = require('assert');
const path = require('path');
const t = require(path.join(__dirname, '..', 'server', 'templates.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}
const ask = (q) => (t.match(q) || {}).ask || null;

check('T01', '请问什么时候发货呀？→ 发货时间', () => assert.strictEqual(ask('请问什么时候发货呀？'), 'shipping_time'));
check('T02', '发货要多久 → 发货时间', () => assert.strictEqual(ask('发货要多久'), 'shipping_time'));
check('T03', '啥时候发 → 发货时间', () => assert.strictEqual(ask('啥时候发'), 'shipping_time'));
check('T04', '发什么快递 → 快递', () => assert.strictEqual(ask('发什么快递'), 'courier'));
check('T05', '什么快递公司 → 快递', () => assert.strictEqual(ask('什么快递公司'), 'courier'));
check('T06', '包邮吗 → 包邮', () => assert.strictEqual(ask('包邮吗'), 'freight'));
check('T07', '运费多少 → 包邮/运费', () => assert.strictEqual(ask('运费多少'), 'freight'));
check('T08', '能开发票吗 → 发票', () => assert.strictEqual(ask('能开发票吗'), 'invoice'));
check('T09', '内蒙古包邮吗 → 不命中（地区）', () => assert.strictEqual(ask('内蒙古包邮吗'), null));
check('T10', '公司抬头能开票吗 → 不命中（专票/抬头）', () => assert.strictEqual(ask('公司抬头能开票吗'), null));
check('T11', '专票能开吗 → 不命中', () => assert.strictEqual(ask('专票能开吗'), null));
check('T12', '发货了吗 → 不命中（状态）', () => assert.strictEqual(ask('发货了吗'), null));
check('T13', '快递到哪了 → 不命中（物流）', () => assert.strictEqual(ask('快递到哪了'), null));
check('T14', '支付宝退款几天能到 → 不命中', () => assert.strictEqual(ask('支付宝退款几天能到'), null));
check('T15', '支持支付宝吗 → 不命中（四个之外）', () => assert.strictEqual(ask('支持支付宝吗'), null));

console.log(`\n四个模板：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
