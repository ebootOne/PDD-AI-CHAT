'use strict';

/**
 * focus.js —— 多轮焦点：别把上一句原样再说一遍
 *
 * 只做两件事，不猜语义、不编新事实：
 *   1. 买家只回了很短一句（≤10 字）→ 优先给「简短」候选，别整段复读；
 *   2. 首选候选与上一句客服发言完全一样 → 换成别的候选；都一样就加一句引导语。
 *
 * 宁可多一句「再说一遍」，也不为了显得聪明去猜他问的是哪一截。
 */

function norm(s) {
  return String(s || '').replace(/^(亲|您好|你好)[，,]?\s*/, '').replace(/[\s，。！？!?、；;：:]/g, '');
}

function adjust(suggestions, messages, buyerText) {
  const list = Array.isArray(suggestions) ? suggestions.slice() : [];
  if (!list.length) return { suggestions: list, note: '' };

  const sellers = (messages || []).filter((m) => m.role === 'seller');
  const last = sellers.length ? norm(sellers[sellers.length - 1].text) : '';
  const shortFollow = norm(buyerText).length <= 10;

  if (shortFollow && list.length > 1) {
    const i = list.findIndex((s) => s.tone === '简短');
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }

  if (last && norm(list[0].text) === last) {
    const alt = list.find((s) => norm(s.text) !== last);
    if (alt) {
      list.splice(list.indexOf(alt), 1);
      list.unshift(alt);
      return { suggestions: list, note: '换候选' };
    }
    // 没有别的候选时，直接保留原回答；不加“刚才说过/再说一遍”这类元评论
    return { suggestions: list, note: '保持原答' };
  }

  return { suggestions: list, note: '' };
}

module.exports = { adjust, norm };
