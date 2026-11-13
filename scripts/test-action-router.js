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
assert.strictEqual(plan({ buyerText: '已经收到了', messages: [{ role: 'buyer', text: '帮我退下款，不想要了' }], order }).kind, 'refund');
assert.strictEqual(plan({ buyerText: '邀请下单，要45mm、1头净蒜', product: { goodsId: 'g', title: '大蒜' } }).spec, '45mm 1头净蒜');
const orders = [
  { hasOrder: true, orderNo: 'P', status: '待支付', items: [{ title: '抽纸' }] },
  { hasOrder: true, orderNo: 'S', status: '待发货', items: [{ title: '抽纸' }] },
];
const follow = plan({ buyerText: '抽纸这单', orders, messages: [
  { role: 'buyer', text: '我说的是已经下单的' },
  { role: 'seller', text: '您说的是已下单的抽纸这单吧，目前状态是待发货。' },
  { role: 'buyer', text: '我需要退款' },
  { role: 'seller', text: '您要退哪一单？' },
  { role: 'buyer', text: '抽纸这单' },
] });
assert.strictEqual(follow.plan.orderNo, 'S');
console.log('action-router：明确动作/退款追问/邀请规格/上下文选单 PASS');
