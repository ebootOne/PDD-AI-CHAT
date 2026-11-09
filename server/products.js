'use strict';

/**
 * products.js —— 商品目录与「买家问有没有某商品」的匹配
 *
 * 为什么单独一层：
 *   知识库回答的是「政策/说明」（发货、退货、发芽率）；
 *   商品匹配回答的是「有没有、哪款、多少钱」——它依赖的是店铺真实商品数据，
 *   每天都在变，不能写进知识库。
 *
 * 匹配不用向量：商品标题本身就是关键词堆出来的（"意大利生菜种子籽四季播耐寒…"），
 * 用「品类词 + 别名」做精确命中，比向量稳、可解释、零成本。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = 'products.json';

function seedPath() {
  return path.join(DATA_DIR, 'seed', 'products.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILE), 'utf8'));
  } catch (_) {
    try {
      return JSON.parse(fs.readFileSync(seedPath(), 'utf8'));
    } catch (_) {
      return [];
    }
  }
}

function save(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, FILE), JSON.stringify(items, null, 2), 'utf8');
  return items.length;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/…+/g, '')            // 真实商品卡标题会被截断，带省略号（ISS-006）
    .replace(/[.．·]+$/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:()\[\]]/g, '');
}

// 提问词/虚词：2 字片段命中标题时用来排除
const STOP_WORDS = new Set(['多少', '少钱', '钱一', '一袋', '一包', '怎么', '什么', '有没', '没有', '现在', '还有', '价格', '便宜', '包邮', '发货', '多久', '几天', '可以', '行吗', '哪儿', '哪个', '这个', '那个', '是不', '不是', '我想', '我要', '你们', '你家']);

/**
 * 从一句话里找商品
 * @returns {{query:string, items:Array, best:object|null, score:number, confidence:number}|null}
 */
function match(text, items) {
  const q = norm(text);
  if (!q) return null;

  const scored = [];
  for (const p of items) {
    if (p.enabled === false) continue;
    // 待归类的商品不参与回答：宁可说"没有"，也不能推错货
    if (p.status === 'pending') continue;
    const keys = [p.category, ...(p.aliases || [])].filter(Boolean).map(norm);
    let score = 0;
    const reasons = [];

    for (const k of keys) {
      if (!k) continue;
      if (q.includes(k)) {
        // 品类词越长越可信：「胡萝卜」必须压过「萝卜」，否则问胡萝卜会推白萝卜
        score += 3 + Math.min(3, k.length);
        reasons.push('命中词:' + k);
        break; // 同款只计一次
      }
    }

    if (score === 0) {
      // 退一步：品类名比口语长（「大叶菠菜」vs「菠菜」），用 2 字词双向兜住。
      // 只认非提问词，避免「多少钱」「怎么卖」把不相干商品捞出来。
      const STOP2 = STOP_WORDS;
      for (let i = 0; i + 2 <= q.length; i++) {
        const g = q.slice(i, i + 2);
        if (STOP2.has(g)) continue;
        if (keys.some((k) => k.includes(g))) {
          score += 2.5;
          reasons.push('近义词:' + g);
          break;
        }
      }
    }

    if (score === 0) {
      // 再退一步：标题里的片段被问到（先 3 字，再 2 字——「抽纸」只有 2 字）
      const t = norm(p.title);
      const hit = (n, need) => {
        for (let i = 0; i + n <= q.length; i++) {
          const g = q.slice(i, i + n);
          if (STOP_WORDS.has(g)) continue;
          if (t.includes(g)) return g;
        }
        return '';
      };
      const g3 = hit(3);
      if (g3) {
        score += 1;
        reasons.push('标题片段:' + g3);
      } else {
        const g2 = hit(2);
        if (g2) {
          score += 0.8;
          reasons.push('标题词:' + g2);
        }
      }
    }

    if (score > 0) {
      if (Number(p.stock) > 0) score += 0.5;
      scored.push({ item: p, score, reasons });
    }
  }

  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  const sameTier = scored.filter((x) => x.score >= top.score - 1.2).slice(0, 3);

  // 置信度：精确品类 + 有货 → 高；只有片片段命中 → 低
  const exact = top.reasons.some((r) => r.startsWith('命中词'));
  const inStock = Number(top.item.stock) > 0;
  // 精确品类就算没货，也是"确定是这款"，置信度不能压低，否则会被服务端覆盖成"没查到"
  let confidence = 0.55;
  if (exact) confidence += 0.3;
  if (inStock) confidence += 0.08;
  if (top.score >= 6) confidence += 0.05;
  confidence = Math.min(0.96, Number(confidence.toFixed(2)));

  // 只有一款商品被命中（没有竞争项）：说明"他问的就是这一款"，不该因为匹配词短就被判低置信
  if (scored.length === 1 && top.score > 0) confidence = Math.max(confidence, 0.86);

  return {
    query: text,
    items: sameTier.map((x) => x.item),
    best: top.item,
    score: Number(top.score.toFixed(2)),
    confidence,
    reasons: top.reasons,
  };
}

function find(goodsId, items) {
  const list = items || load();
  return list.find((p) => String(p.goodsId) === String(goodsId)) || null;
}

/** 用聊天里的商品卡标题反查商品（标题可能被截断，取包含关系最长的） */
function findByTitle(title, items) {
  const t = norm(title);
  if (!t) return null;
  const list = items || load();
  let best = null;
  let bestLen = 0;
  for (const p of list) {
    const pt = norm(p.title);
    if (!pt) continue;
    if (pt === t || pt.includes(t) || t.includes(pt)) {
      const len = Math.min(pt.length, t.length);
      if (len > bestLen) {
        bestLen = len;
        best = p;
      }
    }
  }
  return best;
}

module.exports = { load, save, match, find, findByTitle, norm };
