'use strict';

/**
 * concerns.js —— 「买家到底在担心什么」
 *
 * 和 ask 的区别：ask 是问题类型（问价/问库存），concern 是这句话背后的关切。
 * 「这个木头有没有质检报告」的 ask 是 stock，但关切是"凭证"。
 * 只按 ask 兜底就会出现「库存以商品页显示为准」这种答非所问。
 *
 * 一张表，三处共用：engine（是否算命中）、judge（对题校验）、policy（兜底文案）。
 */

const CONCERNS = [
  {
    key: 'safety',
    q: /中毒|有毒|安全|误食|啃了|吃了|过敏|有害|会不会伤/,
    a: /无毒|没有毒|安全|放心|可以啃|啃咬正常|无害|不影响/,
    fallback: '亲，这款是天然原木，正常啃咬是安全的哈。注意保持干燥，发现开裂及时更换就好。',
  },
  {
    key: 'evidence',
    q: /质检|报告|证书|检测|资质|认证|成分/,
    a: /报告|检测|质检|证书|资质|认证/,
    fallback: '亲，检测报告这类凭证以商品页标注为准哈；这款是天然原木，正常使用没问题。',
  },
  {
    key: 'region',
    q: /新疆|西藏|香港|澳门|台湾|海外|国外|境外/,
    a: /新疆|西藏|香港|澳门|台湾|海外|境外|发不了|不发|寄不了/,
    fallback: '', // 没有配送口径就转人工，不编"能发/不能发"
  },
];

function detect(text) {
  const t = String(text || '');
  for (const c of CONCERNS) if (c.q.test(t)) return c;
  return null;
}

/** 这句话没答到关切点（问证书，答"有货"） */
function mismatch(text, answer, extra = '') {
  const c = detect(text);
  if (!c) return false;
  const a = String(answer || '') + ' ' + String(extra || '');
  return !c.a.test(a);
}

function fallbackText(text) {
  const c = detect(text);
  return c ? c.fallback : '';
}

module.exports = { CONCERNS, detect, mismatch, fallbackText };
