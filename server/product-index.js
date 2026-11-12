'use strict';

/** 商品检索：标题/规格/别名/订单商品名，返回 top-K，不遍历全店给模型 */

function norm(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/^\d{2,4}年/, '')
    .replace(/^加量\d+[张包]/, '')
    .replace(/^大包/, '');
}

function tokens(text) {
  const q = norm(text);
  const set = new Set();
  if (!q) return set;
  for (let i = 0; i < q.length; i++) {
    for (const n of [2, 3, 4]) {
      if (i + n <= q.length) set.add(q.slice(i, i + n));
    }
  }
  return set;
}

function score(product, queryTokens) {
  const title = norm(product.title);
  if (!title) return 0;
  let n = 0;
  for (const t of queryTokens) {
    if (title.includes(t)) n += t.length >= 3 ? 3 : 1;
    if (norm(product.spec || '').includes(t)) n += 1;
    if ((product.aliases || []).some((a) => norm(a).includes(t))) n += 2;
  }
  return n;
}

function search(products, query, limit = 5) {
  const list = Array.isArray(products) ? products.filter((p) => p && p.title) : [];
  const qs = tokens(query);
  if (!qs.size) return [];
  return list
    .map((p) => ({ p, s: score(p, qs) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);
}

module.exports = { search, tokens, norm };
