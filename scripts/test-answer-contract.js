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
const orderFacts = { allItems: [
  { id: 'O1', attrs: ['order_status'], orderNo: 'A2115' },
  { id: 'O2', attrs: ['order_status'], orderNo: 'B2115' },
] };
ok('多订单只答一单 → 拦截', { ask: 'shipping_status', used: ['O1'], facts: orderFacts, orders: [{ hasOrder: true, orderNo: 'A2115', status: '已发货' }, { hasOrder: true, orderNo: 'B2115', status: '退款成功' }], text: '已发货' }, false);
ok('尾号重复默认第一单 → 拦截', { ask: 'shipping_status', used: ['O1'], facts: orderFacts, orders: [{ hasOrder: true, orderNo: 'A2115', status: '已发货' }, { hasOrder: true, orderNo: 'B2115', status: '退款成功' }], buyerText: '尾号2115那单', text: '已发货' }, false);
ok('已退款单没说明 → 拦截', { ask: 'shipping_status', used: ['O2'], facts: orderFacts, orders: [{ hasOrder: true, orderNo: 'B2115', status: '退款成功' }], text: '看订单页' }, false);
ok('规格答案夹订单状态 → 清理', { ask: 'spec', used: ['O1'], facts: { allItems: [{ id: 'O1', attrs: ['order_spec', 'order_status'], orderNo: 'A' }] }, text: '单果45mm，已发货，申通尾号9410。' }, true);
const entityFacts = { allItems: [{ id: 'G1', attrs: ['product_stock'], entity: 'product:1', text: '大蒜库存2' }] };
ok('target实体与used不一致 → 拦截', { ask: 'stock', used: ['G1'], target: { entity: 'product:2', attribute: 'product_stock' }, facts: entityFacts, text: '有货' }, false);
ok('target实体与used一致 → 通过', { ask: 'stock', used: ['G1'], target: { entity: 'product:1', attribute: 'product_stock' }, facts: entityFacts, text: '有货' }, true);
const claimFacts = { allItems: [{ id: 'G1', attrs: ['product_stock'], entity: 'product:1', text: '大蒜库存2' }] };
ok('claim事实不存在 → 拦截', { ask: 'stock', used: ['G1'], facts: claimFacts, text: '有货', claims: [{ factId: 'G9', attribute: 'product_stock' }] }, false);
ok('claim属性不一致 → 拦截', { ask: 'stock', used: ['G1'], facts: claimFacts, text: '有货', claims: [{ factId: 'G1', attribute: 'order_status' }] }, false);
ok('claim合法 → 通过', { ask: 'stock', used: ['G1'], facts: claimFacts, text: '有货', claims: [{ factId: 'G1', attribute: 'product_stock' }] }, true);
ok('回答用了其他商品 → 拦截', { ask: 'stock', buyerText: '还有货吗', used: ['G1'], facts: { allItems: [{ id: 'G1', block: 'product', entity: 'product:1', attrs: ['product_stock'], text: '天然花椒木站杆4499' }] }, orders: [{ hasOrder: true, orderNo: 'A', status: '已发货', items: [{ title: '金乡大蒜' }] }], text: '花椒木站杆4499' }, false);
console.log('answer-contract：21 PASS');
