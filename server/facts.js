'use strict';

/**
 * facts.js —— Pro 的事实包：路由 → 取数 → 预算
 *
 * 为什么单独一层（docs/36）：
 *   普通版是「本地有答案就本地答」；Pro 是「本地只取事实，语言交给模型」。
 *   模型答错的根因通常不是不会说话，而是不知道这一单的事实、或知道太多无关事实。
 *   所以这里只做三件事：决定取哪几块、每块只取必要字段、总预算 ≤ 800 tokens。
 *
 * 硬约束：
 *   1. 只读白名单字段，收件人/电话/地址永远不进事实包；
 *   2. 每条事实带稳定 id（F1、F2…），模型必须引用，质检按 id 校验；
 *   3. 不为了「看起来聪明」扩包：预算满了就按优先级丢，并记 dropped。
 *
 * 本模块不生成任何话术，只产出结构化事实。
 */

const manualStore = require('./manuals');
const knowledge = require('./knowledge');
const productStore = require('./products');
const concerns = require('./concerns');
const understand = require('./understand');

const TOKEN_LIMIT = 800; // 硬上限（docs/36）
const TOKEN_SOFT = 680; // 实际目标：留 15% 余量，避免估算误差顶穿
const MAX_ITEMS = 8;
const FACT_MAX_CHARS = 190;
const PER_ITEM_OVERHEAD = 8; // 「[F1] 价格：」这类前缀的估算成本

// 订单块的关键信号：出现这些，说明买家在问「我这一单」，没有订单数据就不能编
const ORDER_SIGNAL = /我的|这单|订单|单号|物流|到哪|发了没|发货了吗|发出没|什么时候到|催一下|查一下/;

// 零散知识（通用常识）与店铺政策的区别：前者可以自由表述，后者必须逐字有据
const STORE_ASK = new Set([
  'price', 'stock', 'shipping_time', 'arrival_time', 'shipping_status',
  'courier', 'freight', 'invoice', 'payment', 'return_policy', 'after_sale', 'spec',
]);

// 不同问法要的商品字段：只取必要的那一个，不整条商品塞进去
const PRODUCT_FIELDS = {
  price: ['price'],
  nego: ['price'],
  stock: ['stock'],
  spec: ['spec'],
  product: ['price', 'stock'],
};

/** 粗估 token：中文按 0.7、英文按 1.3、数字按 0.6 计，偏保守（宁多算不少算） */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]+/g) || []).length;
  const digits = (s.match(/\d+(?:\.\d+)?/g) || []).length;
  const other = Math.max(0, s.length - cjk);
  return Math.ceil(cjk * 0.7 + latin * 1.3 + digits * 0.6 + other * 0.35);
}

/**
 * 事实包里的文字一律过一遍：手机号、邮箱、身份证、详细地址不出现。
 * 这里只做「抹掉」，不做打码占位（占位符会占模型注意力，也没必要）。
 */
function scrub(text) {
  return String(text || '')
    .replace(/1[3-9]\d{9}/g, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '')
    .replace(/\d{17}[\dxX]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t\u3000]+/g, ' ')
    .trim();
}

/** 截断到 FACT_MAX_CHARS，尽量断在句末，避免半句话被模型当完整事实 */
function clip(text, max = FACT_MAX_CHARS) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return (at >= max * 0.5 ? cut.slice(0, at + 1) : cut.slice(0, max - 1) + '…');
}

/** 把买家一句话拆成子问题，用来识别多意图（「多少钱，发什么快递」） */
function splitAsks(text) {
  const raw = String(text || '');
  const parts = raw.split(/[。！？!?；;，,\n]+/).map((x) => x.trim()).filter(Boolean);
  const asks = [];
  for (const p of parts) {
    const a = understand.detectAsk(p);
    if (a && a !== 'other' && a !== 'greeting' && !asks.includes(a)) asks.push(a);
  }
  if (!asks.length) {
    const a = understand.detectAsk(raw);
    if (a && a !== 'other' && a !== 'greeting') asks.push(a);
  }
  return { asks: asks.slice(0, 3), parts };
}

function priceText(p) {
  const lo = Number(p.price);
  const hi = Number(p.priceMax);
  if (!Number.isFinite(lo)) return '';
  if (Number.isFinite(hi) && hi > lo) return `${lo} 元起（最高 ${hi} 元）`;
  return `${lo} 元`;
}

/** 说明书按「名词」编节（深度/间距），买家却问「多深/多厚」：取数前先把问法对齐 */
const MANUAL_ALIAS = [
  [/多深|多厚|埋多深|覆土多深/g, '深度'],
  [/多宽|多稀/g, '间距'],
];

function manualQuery(text) {
  let s = String(text || '');
  for (const [re, to] of MANUAL_ALIAS) s = s.replace(re, to);
  return s;
}

/**
 * 当前商品：优先引擎已匹配的（已过作用域/新鲜度），其次商品卡（标题或 goodsId）。
 * 商品卡是买家/客服正在看的那个商品，不能因为这句话里没提商品名就丢掉说明书。
 */
