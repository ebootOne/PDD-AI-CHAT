'use strict';

/**
 * manuals.js —— 商品说明书
 *
 * 为什么需要它：知识库回答的是「店铺政策」（发货/退换），说明书回答的是「这个商品怎么用」。
 * 这两件事的准确性来源不同：
 *   - 政策：全店一套
 *   - 用法：一个商品一套，而且经常互相矛盾（白萝卜要泡水、番茄不用）
 * 所以必须按 goodsId 绑定，绝不跨商品推断。
 *
 * 说明书必须是**分节**的，不能是一整段。因为"要泡水吗"这种问题要精确到节；
 * 整段发过去买家不会看。
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');
const { norm, bigrams } = require('./knowledge');

const FILE = 'manuals.json';

function seedPath() {
  return path.join(DATA_DIR, 'seed', 'manuals.json');
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

function find(goodsId, items) {
  const list = items || load();
  return list.find((m) => String(m.goodsId) === String(goodsId)) || null;
}

function overlap(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  let hit = 0;
  for (const g of a) if (set.has(g)) hit++;
  return hit / Math.max(4, Math.min(a.length, b.length));
}

/**
 * 按商品 + 问题找说明书里对应的那一节
 * @returns {{mode:'section'|'summary'|'none', manual?:object, sections?:Array, score?:number}}
 */
function match(goodsId, query, items) {
  const manual = find(goodsId, items);
  if (!manual) return { mode: 'none' };

  const q = norm(query);
  const qg = bigrams(query);

  const scored = (manual.sections || []).map((s) => {
    let score = 0;
    for (const kw of s.keywords || []) {
      const k = norm(kw);
      if (k && q.includes(k)) score += 3;
    }
    score += overlap(qg, bigrams((s.title || '') + (s.content || ''))) * 2;
    if (s.title && q.includes(norm(s.title))) score += 2;
    return { section: s, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];

  if (top && top.score >= 3) {
    // 两节分接近就一起给（比如"播种时间"和"播种深度"）
    const near = scored.filter((x) => x.score >= top.score - 1 && x.score >= 3).slice(0, 2);
    return { mode: 'section', manual, sections: near.map((x) => x.section), score: top.score };
  }

  // 没精确命中的节，但买家明显在问"怎么用" → 给使用摘要（不是全文）
  if (/怎么用|怎么种|使用|用法|步骤|教程|不会用/.test(query)) {
    return { mode: 'summary', manual, sections: (manual.sections || []).slice(0, 4), score: 0 };
  }

  return { mode: 'none', manual };
}

/** 生成候选回复 */
function candidatesOf(result) {
  if (!result || result.mode === 'none') return [];
  const m = result.manual;

  if (result.mode === 'section') {
    const parts = result.sections.map((s) => s.content).filter(Boolean);
    const text = parts.length === 1 ? parts[0] : parts.join('；');
    return [
      { tone: '标准', text: `${m.title}：${text}` },
      { tone: '简短', text: parts[0] },
    ];
  }

  // summary：给步骤，不发全文
  const steps = (result.sections || []).map((s, i) => `${i + 1}. ${s.title}：${String(s.content).slice(0, 40)}`).join('\n');
  return [
    { tone: '标准', text: `${m.title}的用法：\n${steps}` },
    { tone: '简短', text: `「${m.title}」的说明书我整理好了，您要哪部分我细说：${(result.sections || []).map((s) => s.title).join('、')}` },
  ];
}

module.exports = { load, save, find, match, candidatesOf };
