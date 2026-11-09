'use strict';

const assert = require('assert');
const path = require('path');
const p = require(path.join(__dirname, '..', 'server', 'persona.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${id}  ${name}`); }
  catch (e) { fails.push(`${id} ${name} — ${e.message}`); console.log(`  FAIL  ${id} ${name} — ${e.message}`); }
}

const s = p.system();
check('P01', '人格包含专业客服身份', () => assert.ok(s.includes('专业素养')));
check('P02', '事实优先但不强制', () => assert.ok(s.includes('有事实就用事实') && s.includes('没有相关事实')));
check('P03', '永远回复、不还嘴', () => assert.ok(s.includes('无论买家说什么') && s.includes('不还嘴')));
check('P04', '底线：不承诺、不泄露', () => assert.ok(s.includes('不承诺') && s.includes('不泄露')));
check('P05', '输出 JSON 结构', () => assert.ok(s.includes('"candidates"') && s.includes('"used"')));
check('P08', '事实相关性/冲突规则', () => assert.ok(s.includes('不相关就忽略') && s.includes('矛盾')));
check('P07', '说人话规则', () => assert.ok(s.includes('说人话') && s.includes('早上8点')));
check('P06', '版本可追踪', () => assert.ok(/^\d+\.\d+\.\d+$/.test(p.PERSONA_VERSION)));

console.log(`\n客服人格：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) process.exit(1);
