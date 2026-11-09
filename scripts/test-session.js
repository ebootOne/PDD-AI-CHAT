'use strict';

/**
 * test-session.js —— 一次完整的「测试会话」
 *
 * 模拟一个买家连续问 5 句，走真实的本地 → 服务端链路，打印每一轮的决策、来源、成本和回复。
 * 用来回答三个问题：
 *   1. 这条到底是谁答的（本地 / 服务端 / 兜底）？
 *   2. 花了多少点、多少钱？
 *   3. 哪些问题还需要补知识？
 *
 * 运行：node scripts/test-session.js
 * 可选：API_URL=http://127.0.0.1:8787 node scripts/test-session.js
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';

// 一个买家的 5 句话：从咨询到催单到投诉，覆盖主要分支
const SCRIPT = [
  '什么时候发货？',
  '你们有萝卜吗？',
  '怎么还没发货啊，急死了',
  '你们支持货到付款吗',
  '你们老板叫什么名字',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reply(messages, conversationId) {
  const res = await fetch(API + '/api/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      storeId: 'test',
      storeName: '测试店铺',
      conversationId,
      buyerName: '测试买家',
      messages,
      mode: 'suggest',
      requestId: 'ts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { decision: 'error', reason: text.slice(0, 120), suggestions: [] };
  }
  return data;
}

function pad(s, n) {
  const str = String(s == null ? '' : s);
  // 中文按 2 个宽度算
  let w = 0;
  for (const ch of str) w += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, n - w));
}

(async () => {
  console.log('\n════════ 测试会话 ════════');
  console.log('接口：' + API + '\n');

  const before = await fetch(API + '/api/quota').then((r) => r.json()).catch(() => ({}));
  const conversationId = 'test-session-' + Date.now().toString(36);
  const messages = [];
  const rows = [];

  for (let i = 0; i < SCRIPT.length; i++) {
    const buyerText = SCRIPT[i];
    messages.push({ role: 'buyer', text: buyerText });

    const r = await reply(messages, conversationId);
    const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || r.reason || '（无回复）';

    rows.push({
      turn: i + 1,
      buyer: buyerText,
      decision: r.decision,
      source: r.source || '-',
      cost: r.cost == null ? '-' : r.cost,
      conf: r.confidence == null ? '-' : r.confidence,
      reply: top,
    });

    // 把回复当客服发言放进上下文，模拟真实会话
    if (r.suggestions && r.suggestions.length) {
      messages.push({ role: 'seller', text: r.suggestions[0].text });
    }

    await sleep(300);
  }

  for (const row of rows) {
    console.log(`[第 ${row.turn} 轮] 买家：${row.buyer}`);
    console.log(
      `        决策 ${pad(row.decision, 10)} 来源 ${pad(row.source, 8)} 置信 ${pad(row.conf, 5)} 消耗 ${row.cost} 点`
    );
    console.log(`        → ${row.reply}`);
    console.log('');
  }

  const after = await fetch(API + '/api/quota').then((r) => r.json()).catch(() => ({}));
  const spent = (before.balance || 0) - (after.balance || 0);
  const bySource = rows.reduce((a, r) => ((a[r.source] = (a[r.source] || 0) + 1), a), {});

  console.log('════════ 汇总 ════════');
  console.log('来源分布：' + Object.entries(bySource).map(([k, v]) => `${k} ${v} 条`).join(' · '));
  console.log(`消耗点数：${spent} 点（余额 ${before.balance} → ${after.balance}）`);
  console.log(`服务端调用：${bySource.backend || 0} 次 · 本地命中：${bySource.rule || 0} 次 · 兜底：${bySource.none || bySource.fallback || 0} 次`);
  console.log('');
})();
