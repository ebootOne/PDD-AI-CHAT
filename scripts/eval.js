'use strict';

/**
 * eval.js —— 评测跑分器
 *
 * 干什么：把 eval/cases.jsonl 里的真实会话逐条喂给回复引擎，按「决策 + 要点 + 红线」打分，
 *        输出通过率、按意图分桶、失败明细，并落盘 eval/last-report.json。
 *
 * 为什么不用「标准答案精确匹配」：客服回复可以有很多种说法，精确匹配会把正确的答案判错。
 * 所以只校验三件事：
 *   1) 决策对不对（该自动的自动、该转人工的转人工）
 *   2) 必须说到的要点在不在（mustContain）
 *   3) 绝对不能说出口的词在不在（mustNotContain + 全局红线词）
 *
 * 运行：node scripts/eval.js [cases.jsonl]
 */

const fs = require('fs');
const path = require('path');
const engine = require('../server/engine');
const store = require('../server/store');

const CASE_FILE = process.argv[2] || path.join(__dirname, '..', 'eval', 'cases.jsonl');
const REPORT_FILE = path.join(__dirname, '..', 'eval', 'last-report.json');

// 离线评测：不给模型通道，测的是本地引擎本身（有通道时低置信会交模型，结果就不稳定）
const cfg = Object.assign(store.getConfig(), { mode: 'auto', backend: {}, llm: {} });
// 评测跑在真实店铺的知识上（本店优先，通用只补缺）
const KB = (() => {
  const raw = store.getKnowledge().filter((k) => !k.archived);
  const mine = raw.filter((k) => k.storeId === 'real');
  const titles = new Set(mine.map((k) => k.title));
  return mine.concat(raw.filter((k) => !k.storeId && !titles.has(k.title)));
})();

function loadCases() {
  if (!fs.existsSync(CASE_FILE)) throw new Error('找不到评测集: ' + CASE_FILE);
  return fs
    .readFileSync(CASE_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`第 ${i + 1} 行不是合法 JSON: ${e.message}`);
      }
    });
}

function checkCase(c, result) {
  const problems = [];

  if (result.decision !== c.expectDecision) {
    problems.push(`决策 ${result.decision} ≠ 期望 ${c.expectDecision}（${result.reason}）`);
  }

  const suggestions = result.suggestions || [];
  const allText = suggestions.map((s) => s.text).join('\n');

  if (c.expectDecision !== 'handoff') {
    if (!suggestions.length) {
      problems.push('没有给出可发送的候选');
    } else {
      const top = suggestions[0].text;
      for (const need of c.mustContain || []) {
        if (!top.includes(need)) problems.push(`首条候选缺少要点「${need}」`);
      }
    }
  }

  for (const bad of c.mustNotContain || []) {
    if (allText.includes(bad)) problems.push(`命中了禁止词「${bad}」`);
  }

  // 全局红线：任何候选都不能出现
  // 注意：不能裸拦「转账」「到付」——「货到付款」「微信支付」是正常说法，只拦引导线下交易的语境
  const redlines = ['微信号', '加我微信', '宝贝', '好评返现', '私下转账', '私下到付', '线下交易', '100%', '绝对'];
  for (const w of redlines) {
    if (allText.includes(w)) problems.push(`触犯全局红线「${w}」`);
  }

  return problems;
}

(async () => {
  const cases = loadCases();
  const rows = [];

  for (const c of cases) {
    const ctx = {
      storeId: 'real',
      storeName: '评测店',
      conversationId: c.id,
      messages: c.messages,
      goods: { title: c.goodsTitle || '', goodsId: '' },
      mode: 'auto',
    };
    let result;
    try {
      result = await engine.generate(ctx, cfg, KB, { rateOk: true });
    } catch (e) {
      result = { decision: 'error', reason: e.message, suggestions: [], knowledge: [], latencyMs: 0 };
    }
    const problems = checkCase(c, result);
    rows.push({
      id: c.id,
      intent: c.intent,
      difficulty: c.difficulty,
      expect: c.expectDecision,
      got: result.decision,
      source: result.source,
      confidence: result.confidence,
      knowledge: (result.knowledge || []).map((k) => k.id),
      reply: (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
      pass: problems.length === 0,
      problems,
    });
  }

  const pass = rows.filter((r) => r.pass).length;
  const byIntent = {};
  for (const r of rows) {
    byIntent[r.intent] = byIntent[r.intent] || { total: 0, pass: 0 };
    byIntent[r.intent].total++;
    if (r.pass) byIntent[r.intent].pass++;
  }

  console.log('\n评测结果：' + pass + '/' + rows.length + ' 通过（' + ((pass / rows.length) * 100).toFixed(1) + '%）\n');

  for (const [intent, s] of Object.entries(byIntent)) {
    console.log(`  ${intent.padEnd(10)} ${s.pass}/${s.total}`);
  }

  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    console.log('\n未通过：');
    for (const r of failed) {
      console.log(`  ✗ ${r.id} [${r.intent}] ${r.problems.join('；')}`);
      console.log(`     实际回复：${r.reply.slice(0, 60) || '(无)'}`);
    }
  }

  fs.writeFileSync(
    REPORT_FILE,
    JSON.stringify({ ts: new Date().toISOString(), pass, total: rows.length, byIntent, rows }, null, 2),
    'utf8'
  );
  console.log('\n报告已写入 ' + path.relative(process.cwd(), REPORT_FILE));
  if (pass !== rows.length) process.exitCode = 1;
})();
