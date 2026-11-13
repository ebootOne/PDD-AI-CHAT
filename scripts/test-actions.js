'use strict';
const assert = require('assert');
const { refundPlan, invitePlan, matchSku } = require('../server/actions');

const unshipped = { hasOrder: true, orderNo: 'A', status: '未发货', paid: 9.9, items: [{ title: '大蒜' }] };
const shipped = { hasOrder: true, orderNo: 'B', status: '已发货，待签收', paid: 9.9 };
const received = { hasOrder: true, orderNo: 'C', status: '已签收', paid: 9.9 };
const refunded = { hasOrder: true, orderNo: 'D', status: '退款成功', paid: 9.9 };

assert.strictEqual(refundPlan({ order: unshipped, reason: '不想要了' }).suggestedType, 'refund_only');
assert.strictEqual(refundPlan({ order: shipped, reason: '不想要了' }).missing.includes('received'), true);
assert.strictEqual(refundPlan({ order: received, reason: '质量问题' }).suggestedType, 'return_refund');
assert.strictEqual(refundPlan({ order: refunded, reason: '退款' }).closed, true);
assert.strictEqual(refundPlan({ order: unshipped, reason: '不想要了', confirm: true }).canSubmit, true);
assert.strictEqual(refundPlan({ order: unshipped, reason: '', confirm: true }).canSubmit, false);

const product = { goodsId: 'g1', title: '大蒜', skus: [
  { skuId: 's1', spec: '45mm 1头', price: 9.9, stock: 10 },
  { skuId: 's2', spec: '50mm 2头', price: 15.9, stock: 5 },
] };
assert.strictEqual(matchSku(product, { spec: '45mm' }).mode, 'exact');
assert.strictEqual(matchSku(product, { spec: '头' }).mode, 'ambiguous');
assert.strictEqual(matchSku(product, {}).mode, 'need_spec');
assert.strictEqual(invitePlan({ product, spec: '45mm', confirm: true }).canSend, true);
assert.strictEqual(invitePlan({ product, spec: '60mm', confirm: true }).canSend, false);
const noSku = { goodsId: 'g2', title: '抽纸' };
assert.strictEqual(invitePlan({ product: noSku }).mode, 'no_sku');

console.log('actions：退款分类/匹配/确认单 PASS');
