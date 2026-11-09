'use strict';

/**
 * probe-accuracy.js —— 用「随机改写 + 多轮指代」压测回复准确率
 *
 * 目的不是打分，而是暴露「缺了哪种判断能力」：
 *   - 同一知识点的不同说法，召回是否稳定
 *   - 指代/省略/多轮上下文，能否接住
 *   - 知识库没有的问题，会不会硬答（编造）
 *   - 语气/长度/承诺，是否符合客服场景
 *
 * 运行：node scripts/probe-accuracy.js
 * 依赖：本地服务已启动（node server/index.js）
 * 产物：eval/accuracy-report.md
 */

const fs = require('fs');
const path = require('path');

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'eval', 'accuracy-report.md');

// ---------------------------------------------------------------- 单轮语料
// 覆盖：口语/错字/省略/多意图/未知/越界/风险。刻意不写成知识库原句。
const SINGLE = [
  ['发货', '啥时候发货'],
  ['发货', '今天拍的今天能发不'],
  ['到货', '多久能到啊 我在河南'],
  ['到货', '发到黑龙江得几天'],
  ['运费', '包邮不'],
  ['运费', '新疆能发吗'],
  ['运费', '内蒙古要补多少运费'],
  ['发票', '能开发票吗 要专票'],
  ['发票', '开票要提供什么'],
  ['发芽率', '发芽率多少'],
  ['发芽率', '你们种子靠谱吗 别是陈种子'],
  ['催芽', '怎么泡种'],
  ['催芽', '泡多久'],
  ['播种', '现在种还来得及吗 河北'],
  ['播种', '冬天能种吗'],
  ['规格', '一袋多少克'],
  ['规格', '一袋能种多少地'],
  ['议价', '能便宜点不 我买10袋'],
  ['议价', '有优惠券吗'],
  ['支付', '货到付款可以不'],
  ['退货', '拆了还能退吗'],
  ['售后', '收到货坏了怎么办'],
  ['物流', '发什么快递'],
  ['招呼', '老板在不在'],
  ['推荐', '推荐个适合阳台种的'],
  ['对比', '这个和樱桃萝卜哪个好'],
  ['未知', '种子能过海关吗'],
  ['越界', '你们公司地址在哪'],
  ['越界', '能帮我写个请假条吗'],
  ['身份', '你是不是机器人'],
  ['农艺', '土壤pH多少合适'],
  ['农艺', '一亩地要几袋'],
  ['税务', '专票税率多少'],
  ['物流', '能不能顺丰到付'],
  ['风险', '再不发货我就退款'],
  ['风险', '你们卖假种子 我要投诉'],
  ['错字', '多钱一袋'],
  ['错字', '种子到货了没'],
  ['方言', '咋种啊'],
  ['语气', '急死了 到底发不发'],
];

// ---------------------------------------------------------------- 多轮语料
const MULTI = [
  { id: 'M1', name: '商品 → 价格 → 数量+运费', turns: ['有番茄种子吗', '多少钱', '两袋包邮吗'] },
  { id: 'M2', name: '种植 → 要不要泡水 → 泡多久', turns: ['白萝卜怎么种', '要泡水吗', '泡多久'] },
  { id: 'M3', name: '发货 → 催 → 退款威胁', turns: ['什么时候发货', '我都等三天了', '再不发就退款'] },
  { id: 'M4', name: '发票 → 专票 → 税率', turns: ['能开发票吗', '专票呢', '税率多少'] },
  { id: 'M5', name: '有货 → 阳台适配 → 用量', turns: ['有黄瓜种子吗', '这个适合阳台吗', '一袋能种几盆'] },
  { id: 'M6', name: '发芽率 → 没出芽 → 怎么办', turns: ['发芽率多少', '我种了没出芽', '那怎么办'] },
];

