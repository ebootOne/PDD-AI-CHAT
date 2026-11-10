'use strict';
const assert = require('assert');
const reg = require('../server/block-registry');
const ctx = require('../server/context');
const packet = ctx.build({
  storeId: 's1',
  goods: { title: '天然花椒木站杆', goodsId: 'g1' },
  orders: [{ hasOrder: true, orderNo: 'A9410', status: '已发货', items: [{ title: '大蒜' }] }],
  products: [{ storeId: 's1', goodsId: 'g1', title: '站杆', price: 1.85 }],
  kb: [{ storeId: 's1', title: '包邮与运费', answer: '包邮' }],
  messages: [{ role: 'buyer', text: '怎么清洗' }],
  manual: { sections: [{ title: '清洁保养', content: '清水刷洗' }] },
});
const blocks = packet.blocks;
assert.ok(blocks.find((b) => b.type === 'order' && b.available));
assert.ok(blocks.find((b) => b.type === 'manual' && b.sections.includes('清洁保养')));
assert.ok(blocks.find((b) => b.type === 'tracking' && !b.available));
const r = reg.resolve(packet, [
  { block: 'manual', selector: { section: '清洁保养' } },
  { block: 'order', selector: { orderId: 'A9410' } },
]);
assert.strictEqual(r.items.length, 2);
assert.ok(r.items.some((x) => x.block === 'manual') && r.items.some((x) => x.block === 'order'));
const bad = reg.resolve(packet, [{ block: 'tracking' }]);
assert.ok(bad.errors.length && !bad.items.length);
console.log('事实块目录/解析：PASS');
