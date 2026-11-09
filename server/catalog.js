'use strict';

/**
 * catalog.js —— 商品导入 + 自动归类 + 待归类队列
 *
 * 核心概念：这里的「品类」不是平台后台的类目树（蔬菜/根茎类），
 * 而是**买家嘴里会说的那个词**（萝卜、番茄、生菜、螺丝椒）。
 * 因为匹配是靠买家原话去撞它。
 *
 * 归类原则：宁可进队列，不可猜错。
 * 猜错的代价是「买家问萝卜，你推了白菜」，比不回答更伤。
 */

/** 通用词：出现只说明"可能是蔬菜"，不足以定品类 */
const GENERIC = ['萝卜', '白菜', '青菜', '菜', '瓜', '椒', '豆', '茄', '葱', '蒜', '姜', '莓', '玉米', '葵', '花', '苗', '草'];

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）【】《》,.!?;:()\[\]]/g, '');
}

/** 极简 CSV 解析：支持逗号、双引号包裹、引号内逗号 */
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];

  const split = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const header = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] || ''));
    return row;
  });
}

/** 从标题里抽候选品类词：取「种子/种籽/籽/苗」之前的片段 */
function extractCandidate(title) {
  const t = norm(title).replace(/^[0-9]+/, '');
  const m = t.match(/^(.{2,8}?)(种子|种籽|籽|苗|种)/);
  if (m) return m[1];
  return t.slice(0, 4);
}

/**
 * 判定一个商品该归到哪个品类
 * @returns {{category:string, confidence:number, reason:string, candidates:Array<{category:string,score:number}>}}
 */
function classifyTitle(title, products) {
  const t = norm(title);
  const cats = new Map(); // 品类 -> Set(别名)
  for (const p of products || []) {
    if (!p.category) continue;
    if (!cats.has(p.category)) cats.set(p.category, new Set([p.category]));
    for (const a of p.aliases || []) cats.get(p.category).add(a);
  }

  const scored = [];
  for (const [c, set] of cats) {
    let best = 0;
    for (const a of set) {
      const an = norm(a);
      if (!an) continue;
      if (t.includes(an)) best = Math.max(best, an.length >= 3 ? 0.96 : 0.9);
    }
    if (best) scored.push({ category: c, score: best });
  }
  scored.sort((a, b) => b.score - a.score);

  if (scored.length) {
    return { category: scored[0].category, confidence: scored[0].score, reason: '命中已有品类词', candidates: scored.slice(0, 3) };
  }

  const cand = extractCandidate(title);

  // 候选词包含已有品类词（螺丝椒 ⊃ 椒，但辣椒不在里面，所以仍会进队列）
  for (const [c, set] of cats) {
    for (const a of set) {
      const an = norm(a);
      if (an.length >= 2 && cand.includes(an)) {
        return { category: c, confidence: 0.78, reason: '候选词包含「' + a + '」', candidates: [{ category: c, score: 0.78 }] };
      }
    }
  }

  const generic = GENERIC.find((g) => cand.includes(g));
  if (generic) {
    return {
      category: '',
      confidence: 0.45,
      reason: '只识别出通用词「' + generic + '」，需人工确认',
      candidates: [],
      suggestion: cand,
    };
  }
  return { category: '', confidence: 0.2, reason: '无法判断品类，需人工归类', candidates: [], suggestion: cand };
}

/**
 * 导入 CSV 文本。已存在的商品按 goodsId 更新，新商品自动归类，判不准的进待归类。
 * @returns {{added:number, updated:number, pending:number, items:Array}}
 */
function importCsv(text, existing) {
  const rows = parseCsv(text);
  const work = (existing || []).slice();
  const byId = new Map(work.map((p) => [String(p.goodsId), p]));

  let added = 0;
  let updated = 0;
  let pending = 0;

  for (const r of rows) {
    const id = String(r['商品ID'] || r['goodsId'] || r['ID'] || '').trim();
    if (!id) continue;

    let item = byId.get(id);
    const isNew = !item;
    if (isNew) {
      item = { goodsId: id, title: '', price: 0, stock: 0, aliases: [], enabled: true };
      byId.set(id, item);
      work.push(item);
    }

    if (r['标题'] || r['title']) item.title = r['标题'] || r['title'];
    if (r['价格'] || r['price']) item.price = Number(r['价格'] || r['price']) || 0;
    if (r['库存'] || r['stock']) item.stock = Number(r['库存'] || r['stock']) || 0;
    if (r['链接'] || r['url']) item.url = r['链接'] || r['url'];
    if (r['规格'] || r['spec']) item.spec = String(r['规格'] || r['spec']).trim().slice(0, 80);

    const aliasCell = r['别名'] || r['aliases'];
    if (aliasCell) item.aliases = String(aliasCell).split(/[|,，、]/).map((s) => s.trim()).filter(Boolean);

    const givenCat = (r['品类'] || r['category'] || '').trim();
    if (givenCat) {
      item.category = givenCat;
      item.status = 'classified';
      item.classifyReason = '人工指定';
    } else if (!item.category) {
      const c = classifyTitle(item.title, work);
      item.category = c.category || '';
      item.status = c.category ? 'classified' : 'pending';
      item.classifyReason = c.reason;
      item.suggestions = c.candidates || [];
      item.suggestion = c.suggestion || '';
      if (item.status === 'pending') pending++;
    }

    if (isNew) added++;
    else updated++;
  }

  return { added, updated, pending, items: work };
}

/** 人工确认归类：同时把买家可能说的词补成别名 */
function applyClassification(products, goodsId, category, aliases) {
  const p = products.find((x) => String(x.goodsId) === String(goodsId));
  if (!p) return { ok: false, error: '商品不存在' };
  p.category = String(category || '').trim();
  if (!p.category) return { ok: false, error: '品类不能为空' };
  if (Array.isArray(aliases) && aliases.length) {
    p.aliases = [...new Set([...(p.aliases || []), ...aliases.map((s) => String(s).trim()).filter(Boolean)])];
  }
  p.status = 'classified';
  p.classifyReason = '人工确认';
  return { ok: true, item: p };
}

module.exports = { parseCsv, classifyTitle, importCsv, applyClassification, extractCandidate };
