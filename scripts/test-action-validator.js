'use strict';
const assert = require('assert');
const { validate } = require('../server/action-validator');
const orders = [
  { hasOrder: true, orderNo: 'P', status: '待支付', items: [{ title: '抽纸' }] },
  { hasOrder: true, orderNo: 'S', status: '待发货', paid: 4.9, items: [{ title: '抽纸' }] },
  { hasOrder: true, orderNo: 'G', status: '已发货，待签收', items: [{ title: '金乡大蒜' }] },
];
const base = { orders, buyerText: '帮我退款', messages: [] };

let r = validate({ kind: 'refund', orderNo: 'S', refundType: 'refund_only', received: false, reason: '不想要了', amount: 0 }, { ...base, buyerText: 'S 帮我退款，不想要了' });
assert.strictEqual(r.kind, 'refund');
assert.strictEqual(r.canAuto, true);
assert.strictEqual(r.plan.amount, 4.9);

r = validate({ kind: 'refund', reason: '不想要了' }, base);
assert.strictEqual(r.kind, 'clarify');
assert.ok(r.needs.includes('order'));

r = validate({ kind: 'refund', orderNo: 'P', received: false, reason: '不想要了' }, base);
assert.strictEqual(r.kind, 'clarify');
assert.match(r.ask, /未支付/);

r = validate({ kind: 'refund', orderNo: 'S', received: false }, base);
assert.strictEqual(r.kind, 'clarify');
assert.ok(r.needs.includes('reason'));

r = validate({ kind: 'refund', orderNo: 'G', received: null, reason: '不想要了' }, base);
assert.strictEqual(r.kind, 'clarify');
assert.ok(r.needs.includes('received'));

r = validate({ kind: 'invite', spec: '45mm 1头' }, { ...base, product: { goodsId: 'g', title: '大蒜' } });
assert.strictEqual(r.kind, 'invite');
assert.strictEqual(r.canAuto, true);

console.log('action-validator：多单/未支付/缺原因/缺收货/邀请 PASS');
