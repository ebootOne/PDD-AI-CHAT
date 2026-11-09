'use strict';

/**
 * tone.js —— 语气档位（register）
 *
 * 核心认知：「礼貌」不是一个要求，是四种场景下的四种行为。
 *   咨询要「清楚」、催单要「先认等待」、投诉要「先接情绪再谈事实」、夸奖要「回应情绪」。
 * 所以不是给一句提示词，而是判定场景 → 选档 → 每档有自己的开场、禁用、长度。
 *
 * 只做四档。档位越多，商家越管不过来，模型越容易串味。
 */

const TIERS = {
  standard: {
    key: 'standard',
    name: '标准',
    desc: '普通咨询：直接给答案，简洁清楚',
    openers: [],
    forbid: [],
    maxLen: 140,
  },
  apology: {
    key: 'apology',
    name: '歉意',
    desc: '催单/售后/投诉：先承认让对方等了，再给动作',
    openers: ['抱歉', '不好意思', '让您久等', '理解您', '给您添麻烦'],
    // 这一档最怕乱承诺
    forbid: ['马上就到', '保证', '一定', '立刻发'],
    maxLen: 160,
  },
  warm: {
    key: 'warm',
    name: '热情',
    desc: '夸奖/感谢/复购：回应情绪，别只回"不客气"',
    openers: ['谢谢', '感谢', '很高兴', '太客气'],
    forbid: ['好评返现', '给个好评'],
    maxLen: 120,
  },
  pro: {
    key: 'pro',
    name: '专业',
    desc: '规格/用法/对比：给结论，再给依据',
    openers: [],
    forbid: ['绝对', '最好', '100%', '保证活'],
    maxLen: 180,
  },
};

const ORDER = ['apology', 'warm', 'pro', 'standard'];

/**
 * 判定该用哪一档
 * @param {string} text 买家最后一句
 * @param {{intent?:string, risks?:string[]}} ctx
 */
function detectTier(text, ctx = {}) {
  const t = String(text || '');
  const intent = ctx.intent || '';
  const risks = ctx.risks || [];

  // 1) 投诉/索赔/催单 → 歉意
  if (risks.length || intent === 'complaint' || intent === 'refund') return 'apology';
  if (/催|怎么还没|还没发|等多久|等了一天|怎么回事|生气|失望|骗|差评|投诉/.test(t)) return 'apology';

  // 2) 夸奖/感谢 → 热情
  if (/谢谢|感谢|好评|满意|回购|推荐|收到了|太好了|不错/.test(t)) return 'warm';

  // 3) 规格/用法/对比 → 专业
  if (intent === 'spec' || intent === 'usage') return 'pro';
  if (/区别|参数|含量|成分|适合|怎么用|怎么种|能不能种|哪个好/.test(t)) return 'pro';

  return 'standard';
}

/** 给提示词用的这一档的约束 */
function promptOf(tier) {
  const p = TIERS[tier] || TIERS.standard;
  const lines = [
    `当前语气档位：${p.name}（${p.desc}）`,
    `句子长度控制在 ${p.maxLen} 字以内`,
  ];
  if (p.forbid.length) lines.push(`不要出现：${p.forbid.join('、')}`);
  return lines.join('；') + '。';
}

/** 输出侧：这一档的最低要求（没做到就打标，不改写事实） */
function checkTone(text, tier) {
  const p = TIERS[tier] || TIERS.standard;
  const issues = [];
  if (p.openers.length && !p.openers.some((o) => String(text).startsWith(o))) {
    issues.push('缺少本档应有的人情话开场');
  }
  for (const w of p.forbid) {
    if (String(text).includes(w)) issues.push('出现本档禁用表达：' + w);
  }
  if (String(text).length > p.maxLen) issues.push('超出本档建议长度');
  return issues;
}

/** 候选排序：歉意档优先用「安抚」那条 */
function preferCandidate(candidates, tier) {
  if (tier !== 'apology' || candidates.length < 2) return candidates;
  const idx = candidates.findIndex((c) => /安抚|歉意/.test(c.tone || ''));
  if (idx <= 0) return candidates;
  const copy = candidates.slice();
  const [item] = copy.splice(idx, 1);
  copy.unshift(item);
  return copy;
}

module.exports = { TIERS, ORDER, detectTier, promptOf, checkTone, preferCandidate };
