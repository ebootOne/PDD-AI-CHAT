'use strict';
const assert = require('assert');
const { build } = require('../server/context');

const packet = build({
  storeId: 's1',
  goods: { title: '当前商品' },
  orders: [
    { hasOrder: true, orderNo: 'A9410', status: '已发货', items: [{ title: '大蒜' }], packages: [{ courier: '申通', trackingNo: '773451233139410' }] },
    { hasOrder: true, orderNo: 'B6789', status: '待发货', items: [{ title: '抽纸' }] },
  ],
  products: [{ storeId: 's1', title: '大蒜', price: 9.9, stock: 2 }],
  kb: [{ storeId: 's1', title: '发货时间', answer: '当天发' }],
  messages: [{ role: 'buyer', text: '还有其他大蒜品种吗' }],
  profile: { hours: { start: '08:00', end: '23:00' } },
});
const blocks = new Set(packet.allItems.map((x) => x.block));
assert.ok(blocks.has('order') && blocks.has('product') && blocks.has('policy') && blocks.has('conversation'));
assert.strictEqual(packet.allItems.filter((x) => x.block === 'order').length, 2);
assert.ok(packet.items.length <= 8);
assert.ok(packet.blocks.find((b) => b.type === 'policy' && b.available));
assert.ok(packet.items.find((x) => x.id === 'O1').text.includes('申通'));
assert.ok(!JSON.stringify(packet).includes('13800000000'));
console.log('上下文候选池：PASS；items=' + packet.items.length + '；' + JSON.stringify(packet.stats));
