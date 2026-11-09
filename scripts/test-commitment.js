'use strict';

/**
 * test-commitment.js —— 承诺面机制回归
 *
 * 3 条该拦（投诉假承诺 / 索取单号照片 / 兜底假跟进）+ 1 条反例（有人值守时允许跟进）。
 * 运行：node scripts/test-commitment.js
 */

const engine = require('../server/engine');
const judge = require('../server/judge');
const policy = require('../server/policy');

const baseCfg = {
  mode: 'suggest',
  autoIntentWhitelist: ['logistics', 'spec', 'usage'],
  autoMinConfidence: 0.82,
  businessHours: { enabled: false, start: '08:00', end: '23:00' },
  forbiddenOutput: [],
  llm: { baseUrl: '' },
  salutation: { enabled: true, text: '亲', onlyFirst: false },
  capabilities: { humanAvailable: false },
};

const BAD = ['安排人', '跟进', '反馈给店里', '稍后回复', '帮我查', '帮您查', '订单号', '照片', '核实一下'];

function hasBad(text) {
  return BAD.filter((w) => String(text).includes(w));
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + detail));
}

(async () => {
  // 1. 投诉、无店铺声明 → 只道歉，不假承诺
  const r1 = await engine.generate(
    { storeId: 's1', messages: [{ role: 'buyer', text: '你们卖假种子 我要投诉' }] },
    baseCfg,
    [],
    {}
  );
  const t1 = (r1.suggestions[0] || {}).text || '';
  check('投诉（无声明）不假承诺', hasBad(t1).length === 0, hasBad(t1).join('、') + ' | ' + t1);

  // 2. 投诉、有「正规渠道」声明 → 陈述事实
  const kb = [{ id: 'st1', title: '正规渠道', type: 'statement', enabled: true, keywords: ['正规'], answer: '我们的种子都是从正规渠道进货的。' }];
  const r2 = await engine.generate(
    { storeId: 's1', messages: [{ role: 'buyer', text: '你们卖假种子 我要投诉' }] },
    baseCfg,
    kb,
    {}
  );
  const t2 = (r2.suggestions[0] || {}).text || '';
  check('投诉（有声明）说正规渠道', t2.includes('正规渠道'), t2);
  check('投诉（有声明）仍不假承诺', hasBad(t2).length === 0, hasBad(t2).join('、'));

  // 3. 售后回复在索取订单号/照片 → 质检必须换掉
  const v3 = judge.review({
    buyerText: '收到货坏了怎么办',
    understanding: { ask: 'after_sale', text: '收到货坏了怎么办' },
    suggestions: [{ tone: '标准', text: '您先别急，把订单号和照片发我，我帮您走售后流程。' }],
    knowledge: [{}],
    products: [],
    capabilities: { humanAvailable: false },
  });
  const t3 = (v3.suggestions && v3.suggestions[0] && v3.suggestions[0].text) || policy.merchantReply(v3.replyKind, { capabilities: {} });
  check('售后索取单号照片被拦', v3.action === 'replace' && hasBad(t3).length === 0, v3.action + ' | ' + t3);

  // 4. 兜底话术本身不含假跟进
  const fb = policy.pickFallback({ risks: ['投诉威胁'], intent: 'complaint', attempt: 0, capabilities: { humanAvailable: false } });
  check('兜底话术无假跟进', hasBad(fb.text).length === 0, fb.text);

  // 5. 反例：有人值守时，允许「已通知客服跟进」
  const v5 = judge.review({
    buyerText: '你们卖假种子 我要投诉',
    understanding: { ask: 'other', text: '你们卖假种子 我要投诉' },
    suggestions: [{ tone: '标准', text: '非常抱歉，已通知客服跟进处理。' }],
    knowledge: [{}],
    products: [],
    capabilities: { humanAvailable: true },
  });
  check('反例：有人值守允许跟进', v5.action === 'keep', v5.action + ' ' + (v5.issues || []).join(','));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
})();
