'use strict';
const assert = require('assert');
const { resolve } = require('../server/reference');

const orders = [{ hasOrder: true, orderNo: 'A', status: '已发货', items: [{ title: '金乡大蒜' }] }];
const products = [{ title: '天然花椒木站杆', stock: 4499 }, { title: '抽纸', stock: 300 }];

function check(name, input, fn) { const r = resolve(input); fn(r); console.log('  PASS ' + name); }

check('上一句其他大蒜品种 → 解析到大蒜，不问哪款', {
  buyerText: '还有货吗', messages: [{ role: 'buyer', text: '还有其他大蒜品种吗' }], orders, products,
}, (r) => { assert.ok(r.ref && /大蒜/.test(r.ref.title)); assert.strictEqual(r.ambiguity, false); });

check('我买的大蒜 → 命订单商品', {
  buyerText: '我买的大蒜还有货吗', messages: [], orders, products,
}, (r) => { assert.ok(r.ref && /大蒜/.test(r.ref.title)); });

check('无上下文、无目录命中 → 才允许问哪款', {
  buyerText: '还有货吗', messages: [], orders: [], products: [],
}, (r) => { assert.strictEqual(r.ref, null); assert.strictEqual(r.ambiguity, true); });

check('目录只有一个候选 → 可解析', {
  buyerText: '花椒木还有货吗', messages: [], orders: [], products,
}, (r) => { assert.ok(r.ref && /花椒木/.test(r.ref.title)); });
console.log('reference：4 PASS');
