'use strict';

const assert = require('assert');
const path = require('path');
const n = require(path.join(__dirname, '..', 'server', 'natural.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

check('N01', '08:00~23:00 → 早上8点到晚上11点', () => assert.strictEqual(n.speakTime('08:00~23:00'), '早上8点到晚上11点'));
check('N02', '16:00 → 下午4点', () => assert.strictEqual(n.speakTime('16:00前付款'), '下午4点前付款'));
check('N03', '09:30 → 上午9点30分', () => assert.strictEqual(n.speakTime('09:30'), '上午9点30分'));
check('N04', '不改数字含义', () => assert.strictEqual(n.speakTime('1~2天'), '1~2天'));
check('N05', 'hoursText 正确', () => assert.strictEqual(n.hoursText({ start: '08:00', end: '23:00' }), '早上8点到晚上11点'));

console.log(`\n口语化：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
