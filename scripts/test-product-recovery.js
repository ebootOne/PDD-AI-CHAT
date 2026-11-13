'use strict';
const assert = require('assert');
const API = process.env.API_URL || 'http://127.0.0.1:8787';
const STORE = 'test-recovery';

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function ask(text) {
  const r = await post('/api/reply', {
    storeId: STORE, engine: 'pro', mode: 'suggest', test: true, storeName: 'recovery',
    conversationId: 'rec-' + Date.now(), messages: [{ role: 'buyer', text }],
    goods: { title: '恢复测试商品', goodsId: 'g1' },
  });
  return r;
}
(async () => {
  await post('/api/products/sync', {
    storeId: STORE,
    items: [{ goodsId: 'g1', title: '恢复测试商品', price: 9.9, stock: 7, status: 'on_sale' }],
  });
  const r = await ask('还有货吗');
  const t = (r.suggestions || [])[0] && r.suggestions[0].text || '';
  assert.ok(/有货|库存/.test(t), '恢复上架后应能回答库存：' + t);
  assert.ok(!/不在本店在售/.test(t), '恢复后不能再说不在售：' + t);

  await post('/api/products/sync', { storeId: STORE, items: [], confirmEmpty: true });
  console.log('product-recovery：同步上架→库存可答→清空 PASS');
})();
