'use strict';

/**
 * test-sensitive.js —— 敏感词分层的机制回归
 *
 * 3 条该拦 + 1 条反例（知识库里的「微信、支付宝」是平台名，不是导流）。
 * 运行：node scripts/test-sensitive.js
 */

const sensitive = require('../server/sensitive');

const cases = [
  { name: '导流', text: '亲，加我微信发你地址', expectBlock: true },
  { name: '绝对化+赔付', text: '全网最低价，假一赔十', expectBlock: true },
  { name: '承诺时效', text: '保证明天一定到', expectBlock: true },
  { name: '反例·支付方式', text: '本店支持微信、支付宝、花呗', expectBlock: false },
];

let pass = 0;
for (const c of cases) {
  const r = sensitive.check(c.text, []);
  const ok = c.expectBlock ? !r.ok : r.ok;
  if (ok) pass++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + c.name + ' — ' + (r.hits.map((h) => h.word + '(' + h.reason + ')').join('、') || '未命中'));
}

const warn = sensitive.check('秒杀价，手慢无', []);
const warnOk = warn.ok && warn.warned.length > 0;
if (warnOk) pass++;
console.log((warnOk ? '  ✓ ' : '  ✗ ') + '促销词只警告不拦截 — warned=' + warn.warned.map((w) => w.word).join('、'));

console.log(`\n${pass}/${cases.length + 1} 通过`);
if (pass !== cases.length + 1) process.exitCode = 1;
