'use strict';

/**
 * probe-100.js —— 100 条随机买家的问法压测
 *
 * 目的：不是跑分，是找「同一种能力缺失」在不同问法下的表现。
 * 生成方式：商品 × 问法 × 地区随机组合（固定种子，可复现），去重后凑满 100 条。
 *
 * 运行：node scripts/probe-100.js [seed]
 * 产物：eval/probe100-report.md
 */

const fs = require('fs');
const path = require('path');

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'eval', 'probe100-report.md');
const SEED = Number(process.argv[2]) || 20261105;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const PRODUCTS = ['白萝卜', '樱桃萝卜', '胡萝卜', '番茄', '生菜', '黄瓜', '螺丝椒', '大白菜', '水果玉米', '香葱', '菠菜', '朝天椒'];
const REGIONS = ['河南', '黑龙江', '新疆', '内蒙古', '广东', '四川', '浙江'];
const OPENERS = ['', '', '', '你好，', '老板，', '问一下，', '请问', '在吗 '];

const T = {
  stock: ['有{p}种子吗', '{p}还有货吗', '有没有{p}', '{p}现在有货吗'],
  price: ['{p}多少钱', '{p}多钱一袋', '{p}怎么卖', '{p}价格多少', '{p}便宜点行吗'],
  ship: ['什么时候发货', '今天拍的能发吗', '下单后多久发货', '发什么快递', '能顺丰吗'],
  arrival: ['几天能到{r}', '发{r}要多久', '{r}多久能到', '到{r}运费多少'],
  usage: ['{p}怎么种', '{p}要泡水吗', '{p}泡多久', '{p}几月种合适', '{p}发芽温度多少', '{p}适合阳台种吗'],
  spec: ['{p}一袋多少克', '{p}一袋能种多少', '{p}一袋多少粒'],
  after: ['收到{p}种子坏了怎么办', '{p}种下去没出芽', '{p}不发芽怎么回事', '{p}少发了一袋'],
  policy: ['能开发票吗', '专票要什么资料', '包邮吗', '能货到付款吗', '拆封了还能退吗', '有优惠券吗'],
  threat: ['再不发货我就退款', '再拖我就投诉', '都三天了还没发', '再不处理就差评'],
  misc: ['你们老板电话多少', '能加微信吗', '你是不是机器人', '土壤pH多少合适', '一亩地要几袋', '能帮我写个总结吗', '你们公司地址在哪', '种子能过海关吗'],
};

const KINDS = ['stock', 'price', 'ship', 'arrival', 'usage', 'spec', 'after', 'policy', 'threat', 'misc'];
const WEIGHT = { stock: 12, price: 14, ship: 12, arrival: 10, usage: 16, spec: 8, after: 12, policy: 8, threat: 5, misc: 3 };

function weightedKind() {
  const total = Object.values(WEIGHT).reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (const k of KINDS) {
    r -= WEIGHT[k];
    if (r <= 0) return k;
  }
  return 'price';
}

function genOne() {
  const kind = weightedKind();
  let text = pick(T[kind]);
  text = text.replace(/\{p\}/g, pick(PRODUCTS)).replace(/\{r\}/g, pick(REGIONS));
  return (pick(OPENERS) + text).trim();
}

const CASES = [];
const seen = new Set();
let guard = 0;
while (CASES.length < 100 && guard < 5000) {
  guard++;
  const t = genOne();
  if (seen.has(t)) continue;
  seen.add(t);
  CASES.push(t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(text) {
  const res = await fetch(API + '/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: 'probe100',
      storeName: '测试店铺',
      conversationId: 'p100-' + Math.random().toString(36).slice(2, 9),
      buyerName: '随机买家',
      messages: [{ role: 'buyer', text }],
      mode: 'suggest',
      test: true,
    }),
  });
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch (_) {
    return { decision: 'error', reason: t.slice(0, 120), suggestions: [] };
  }
}

(async () => {
  const rows = [];
  for (const text of CASES) {
    const r = await call(text);
    const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || '';
    rows.push({
      text,
      ask: r.understanding && r.understanding.ask,
      dims: (r.understanding && r.understanding.dims) || [],
      decision: r.decision,
      source: r.source,
      conf: r.confidence,
      cost: r.cost,
      judge: r.judge || [],
      reply: top,
    });
    await sleep(80);
  }

  // 统计
  const byDecision = rows.reduce((m, r) => ((m[r.decision] = (m[r.decision] || 0) + 1), m), {});
  const byAsk = rows.reduce((m, r) => ((m[r.ask] = (m[r.ask] || 0) + 1), m), {});
  const judgeHits = rows.flatMap((r) => r.judge).reduce((m, j) => ((m[j] = (m[j] || 0) + 1), m), {});
  const zeroCost = rows.filter((r) => r.cost === 0).length;
  const backend = rows.filter((r) => r.source === 'backend').length;
  const fallback = rows.filter((r) => r.decision === 'fallback').length;

  // 同一个回复重复出现在不同问题下 = 串味/机械
  const replyCount = rows.filter((r) => r.reply).reduce((m, r) => ((m[r.reply] = (m[r.reply] || 0) + 1), m), {});
  const dupReplies = Object.entries(replyCount).filter(([, n]) => n > 1);

  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# 100 条随机问答压测',
    '',
    `> 种子 ${SEED} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '## 概览',
    '',
    `- 提问 ${rows.length} 条`,
    `- 决策：${Object.entries(byDecision).map(([k, v]) => k + ' ' + v).join(' · ')}`,
    `- 0 点（转人工/无回复）：${zeroCost} 条`,
    `- 服务端模型调用：${backend} 条`,
    `- 质检拦截：${Object.entries(judgeHits).map(([k, v]) => k + ' ' + v).join(' · ') || '无'}`,
    `- 同一回复重复出现：${dupReplies.length} 组`,
    '',
    '## 按问题类型',
    '',
    '| ask | 条数 |',
    '|---|---|',
    ...Object.entries(byAsk).sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '## 明细',
    '',
    '| # | 买家 | ask | 决策 | 来源 | 置信 | 点 | 质检 | 回复 |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${cell(r.text)} | ${r.ask || '-'} | ${r.decision} | ${r.source || '-'} | ${r.conf == null ? '-' : r.conf} | ${r.cost} | ${r.judge.join('、') || '-'} | ${cell(r.reply.slice(0, 90))} |`),
    '',
    '## 重复回复',
    '',
    ...(dupReplies.length ? dupReplies.map(([t, n]) => `- ×${n}：${t.slice(0, 80)}`) : ['- 无']),
  ];

  fs.writeFileSync(OUT, md.join('\n') + '\n');
  console.log(`提问 ${rows.length} · 0 点 ${zeroCost} · 服务端 ${backend} · 兜底 ${fallback}`);
  console.log('质检拦截：' + (Object.entries(judgeHits).map(([k, v]) => k + ' ' + v).join(' · ') || '无'));
  console.log('重复回复组：' + dupReplies.length);
  console.log('报告：' + OUT);
})();
