'use strict';

/**
 * qa-scenarios.js —— 模拟真实买家会话，检验对话质量
 *
 * 不是"功能测试"，是"像真人一样聊"，然后人来看哪里不对劲。
 * 输出一份 markdown 报告：每轮买家说了什么、工具答了什么、走的哪条路。
 *
 * 运行：node scripts/qa-scenarios.js
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const fs = require('fs');
const path = require('path');

const SCENARIOS = [
  {
    id: 'S1',
    name: '催发货 → 情绪升级 → 威胁退款',
    turns: ['在吗', '我买的白萝卜种子怎么还没发货', '都三天了，你们是不是不打算发了', '再不发货我就退款'],
  },
  {
    id: 'S2',
    name: '商品咨询 → 价格 → 用量 → 种植条件',
    turns: ['有白萝卜种子吗', '多少钱一袋', '一袋能种多少地', '北方现在能种吗'],
  },
  {
    id: 'S3',
    name: '售后：不发芽 → 质疑质量 → 要说法',
    turns: ['我买的种子种下去一周了还没出芽', '是不是你们种子有问题', '那你们打算怎么处理'],
  },
  {
    id: 'S4',
    name: '多轮指代：怎么种 → 要不要泡水 → 泡多久',
    turns: ['这个种子怎么种', '那要泡水吗', '泡多久合适'],
  },
  {
    id: 'S5',
    name: '议价：能便宜点吗 → 别家更便宜',
    turns: ['能便宜点吗', '隔壁店一样的比你便宜五块'],
  },
  {
    id: 'S6',
    name: '越界：要老板电话 → 要微信',
    turns: ['你们老板电话是多少', '那你发我个微信吧，方便问'],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(messages, conversationId) {
  const res = await fetch(API + '/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: 'qa',
      storeName: '测试店铺',
      conversationId,
      buyerName: 'QA买家',
      messages,
      mode: 'suggest',
      test: true,
      requestId: 'qa-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { decision: 'error', reason: text.slice(0, 200), suggestions: [] };
  }
}

(async () => {
  const report = ['# 真实会话模拟 · 质检报告', '', '> 自动生成：' + new Date().toLocaleString('zh-CN', { hour12: false }), ''];

  for (const sc of SCENARIOS) {
    const convId = 'qa-' + sc.id + '-' + Date.now().toString(36);
    const messages = [];
    report.push(`## ${sc.id} ${sc.name}`, '');

    for (let i = 0; i < sc.turns.length; i++) {
      const buyer = sc.turns[i];
      messages.push({ role: 'buyer', text: buyer });
      const r = await call(messages, convId);
      const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || r.reason || '（无回复）';

      report.push(`**买家 ${i + 1}**：${buyer}`);
      report.push('');
      report.push(`> ${top}`);
      report.push('');
      report.push(
        `\`决策 ${r.decision} · 来源 ${r.source} · 语气 ${r.tierName || '-'} · 置信 ${r.confidence == null ? '-' : r.confidence} · ${r.cost == null ? '-' : r.cost} 点\``
      );
      report.push('');

      if (r.suggestions && r.suggestions[0]) messages.push({ role: 'seller', text: r.suggestions[0].text });
      await sleep(300);
    }
    report.push('---', '');
  }

  const out = path.join(__dirname, '..', 'eval', 'qa-report.md');
  fs.writeFileSync(out, report.join('\n'), 'utf8');
  console.log(report.join('\n'));
  console.log('\n报告已写入 ' + out);
})();
