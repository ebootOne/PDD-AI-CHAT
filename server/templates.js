'use strict';

/**
 * templates.js —— 只保留四个常规模板
 *
 *  发货时间 / 快递公司 / 包邮（无地区） / 发票（普票）
 *
 * 匹配是「常见说法 + 守卫」，不做整句精确表，也不做意图引擎。
 * 守卫命中（发货了吗/内蒙古包邮/专票抬头）就不走模板，交模型。
 */

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[，。！？!?、；;：:\s"'“”‘’~～]/g, '')
    .replace(/^(请问一下|请问|想问一下|想问下|问一下|麻烦问下|麻烦问一下|你好|您好)/, '');
}

const RULES = [
  {
    id: 'shipping_time',
    ask: 'shipping_time',
    test: /(什么时候|啥时候|多久|几天|几点).{0,6}(发货|发出|发)|发货(要|需要)?多久|发货时间/,
    guard: /发货了吗|发了吗|发了没|发出没|到哪|物流|订单|退款|退货|收到|签收/,
  },
  {
    id: 'courier',
    ask: 'courier',
    test: /(发什么|什么|哪家|哪个|用哪家|默认).{0,4}快递|快递公司|什么物流/,
    guard: /顺丰|指定|到付|到了吗|到哪|物流|订单|发货了吗/,
  },
  {
    id: 'freight',
    ask: 'freight',
    test: /包邮|运费|邮费|免运费/,
    guard: /新疆|西藏|内蒙古|港澳|台湾|海外|偏远|补多少/,
  },
  {
    id: 'invoice',
    ask: 'invoice',
    test: /发票|开票/,
    guard: /专票|抬头|税号|公司|纸质|电子/,
  },
];

function match(text) {
  const t = norm(text);
  if (!t) return null;
  for (const r of RULES) {
    if (r.guard.test(t)) continue;
    if (r.test.test(t)) return { id: r.id, ask: r.ask };
  }
  return null;
}

const LOCAL_ASKS = new Set(RULES.map((r) => r.ask));

module.exports = { match, norm, RULES, LOCAL_ASKS };
