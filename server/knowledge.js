'use strict';

/**
 * knowledge.js —— 知识检索（中文二元组 + 关键词加权，零依赖）
 *
 * 为什么不用向量检索：
 * - 客服知识库规模小（几十到几百条），关键词 + 二元组已经够用；
 * - 可解释：每条命中都能说出「命中了哪个关键词/哪几个字」，便于运营修正；
 * - 无需向量库与 embedding 费用，离线可用。
 * 后续条目超过 ~2000 条再引入向量检索，接口保持不变。
 */

const STOP = new Set(['的', '了', '吗', '呢', '啊', '吧', '是', '有', '我', '你', '在', '就', '都', '和', '与', '不', '这', '那', '一个', '可以', '怎么', '什么', '多少', '请问', '一下', '谢谢', '你好']);

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:()\[\]]/g, '');
}

function bigrams(text) {
  const s = norm(text);
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    if (!STOP.has(g)) out.push(g);
  }
  return out;
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let hit = 0;
  for (const g of a) if (setB.has(g)) hit++;
  return hit / Math.max(4, Math.min(a.length, b.length));
}

/**
 * 给单条知识打分，并把每一项的贡献拆开返回（便于解释和调参）。
 *
 * 打分不是"必须全部命中"，而是四项独立累加：
 *   关键词命中  3 分起，词越长加得越多（最多 +2）
 *   标题命中    +2
 *   二元组重合  重合率 × 2（模糊匹配，兜住换个说法的问法）
 *   商品专属    +1.5（这条知识绑定了当前咨询的商品）
 */
// 疑问语气词不该影响匹配：「包邮吗」和「包邮」是同一件事
function stripTail(s) {
  return String(s || '').replace(/[吗呢吧啊呀嘛哦哈]+$/, '');
}

function scoreEntry(query, entry, scope = {}) {
  const q = stripTail(norm(query));
  const qg = bigrams(query);

  const kwHits = [];
  let kwScore = 0;
  for (const kw of entry.keywords || []) {
    const k = stripTail(norm(kw));
    // 双向包含：句子含关键词，或关键词含整句（「包邮」应命中关键词「包邮吗」）。
    // 反向只在整句足够长（≥2 字且覆盖关键词 60%）时启用，避免「有」这种单字全命中。
    const reverse = k.includes(q) && q.length >= 2 && q.length >= k.length * 0.6;
    if (k && (q.includes(k) || reverse)) {
      const s = 3 + Math.min(2, k.length / 4);
      kwScore += s;
      kwHits.push({ kw, score: Number(s.toFixed(2)) });
    }
  }

  const titleScore = entry.title && q.includes(norm(entry.title)) ? 2 : 0;
  const body = overlap(qg, bigrams((entry.question || '') + (entry.title || '')));
  const bodyScore = body * 2;
  const bonus = scope.goodsId && (entry.goodsIds || []).includes(scope.goodsId) ? 1.5 : 0;

  return {
    kwHits,
    kwScore: Number(kwScore.toFixed(2)),
    titleScore,
    body: Number(body.toFixed(2)),
    bodyScore: Number(bodyScore.toFixed(2)),
    bonus,
    total: Number((kwScore + titleScore + bodyScore + bonus).toFixed(2)),
  };
}

/**
 * 检索知识条目
 * @param {string} query 买家最新一句话
 * @param {Array} entries 知识条目
 * @param {{storeId?:string, goodsId?:string}} scope 作用域过滤
 * @returns {Array<{entry:object, score:number, reasons:string[], detail:object}>}
 */
function retrieve(query, entries, scope = {}) {
  const results = [];

  for (const entry of entries || []) {
    if (entry.enabled === false) continue;
    if (entry.storeId && scope.storeId && entry.storeId !== scope.storeId) continue;
    if (entry.goodsIds && entry.goodsIds.length && scope.goodsId && !entry.goodsIds.includes(scope.goodsId)) continue;

    const d = scoreEntry(query, entry, scope);
    if (d.total <= 0.6) continue;

    const reasons = [];
    for (const h of d.kwHits) reasons.push('关键词:' + h.kw);
    if (d.titleScore) reasons.push('标题命中');
    if (d.body > 0) reasons.push('语义近似:' + d.body.toFixed(2));
    if (d.bonus) reasons.push('商品专属');

    results.push({ entry, score: d.total, reasons, detail: d });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 4);
}

/** 把检索分数映射为 0~1 置信度（经验值，需用真实会话回归校准） */
function confidenceFromScore(score) {
  if (!score) return 0;
  return Math.max(0, Math.min(0.98, 0.35 + Math.log10(1 + score) * 0.9));
}

module.exports = { retrieve, scoreEntry, confidenceFromScore, norm, bigrams };
