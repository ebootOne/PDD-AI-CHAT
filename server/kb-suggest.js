'use strict';

/**
 * kb-suggest.js —— 从兜底日志反推「该建哪条知识」
 *
 * 逻辑：翻最近日志 → 只挑 fallback/handoff 的买家原话 → 按问题类型归堆
 *      → 每堆超过 minCount 次，就推荐一条模板（或提示新建）
 *
 * 不猜内容，只做「哪类问题在反复答不上」的统计；具体事实仍要商家填。
 */

const store = require('./store');
const understand = require('./understand');
const templates = require('./kb-templates');

// 问题类型 → 最贴近的模板；没有对应模板的，提示新建
const ASK_TO_TPL = {};

const ASK_NAME = {
  courier: '快递公司',
  shipping_time: '发货时间',
  arrival_time: '到货时效',
  shipping_status: '物流查询',
  invoice: '发票',
  payment: '支付方式',
  return_policy: '退换货',
  after_sale: '售后',
  spec: '规格用量',
  usage: '种植方法',
  stock: '库存',
  price: '价格运费',
  recommend: '推荐/对比',
  nego: '议价',
  other: '其他',
};

function suggest(opts = {}) {
  const limit = Number(opts.limit) || 8;
  const minCount = Number(opts.minCount) || 2;
  const logs = store.getLogs(1000);
  const kb = store.getKnowledge();
  const imported = new Set(kb.map((k) => k.templateId).filter(Boolean));

  const groups = new Map();
  for (const l of logs) {
    if (!l.buyerText) continue;
    if (l.decision !== 'fallback' && l.decision !== 'handoff') continue;
    // 测试流量不算「真实知识缺口」；投诉/威胁是故意转人工，也不该推荐知识
    if (l.test) continue;
    if (['probe', 'probe100', 'qa'].includes(l.storeId)) continue;
    if (['探针买家', '随机买家', 'QA买家', '探针'].includes(l.buyerName)) continue;
    if (/投诉|举报|差评|骗子|假货|曝光/.test(l.buyerText)) continue;
    const un = understand.extract(l.buyerText);
    if (un.threat) continue;
    // 闲聊/越界/无法归类的，不当作知识缺口
    if (un.ask === 'other' || un.ask === 'greeting') continue;
    const tid = ASK_TO_TPL[un.ask] || null;
    const key = tid || 'ask:' + un.ask;
    const g = groups.get(key) || { key, ask: un.ask, templateId: tid, count: 0, samples: [] };
    g.count++;
    const text = String(l.buyerText).slice(0, 40);
    if (g.samples.length < 3 && !g.samples.includes(text)) g.samples.push(text);
    groups.set(key, g);
  }

  return [...groups.values()]
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((g) => {
      const t = g.templateId ? templates.find(g.templateId) : null;
      return {
        key: g.key,
        ask: g.ask,
        count: g.count,
        samples: g.samples,
        templateId: g.templateId,
        title: t ? t.title : '新建知识：' + (ASK_NAME[g.ask] || g.ask),
        category: t ? t.category : null,
        imported: g.templateId ? imported.has(g.templateId) : false,
      };
    });
}

// 新店还没有兜底日志时，也要把「最常见的几类」推到商家面前
const KEY_TEMPLATES = [];

function missing() {
  const kb = store.getKnowledge();
  const haveId = new Set(kb.map((k) => k.templateId).filter(Boolean));
  const haveTitle = new Set(kb.map((k) => String(k.title || '').trim()).filter(Boolean));
  return KEY_TEMPLATES.map((id) => templates.find(id))
    .filter(Boolean)
    .filter((t) => !haveId.has(t.id) && !haveTitle.has(String(t.title).trim()))
    .map((t) => ({ templateId: t.id, title: t.title, category: t.category }));
}

function importantCoverage() {
  const kb = store.getKnowledge();
  const haveId = new Set(kb.map((k) => k.templateId).filter(Boolean));
  const haveTitle = new Set(kb.map((k) => String(k.title || '').trim()).filter(Boolean));
  const total = KEY_TEMPLATES.length;
  const done = KEY_TEMPLATES.filter((id) => {
    const t = templates.find(id);
    return t && (haveId.has(id) || haveTitle.has(String(t.title).trim()));
  }).length;
  return { total, done, missing: missing() };
}

const TOP_NAME = {
  shipping_time: '发货时间', courier: '快递公司', arrival_time: '到货时效',
  invoice: '发票', payment: '支付方式', return_policy: '退换规则',
  after_sale: '售后', spec: '规格', stock: '库存', price: '价格运费',
  usage: '使用方法', nego: '议价', other: '其他',
};

const TOP_TPL = {};

/** 本店高频问题（按店铺统计，用于推荐该店最该补的模板） */
function topAsks(storeId, limit = 6) {
  const logs = store.getLogs(2000);
  const kb = store.getKnowledge();
  const imported = new Set(kb.map((k) => k.templateId).filter(Boolean));
  const cnt = new Map();
  for (const l of logs) {
    if (l.type !== 'reply') continue;
    if (storeId && l.storeId && l.storeId !== storeId) continue;
    const ask = l.ask || understand.detectAsk(String(l.buyerText || ''));
    if (!ask || ask === 'other' || ask === 'greeting' || ask === 'privacy') continue;
    cnt.set(ask, (cnt.get(ask) || 0) + 1);
  }
  return [...cnt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ask, count]) => ({
      ask,
      name: TOP_NAME[ask] || ask,
      count,
      templateId: TOP_TPL[ask] || null,
      imported: TOP_TPL[ask] ? imported.has(TOP_TPL[ask]) : false,
    }));
}

module.exports = { suggest, missing, importantCoverage, topAsks, ASK_TO_TPL };
