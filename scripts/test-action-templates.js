'use strict';
const assert = require('assert');
const t = require('../server/action-templates');
const order = { hasOrder: true, orderNo: 'A', status: '已发货，待签收', paid: 9.9 };

const r = t.refund.fromModel({ orderNo: 'A', refundType: 'return_refund', received: true, reason: '不想要了', amount: 9.9 }, { order, orders: [order], buyerText: '收到了，不想要了' });
assert.strictEqual(r.template, 'refund');
assert.strictEqual(r.typeName, '退货退款');
assert.strictEqual(r.canAuto, true);

const missing = t.refund.fromModel({ orderNo: 'A', reason: '不想要了', amount: 9.9 }, { order, orders: [order], buyerText: '不想要了' });
assert.ok(missing.needs.includes('received'));
assert.strictEqual(missing.canAuto, false);

const mapped = t.refund.fromModel({ orderNo: 'A', refundType: 'refund_only', received: true, amount: 9.9 }, { order, orders: [order], buyerText: '破损了' });
assert.strictEqual(mapped.reason, '商品破损或污渍');

const inv = t.invite.fromModel({ spec: '45mm 1头' }, { product: { goodsId: 'g', title: '大蒜' } });
assert.strictEqual(inv.template, 'invite');
assert.strictEqual(inv.spec, '45mm 1头');
assert.strictEqual(inv.canAuto, true);
const fromOrder = t.refund.fromModel({ orderNo: 'A', refundType: 'return_refund', received: true, reason: '不想要了', amount: 0 }, { order, orders: [order], buyerText: '不想要了' });
assert.strictEqual(fromOrder.amount, 9.9);
assert.strictEqual(fromOrder.canAuto, true);
assert.strictEqual(t.matchLocal('我要退款').template, 'refund');
assert.strictEqual(t.matchLocal('怎么申请退款'), null);
assert.strictEqual(t.matchLocal('帮我退下款').template, 'refund');
console.log('action-templates：本地完整命令/退款槽位/邀请 PASS');
