'use strict';

/**
 * prompt.js —— 提示词与输出契约
 *
 * 原则：
 * 1. 只允许基于给定资料回答，资料里没有就说不知道并转人工；
 * 2. 不承诺赔付、时效、功效；不引导站外沟通；
 * 3. 输出严格 JSON，便于程序校验与降级。
 *
 * 两条输入形态：
 *   standard：knowledgeHits（【资料】），模型自由组织
 *   pro：facts（【事实】+ 编号），模型必须用 used 引用编号
 */

const { promptRule } = require('./style');
const { promptOf } = require('./tone');

const SYSTEM = `你是拼多多店铺的客服助手，为人工客服生成「可直接发送」的中文回复候选。

硬性规则：
1. 只能依据【资料】回答。资料里没有的信息，禁止编造；必须把 need_human 设为 true，并在 missing 里写清楚缺什么。
2. 不承诺赔付金额、不承诺具体到货时间、不承诺治疗效果或种植效果；不引导加微信/QQ/手机号，不发明文链接。
3. 语气像真人客服：短句、口语、先给结论再给理由，2~3 行以内，不超过 80 字（除非用户要求详细步骤）。
4. 一次给 3 条候选，分别是：标准版、简短版、安抚版。三条都必须可以直接发，不能出现占位符。
5. 不重复用户的话，不说"亲，您好，很高兴为您服务"这类空话。

输出严格 JSON（不要 markdown 代码块）：
{
  "intent": "logistics|spec|usage|price|refund|complaint|other",
  "confidence": 0.0-1.0,
  "candidates": [
    {"tone": "标准", "text": "..."},
    {"tone": "简短", "text": "..."},
    {"tone": "安抚", "text": "..."}
  ],
  "need_human": false,
  "missing": ""
}`;

const SYSTEM_FACTS = `你是拼多多店铺的客服助手，为人工客服生成「可直接发送」的中文回复候选。

硬性规则：
1. 只能依据【事实】回答。店铺事实（价格/库存/发货/快递/运费/发票/售后/订单）没有的，禁止编造；把 need_human 设为 true，并在 missing 里写清楚缺什么。
2. 输出 used：填实际用到的编号（如 ["F1"]），纯通用常识作答填 []。引用了不存在的编号会被丢弃。
3. 【缺失】的块只能给「以页面显示为准」「可以在订单页查看」这类口径，不许编状态、时间、金额。
4. 不承诺赔付金额、不承诺具体到货时间、不承诺治疗效果或种植效果；不引导加微信/QQ/手机号，不发明文链接。
5. 语气像真人客服：短句、口语、先给结论再给理由，2~3 行以内，不超过 80 字（除非用户要求详细步骤）。
6. 一次给 3 条候选：标准版、简短版、安抚版，都必须可以直接发，不能出现占位符。
7. 不说"亲，您好，很高兴为您服务"这类空话；不暴露内部（不说事实/资料/编号）。

输出严格 JSON（不要 markdown 代码块）：
{
  "intent": "logistics|spec|usage|price|refund|complaint|other",
  "confidence": 0.0-1.0,
  "used": ["F1"],
  "candidates": [
    {"tone": "标准", "text": "..."},
    {"tone": "简短", "text": "..."},
    {"tone": "安抚", "text": "..."}
  ],
  "need_human": false,
  "missing": ""
}`;

function factSection(facts) {
  const rows = (facts.items || []).map((f) => `[${f.id}] ${f.label}：${f.text}`);
  const miss = [...new Set((facts.missing || []).map((m) => (m && m.block) || '').filter(Boolean))];
  return {
    text: rows.length ? rows.join('\n') : '（无可用事实）',
    missing: miss.length ? `【缺失】${miss.join('、')}（只给页面口径，不许编）` : '',
  };
}

function buildMessages({ messages, knowledgeHits, goods, storeName, style, tier, facts }) {
  const history = (messages || [])
    .slice(-12)
    .map((m) => `${m.role === 'buyer' ? '买家' : m.role === 'seller' ? '客服' : '系统'}：${m.text}`)
    .join('\n');

  const goodsLine = goods && (goods.title || goods.goodsId)
    ? `当前咨询商品：${goods.title || ''}${goods.goodsId ? `（ID ${goods.goodsId}）` : ''}${goods.spec ? ` 规格：${goods.spec}` : ''}`
    : '当前咨询商品：未识别';

  const head = `店铺：${storeName || '未命名'}\n${goodsLine}\n\n【文风要求】\n${promptRule(style)}\n${promptOf(tier)}`;

  // Pro：事实包优先。没有资料段，只有带编号的事实，逼模型引用而不是自由发挥
  if (facts && Array.isArray(facts.items)) {
    const f = factSection(facts);
    const user = `${head}\n\n【事实】\n${f.text}\n${f.missing}\n\n【最近会话】\n${history}\n\n请只依据【事实】回复买家最后一条消息，并在 used 里填实际用到的编号。`;
    return [
      { role: 'system', content: SYSTEM_FACTS },
      { role: 'user', content: user },
    ];
  }

  const kb = (knowledgeHits || []).length
    ? knowledgeHits
        .map((h, i) => `[资料${i + 1}] ${h.entry.title}\n${h.entry.answer}`)
        .join('\n\n')
    : '（无匹配资料）';

  const user = `${head}\n\n【资料】\n${kb}\n\n【最近会话】\n${history}\n\n请基于以上资料，回复买家最后一条消息。`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

module.exports = { SYSTEM, SYSTEM_FACTS, buildMessages };