function resolveGoods(goods, products, storeId) {
  if (Array.isArray(products) && products[0]) return products[0];
  const g = goods || {};
  const scoped = productStore.load().filter((p) => !storeId || !p.storeId || p.storeId === storeId);
  if (g.goodsId) {
    const hit = productStore.find(g.goodsId, scoped);
    if (hit) return hit;
  }
  if (g.title) {
    const hit = productStore.findByTitle(g.title, scoped);
    if (hit) return hit;
  }
  return g.goodsId || g.title ? { goodsId: g.goodsId, title: g.title } : null;
}

/** 商品块：只取被问到的字段 */
function productItems(goodsInfo, asks) {
  if (!goodsInfo) return { items: [], missing: [] };
  const need = new Set();
  for (const a of asks) for (const f of PRODUCT_FIELDS[a] || []) need.add(f);
  if (!need.size) return { items: [], missing: [] };

  const items = [];
  const missing = [];
  const title = scrub(goodsInfo.title || '');

  if (need.has('price')) {
    const t = priceText(goodsInfo);
    if (t) items.push({ block: 'product', label: '价格', text: `${title}：${t}`, priority: 1 });
    else missing.push({ block: 'product', field: 'price', reason: 'no-price' });
  }
  if (need.has('stock')) {
    const stock = Number(goodsInfo.stock);
    if (Number.isFinite(stock)) {
      const text = stock > 0 ? `${title}：有货（库存 ${stock} 件）` : `${title}：暂时无货`;
      items.push({ block: 'product', label: '库存', text, priority: need.has('price') ? 2 : 1 });
    } else {
      missing.push({ block: 'product', field: 'stock', reason: 'no-stock' });
    }
  }
  if (need.has('spec')) {
    // 商品目录没有规格字段：宁可标缺失，也不让模型按商品标题猜规格
    missing.push({ block: 'product', field: 'spec', reason: 'no-spec-field' });
  }
  return { items, missing };
}

/** 说明书块：按商品绑定，绝不跨商品推断 */
function manualItems(goodsId, buyerText) {
  if (!goodsId) return { items: [], missing: [] };
  const mr = manualStore.match(goodsId, buyerText);
  if (mr.mode !== 'section') return { items: [], missing: [] };
  const items = (mr.sections || []).slice(0, 2).map((s, i) => ({
    block: 'manual',
    label: scrub(s.title || `用法${i + 1}`),
    text: clip(scrub(s.content || '')),
    priority: 3 + i,
  })).filter((x) => x.text);
  return { items, missing: [] };
}

/**
 * 政策/知识块：引擎已检索到的命中 + 多意图时按子问题补检索
 * 只用原文，不改写——模型可以组织语言，但不能替商家写政策。
 */
function policyItems({ hits, kb, scope, parts }) {
  const picked = [];
  const seen = new Set();
  const push = (h, priority) => {
    const e = h.entry || h;
    if (!e || !e.id || seen.has(e.id)) return;
    const answer = scrub(e.answer || '');
    if (!answer) return;
    seen.add(e.id);
    picked.push({
      block: STORE_ASK.has(e.ask) || e.type === 'faq' || e.type === 'policy' ? 'policy' : 'general',
      label: scrub(e.title || '说明'),
      text: clip(answer),
      priority,
      ref: e.id,
    });
  };

  (hits || []).slice(0, 4).forEach((h, i) => push(h, 2 + i));

  // 多意图：主问题命中之外，每个子问题再各补 1 条（预算内）
  if (parts && parts.length > 1 && Array.isArray(kb) && kb.length) {
    for (const p of parts) {
      if (picked.length >= 6) break;
      const rs = knowledge.retrieve(p, kb, scope || {});
      if (rs.length) push(rs[0], 6);
    }
  }
  return picked;
}

function concernMissing(buyerText, items) {
  const c = concerns.detect(buyerText || '');
  if (!c) return [];
  const answered = items.some((x) => c.a.test(x.text));
  return answered ? [] : [{ block: 'concern', key: c.key, reason: 'no-evidence' }];
}

/**
 * 组装事实包
 * @param {{buyerText:string, goods?:object, products?:Array, knowledgeHits?:Array,
 *          kb?:Array, storeId?:string, understanding?:object, order?:object}} input
 */
