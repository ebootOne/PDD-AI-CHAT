'use strict';
const assert = require('assert');
const idx = require('../server/product-index');
const context = require('../server/context');

const products = [];
for (let i = 1; i <= 100; i++) products.push({ goodsId: 'x' + i, title: '测试商品' + i + '号', stock: i });
products.push({ goodsId: 'garlic', title: '金乡大蒜精品大果', price: 9.9, stock: 4499 });
products.push({ goodsId: 'tissue', title: '抽纸大包', price: 12.26, stock: 300 });

const hit = idx.search(products, '还有大蒜吗', 5);
assert.ok(hit.length <= 5, 'topK <= 5');
assert.ok(hit.some((p) => /大蒜/.test(p.title)), '能检索到大蒜');

const packet = context.build({
  buyerText: '还有货吗',
  messages: [{ role: 'buyer', text: '还有其他大蒜品种吗' }],
  orders: [{ hasOrder: true, orderNo: 'A', items: [{ title: '金乡大蒜' }] }],
  products,
});
assert.ok(packet.catalog.length >= 100, '本地保留全量索引');
assert.ok(packet.items.filter((x) => x.block === 'product').length <= 5, '不把100个商品塞进上下文');
assert.ok(packet.reference.ref && /大蒜/.test(packet.reference.ref.title), '能解析大蒜主题');
console.log('product-index：100 商品检索 PASS');
