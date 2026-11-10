'use strict';

const assert = require('assert');
const path = require('path');
const products = require(path.join(__dirname, '..', 'server', 'products.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

check('S01', '无 storeId → 不返回别家商品', () => assert.deepStrictEqual(products.forStore(''), []));
check('S02', '按店取，不串店', () => {
  const a = products.forStore('smw8rjgmx');
  const b = products.forStore('smw8o8zx0');
  assert.ok(a.every((p) => p.storeId === 'smw8rjgmx'));
  assert.ok(b.every((p) => p.storeId === 'smw8o8zx0'));
});
check('S03', '演示店保留种子商品', () => assert.ok(products.forStore('demo').length > 0));
check('S04', '没有 storeId 的旧商品已归到 demo', () => {
  const all = products.load();
  assert.ok(all.every((p) => p.storeId));
});

console.log(`\n店铺隔离：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
