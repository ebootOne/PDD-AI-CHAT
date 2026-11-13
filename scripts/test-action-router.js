'use strict';
const assert = require('assert');
const { plan } = require('../server/action-router');
const order = { hasOrder: true, orderNo: 'A', status: '未发货', paid: 9.9 };

assert.strictEqual(plan({ buyerText: '怎么退款' }), null);
assert.strictEqual(plan({ buyerText: '我想退款', order }).kind, 'refund');
assert.strictEqual(plan({ buyerText: '我要退货退款', order }).kind, 'refund');
assert.strictEqual(plan({ buyerText: '邀请下单', product: { goodsId: 'g1', title: '大蒜' }, spec: '45mm' }).kind, 'invite');
assert.strictEqual(plan({ buyerText: '怎么下单' }), null);
assert.strictEqual(plan({ buyerText: '有什么货' }), null);
console.log('action-router：明确动作识别 PASS');
