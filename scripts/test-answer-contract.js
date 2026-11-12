'use strict';
const assert = require('assert');
const contract = require('../server/answer-contract');
const facts = { allItems: [
  { id: 'O1', attrs: ['order_status', 'order_courier', 'order_tracking', 'order_items'] },
  { id: 'G1', attrs: ['product_title', 'product_price', 'product_stock'] },
  { id: 'M1', attrs: ['manual_section'] },
] };
function ok(name, input, expected) {
  const r = contract.check(input);
  assert.strictEqual(r.ok, expected, name + ' => ' + JSON.stringify(r));
  console.log('  PASS ' + name);
}
ok('库存 + 商品事实 → 通过', { ask: 'stock', used: ['G1'], target: { attribute: 'product_stock' }, facts }, true);
ok('库存 + 订单事实 → 拦截', { ask: 'stock', used: ['O1'], target: { attribute: 'order_status' }, facts }, false);
ok('库存 + 订单事实无 target → 拦截', { ask: 'stock', used: ['O1'], facts }, false);
ok('物流 + 订单事实 → 通过', { ask: 'shipping_status', used: ['O1'], target: { attribute: 'order_status' }, facts }, true);
ok('物流 + 商品价格 → 拦截', { ask: 'shipping_status', used: ['G1'], target: { attribute: 'product_price' }, facts }, false);
ok('库存 + used商品但文本订单 → 拦截', { ask: 'stock', used: ['O1', 'G1'], target: null, facts, text: '已发货，申通尾号9410；其他品种看页面库存' }, false);
ok('库存 + used商品且文本库存 → 通过', { ask: 'stock', used: ['G1'], target: null, facts, text: '有货，库存2件' }, true);
ok('价格 + 文本订单状态 → 拦截', { ask: 'price', used: ['G1'], target: null, facts, text: '已发货，申通尾号9410' }, false);
ok('规格 + 文本订单状态 → 拦截', { ask: 'spec', used: ['O1'], target: null, facts, text: '已发货，申通尾号9410' }, false);
ok('说明书 + 说明书事实 → 通过', { ask: 'usage', used: ['M1'], target: { attribute: 'manual_section' }, facts }, true);
ok('退款状态 + 订单事实 → 通过', { ask: 'return_policy', used: ['O1'], target: { attribute: 'order_status' }, facts }, true);
console.log('answer-contract：11 PASS');