// 机制回归：同一类威胁的 3 种说法 + 1 个反例（买家真问退款政策，不该套威胁模板）
const MERCHANT_CLASS = [
  ['威胁变体1', '再不发货我就退了'],
  ['威胁变体2', '再拖我就申请退款'],
  ['威胁变体3', '今天再不发出我就退款'],
  ['反例·退款咨询', '我想退款，怎么退'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(messages, conversationId) {
  const res = await fetch(API + '/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: 'probe',
      storeName: '测试店铺',
      conversationId,
      buyerName: '探针买家',
      messages,
      mode: 'suggest',
      test: true,
      requestId: 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    return { decision: 'error', reason: text.slice(0, 200), suggestions: [] };
  }
}

// 自动红旗：只标「大概率有问题」，最终由人判
function flagsOf(r, prevReplies, topic) {
  const f = [];
  const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || '';
  if (/undefined|null|NaN|\[object/.test(top)) f.push('脏输出');
  if (!top) f.push('无回复');
  if (prevReplies.includes(top)) f.push('复读');
  if (r.decision === 'fallback' && !['未知', '越界', '身份', '风险'].includes(topic)) f.push('疑似漏召回');
  if (r.decision === 'suggest' && ['未知', '越界'].includes(topic) && top.length > 20) f.push('可能硬答');
  if (/保证|一定|100%|绝对|肯定能/.test(top)) f.push('绝对化承诺');
  if (/赔|退款|补发/.test(top) && topic !== '售后' && topic !== '风险') f.push('赔付口吻');
  if (top.length > 160) f.push('过长');
  if (r.decision === 'handoff') f.push('转人工');
  return f;
}

(async () => {
  const report = [
    '# 回复准确率探测',
    '',
    '> 自动生成：' + new Date().toLocaleString('zh-CN', { hour12: false }),
    '> 单轮 ' + SINGLE.length + ' 条 + 多轮 ' + MULTI.length + ' 组（每组 ' + MULTI[0].turns.length + ' 轮）',
    '',
  ];
  const rows = [];
  const multiRows = [];

  for (const [topic, text] of SINGLE) {
    const r = await call([{ role: 'buyer', text }], 'probe-s-' + Math.random().toString(36).slice(2, 8));
    rows.push({ topic, text, r, flags: flagsOf(r, [], topic) });
    await sleep(120);
  }

  for (const sc of MULTI) {
    const cid = 'probe-m-' + sc.id + '-' + Math.random().toString(36).slice(2, 6);
    const messages = [];
    const prev = [];
    const turns = [];
    for (const buyer of sc.turns) {
      messages.push({ role: 'buyer', text: buyer });
      const r = await call(messages, cid);
      turns.push({ buyer, r, flags: flagsOf(r, prev, '多轮') });
      const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || '';
      prev.push(top);
      // 和真实客户端一致：把客服已发的回复带回上下文，多轮焦点才有依据
      if (top) messages.push({ role: 'seller', text: top });
      await sleep(120);
    }
    multiRows.push({ sc, turns });
  }

  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

  report.push('## 单轮', '', '| 主题 | 买家 | 意图 | 决策 | 来源 | 置信 | 点数 | 回复（首条） | 红旗 |', '|---|---|---|---|---|---|---|---|---|');
  for (const { topic, text, r, flags } of rows) {
    const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || r.reason || '（无）';
    report.push(
      `| ${topic} | ${cell(text)} | ${r.intent} | ${r.decision} | ${r.source || '-'} | ${r.confidence == null ? '-' : r.confidence} | ${r.cost} | ${cell(top.slice(0, 120))} | ${flags.join('、') || '-'} |`
    );
  }

  report.push('', '## 多轮', '');
  for (const { sc, turns } of multiRows) {
    report.push(`### ${sc.id} ${sc.name}`, '');
    for (const t of turns) {
      const top = (t.r.suggestions && t.r.suggestions[0] && t.r.suggestions[0].text) || t.r.reason || '（无）';
      report.push(`- **买家**：${t.buyer}`);
      report.push(`  - 决策 ${t.r.decision} · 来源 ${t.r.source || '-'} · 置信 ${t.r.confidence == null ? '-' : t.r.confidence} · ${t.r.cost} 点${t.flags.length ? ' · 红旗：' + t.flags.join('、') : ''}`);
      report.push(`  - 回复：${top.slice(0, 160)}`);
    }
    report.push('');
  }

  // 机制回归：威胁类回复必须「先道歉 + 有动作 + 不提退款」；反例必须按退款政策答，不能被套模板
  const mech = [];
  for (const [name, text] of MERCHANT_CLASS) {
    const r = await call([{ role: 'buyer', text }], 'probe-x-' + Math.random().toString(36).slice(2, 8));
    const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || '';
    const isTpl = /不好意思|抱歉/.test(top) && /马上|催|尽快|安排/.test(top);
    const ok = name.startsWith('反例') ? !/我会/.test(top) && /退/.test(top) : isTpl && !/退款|退货/.test(top);
    mech.push({ name, text, ok, top, decision: r.decision, cost: r.cost });
  }
  report.push('', '## 机制回归：威胁类', '', '| 用例 | 买家 | 结果 | 决策 | 回复 |', '|---|---|---|---|---|');
  for (const m of mech) {
    report.push(`| ${m.name} | ${cell(m.text)} | ${m.ok ? '✓' : '✗'} | ${m.decision} | ${cell(m.top.slice(0, 100))} |`);
  }

  const allFlags = rows.flatMap((x) => x.flags).concat(multiRows.flatMap((m) => m.turns.flatMap((t) => t.flags)));
  const tally = allFlags.reduce((m, f) => ((m[f] = (m[f] || 0) + 1), m), {});
  report.push('## 红旗汇总', '', Object.entries(tally).map(([k, v]) => `- ${k}：${v}`).join('\n') || '- 无');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, report.join('\n') + '\n');

  console.log('单轮 ' + rows.length + ' 条，多轮 ' + multiRows.length + ' 组');
  console.log('红旗汇总：' + (Object.entries(tally).map(([k, v]) => k + ' ' + v).join(' · ') || '无'));
  console.log('报告：' + OUT);
})();
