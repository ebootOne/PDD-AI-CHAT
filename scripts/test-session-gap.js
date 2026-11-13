'use strict';
const assert = require('assert');
const context = require('../server/context');
const orders = [{ hasOrder: true, orderNo: 'A', status: '已发货', items: [{ title: '金乡大蒜' }] }];
const messages = [
  { role: 'buyer', text: '还有其他大蒜品种吗' },
  { role: 'seller', text: '其他品种看页面' },
  { role: 'buyer', text: '有货嘛' },
];

const fresh = context.build({ buyerText: '有货嘛', messages, orders, sessionGapMinutes: 5, products: [] });
assert.ok(fresh.reference.ref && /大蒜/.test(fresh.reference.ref.title), '30分钟内继承话题');

const stale = context.build({ buyerText: '有货嘛', messages, orders, sessionGapMinutes: 1440, products: [] });
assert.strictEqual(stale.reference.ref, null, '跨天不继承旧话题');
assert.ok(stale.items.some((x) => x.id === 'S1'), '注入新会话段事实');
console.log('session-gap：5分钟继承 / 1440分钟重置 PASS');