function build(input = {}) {
  const buyerText = String(input.buyerText || '');
  const goods = input.goods || {};
  const products = Array.isArray(input.products) ? input.products : [];

  // 当前商品：优先引擎已匹配到的（已过店铺作用域与新鲜度），其次商品卡
  const goodsInfo = resolveGoods(goods, products, input.storeId);
  const goodsId = (goodsInfo && goodsInfo.goodsId) || goods.goodsId || null;

  const { asks, parts } = splitAsks(buyerText);
  const wantsOrder = ORDER_SIGNAL.test(buyerText);

  const blocks = [];
  const reasons = [];
  let items = [];
  const missing = [];

  // 1. 订单块：有信号就一定要，没数据就明说缺，别让模型猜「发了没」
  if (wantsOrder) {
    blocks.push('order');
    if (input.order && Object.keys(input.order).length) {
      items.push({
        block: 'order',
        label: '订单',
        text: clip(scrub(describeOrder(input.order))),
        priority: 0,
      });
      reasons.push('买家问到这一单，带订单事实');
    } else {
      missing.push({ block: 'order', reason: 'no-order-data' });
      reasons.push('买家问到这一单，但没有订单数据');
    }
  }

  // 2. 商品块
  const p = productItems(goodsInfo, asks.length ? asks : (input.understanding && input.understanding.ask ? [input.understanding.ask] : []));
  if (p.items.length) {
    blocks.push('product');
    items = items.concat(p.items);
    reasons.push('问到价格/库存/商品');
  }
  missing.push(...p.missing);

  // 3. 说明书块
  const m = manualItems(goodsId, manualQuery(buyerText));
  if (m.items.length) {
    blocks.push('manual');
    items = items.concat(m.items);
    reasons.push('问到这款的用法/规格');
  }

  // 4. 政策/常识块
  const pol = policyItems({
    hits: input.knowledgeHits || [],
    kb: input.kb,
    scope: { storeId: input.storeId, goodsId },
    parts,
  });
  if (pol.length) {
    blocks.push('policy');
    items = items.concat(pol);
    reasons.push('店铺政策/通用说明命中');
  }

  // 5. 关切：安全/凭证/地域，有事实才算答得上
  missing.push(...concernMissing(buyerText, items));

  // 都没命中：只留常驻层（当前商品标题），让模型知道在跟谁说话
  if (!items.length && goodsInfo && goodsInfo.title) {
    blocks.push('context');
    items.push({
      block: 'context',
      label: '商品',
      text: clip(scrub(goodsInfo.title)),
      priority: 9,
    });
    reasons.push('只给常驻层');
  }
  if (!items.length && !missing.length) missing.push({ block: 'all', reason: 'no-facts' });
  // ---- 预算：去重 → 按优先级排序 → 超预算从低优先级丢
  const packed = packItems(items);

  return {
    version: 1,
    route: { blocks, asks, orderAsked: wantsOrder, reasons },
    items: packed.items.map((x) => ({ id: x.id, block: x.block, label: x.label, text: x.text })),
    missing: dedupeMissing(missing),
    budget: { limit: TOKEN_LIMIT, soft: TOKEN_SOFT, tokens: packed.tokens, dropped: packed.dropped },
  };
}

/**
 * 预算装箱：去重 → 优先级排序 → 达到软上限或条数上限就丢，并记原因。
 * 独立出来是为了能单测「预算真的会丢东西」，而不是只有 happy path。
 */
function packItems(items) {
  const uniq = [];
  const seenText = new Set();
  for (const it of items || []) {
    const key = (it.block || '') + '|' + it.text;
    if (seenText.has(key)) continue;
    seenText.add(key);
    uniq.push(it);
  }
  uniq.sort((a, b) => (a.priority || 5) - (b.priority || 5));

  const kept = [];
  const dropped = [];
  let tokens = 0;
  for (const it of uniq) {
    if (kept.length >= MAX_ITEMS) {
      dropped.push({ block: it.block, label: it.label, reason: 'max-items' });
      continue;
    }
    const cost = estimateTokens(it.label) + estimateTokens(it.text) + PER_ITEM_OVERHEAD;
    if (kept.length >= 2 && tokens + cost > TOKEN_SOFT) {
      dropped.push({ block: it.block, label: it.label, reason: 'budget' });
      continue;
    }
    it.id = 'F' + (kept.length + 1);
    kept.push(it);
    tokens += cost;
  }
  return { items: kept, tokens, dropped };
}

function describeOrder(o) {
  const bits = [];
  if (o.status) bits.push('状态：' + o.status);
  if (o.paidAt) bits.push('付款：' + o.paidAt);
  if (o.shippedAt) bits.push('发货：' + o.shippedAt);
  if (o.courier) bits.push('快递：' + o.courier);
  if (o.trackingNo && /^\d{6,}$/.test(String(o.trackingNo))) bits.push('运单尾号：' + String(o.trackingNo).slice(-4));
  return bits.join('；');
}

function dedupeMissing(list) {
  const out = [];
  const seen = new Set();
  for (const m of list) {
    const k = m.block + '|' + (m.field || m.key || m.reason);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

/** 渲染成提示词里的【事实】段（本地模型路径与测试共用） */
function render(pack) {
  return (pack && pack.items ? pack.items : [])
    .map((f) => `[${f.id}] ${f.label}：${f.text}`)
    .join('\n');
}

/** 校验模型引用：只认包里存在的 id */
function validateUsed(pack, used) {
  const ids = new Set(((pack && pack.items) || []).map((x) => x.id));
  const list = Array.isArray(used) ? used.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean) : [];
  const valid = [];
  const invalid = [];
  for (const u of list) (ids.has(u) ? valid : invalid).push(u);
  return { valid: [...new Set(valid)], invalid: [...new Set(invalid)] };
}

module.exports = {
  build,
  packItems,
  render,
  validateUsed,
  estimateTokens,
  scrub,
  TOKEN_LIMIT,
  TOKEN_SOFT,
};
