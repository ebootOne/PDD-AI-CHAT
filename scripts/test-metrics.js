'use strict';

/**
 * test-metrics.js —— 指标汇总单测（不起服务、不读文件）
 */

const assert = require('assert');
const path = require('path');
const { summarize, pct } = require(path.join(__dirname, '..', 'server', 'metrics.js'));

let pass = 0;
const fails = [];
function check(id, name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS  ${id}  ${name}`);
  } catch (e) {
    fails.push(`${id} ${name} — ${e.message}`);
    console.log(`  FAIL  ${id} ${name} — ${e.message}`);
  }
}

const now = Date.now();
const iso = (ago) => new Date(now - ago).toISOString();
const logs = [
  { type: 'reply', ts: iso(1000), engine: 'pro', source: 'backend', decision: 'suggest', cost: 0.6, latencyMs: 1500, factMode: 'normal', factTokens: 50, factItems: 2, factRegistry: 'reg_x', factInvalid: 0 },
  { type: 'reply', ts: iso(2000), engine: 'pro', source: 'rule', decision: 'suggest', cost: 0.5, latencyMs: 10, factMode: 'wide', factTokens: 100, factItems: 3, factMissing: 'order' },
  { type: 'reply', ts: iso(3000), engine: 'pro', source: 'policy', decision: 'fallback', cost: 0.5, latencyMs: 20, factMode: 'empty', factTokens: 0, factItems: 0, factMissing: 'all' },
  { type: 'reply', ts: iso(4000), engine: 'standard', source: 'rule', decision: 'suggest', cost: 0.5, latencyMs: 5 },
  { type: 'reply', ts: iso(5000), engine: 'standard', source: 'backend', decision: 'suggest', cost: 0.7, latencyMs: 900 },
  { type: 'reply', ts: iso(8 * 24 * 3600 * 1000), engine: 'pro', source: 'backend', decision: 'suggest', cost: 9 },
];

const m = summarize(logs, { since: now - 24 * 3600 * 1000 });

check('M01', '只统计窗口内', () => assert.strictEqual(m.total, 5, String(m.total)));
check('M02', '模型调用率', () => assert.strictEqual(m.model, 2, String(m.model)));
check('M03', '本地命中（非模型、非转人工）', () => assert.strictEqual(m.local, 3, String(m.local)));
check('M04', '兜底数', () => assert.strictEqual(m.fallback, 1, String(m.fallback)));
check('M05', '平均扣点', () => assert.strictEqual(m.avgPoints, 0.56, String(m.avgPoints)));
check('M06', '按引擎拆：pro 3 条', () => assert.strictEqual(m.byEngine.pro.replies, 3));
check('M07', '按引擎拆：pro 模型率 33.3', () => assert.strictEqual(m.byEngine.pro.modelRate, 33.3, String(m.byEngine.pro.modelRate)));
check('M08', '按引擎拆：standard 模型率 50', () => assert.strictEqual(m.byEngine.standard.modelRate, 50, String(m.byEngine.standard.modelRate)));
check('M09', '事实包平均 tokens', () => assert.strictEqual(m.fact.avgTokens, 50, String(m.fact.avgTokens)));
check('M10', '扩召回率', () => assert.strictEqual(m.fact.wideRate, 33.3, String(m.fact.wideRate)));
check('M11', '注册表命中率（只按有字段的包算）', () => assert.strictEqual(m.fact.registryRate, 100, String(m.fact.registryRate)));
check('M12', '缺失包计数', () => assert.strictEqual(m.fact.missing, 2, String(m.fact.missing)));
check('M13', '空窗口不炸', () => {
  const z = summarize([], { since: now });
  assert.strictEqual(z.total, 0);
  assert.strictEqual(z.avgPoints, 0);
  assert.strictEqual(z.fact.avgTokens, 0);
});
check('M14', 'pct 边界', () => {
  assert.strictEqual(pct(0, 0), 0);
  assert.strictEqual(pct(1, 3), 33.3);
});

console.log(`\n指标单测：${pass} PASS / ${fails.length} FAIL`);
if (fails.length) {
  console.log(fails.join('\n'));
  process.exit(1);
}
