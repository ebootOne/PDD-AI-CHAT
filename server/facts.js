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
const facets = require('./facets');
const factRoute = require('./fact-route');

// 商品域隔离（与 engine.domainMismatch 同一条判据）：
// 用品不能拿种子/种植口径答，反之亦然。facts 自己会补检索，必须同样过这道闸。
const SEED_PRODUCT = /种子|种籽|菜种|萝卜|番茄|生菜|辣椒|黄瓜|白菜|菠菜|玉米|香葱|香菜|豆角|茄子/;
const SEED_WORDS = /浸种|催芽|露白|播种|覆土|株距|行距|土壤|发芽|出苗|种植|耐寒|四季播/;

function domainMismatch(entry, goodsInfo) {
  if (!entry || !goodsInfo) return false;
  const p = String(goodsInfo.title || '') + ' ' + String(goodsInfo.category || '');
  if (SEED_PRODUCT.test(p)) return false;
  const e = String(entry.answer || '') + ' ' + (entry.keywords || []).join(' ');
  return SEED_WORDS.test(e);
}

const STALE_MS = 2 * 60 * 60 * 1000; // 商品字段超过 2 小时不报价
// 每个字段只有一个权威来源；不要跨来源混用，冲突只可能发生在同源重复里
const FIELD_SOURCE = {
  price: 'catalog', stock: 'catalog', spec: 'catalog',
  freight: 'knowledge', courier: 'knowledge', shipping_time: 'knowledge',
  invoice: 'knowledge', payment: 'knowledge', return_policy: 'knowledge', after_sale: 'knowledge',
  order: 'order', usage: 'manual', profile: 'config',
};
const CATALOG_FIELDS = new Set(['price', 'stock', 'spec']);

const TOKEN_LIMIT = 800; // 硬上限（docs/36）
const TOKEN_SOFT = 680; // 实际目标：留 15% 余量，避免估算误差顶穿
const MAX_ITEMS = 8;
// 扩召回档：正常路由没覆盖时，允许放宽预算/条数，把相邻信息交给模型
const WIDE_TOKEN_LIMIT = 1200;
const WIDE_TOKEN_SOFT = 950;
const WIDE_MAX_ITEMS = 12;
const FACT_MAX_CHARS = 190;
const PER_ITEM_OVERHEAD = 8; // 「[F1] 价格：」这类前缀的估算成本

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
  const g = goods || {};
  const scoped = productStore.load().filter((p) => !storeId || !p.storeId || p.storeId === storeId);
  if (Array.isArray(products) && products[0]) {
    const given = products[0];
    const full = (given.goodsId && productStore.find(given.goodsId, scoped))
      || (given.title && productStore.findByTitle(given.title, scoped));
    if (!full) return given;
    // 引擎只带了部分字段：用店内完整记录补齐价格区间/规格/同步时间
    return {
      ...full,
      ...given,
      price: given.price != null ? given.price : full.price,
      priceMax: given.priceMax != null ? given.priceMax : full.priceMax,
      spec: given.spec != null ? given.spec : full.spec,
      syncedAt: given.syncedAt || full.syncedAt,
    };
  }
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
function isStaleGoods(goodsInfo) {
  return Boolean(goodsInfo && goodsInfo.syncedAt && Date.now() - Date.parse(goodsInfo.syncedAt) > STALE_MS);
}

function productItems(goodsInfo, asks) {
  if (!goodsInfo) return { items: [], missing: [] };
  const need = new Set();
  for (const a of asks) for (const f of PRODUCT_FIELDS[a] || []) need.add(f);
  if (!need.size) return { items: [], missing: [] };

  const items = [];
  const missing = [];
  const title = scrub(goodsInfo.title || '');
  const stale = isStaleGoods(goodsInfo);
  if (stale) {
    for (const f of need) missing.push({ block: 'product', field: f, reason: 'stale' });
    return { items: [], missing };
  }
  const meta = { source: 'catalog', updatedAt: goodsInfo.syncedAt || null };

  if (need.has('price')) {
    const t = priceText(goodsInfo);
    if (t) items.push({ block: 'product', label: '价格', text: `${title}：${t}`, priority: 1, ...meta });
    else missing.push({ block: 'product', field: 'price', reason: 'no-price' });
  }
  if (need.has('stock')) {
    const stock = Number(goodsInfo.stock);
    if (Number.isFinite(stock)) {
      const text = stock > 0 ? `${title}：有货（库存 ${stock} 件）` : `${title}：暂时无货`;
      items.push({ block: 'product', label: '库存', text, priority: need.has('price') ? 2 : 1, ...meta });
    } else {
      missing.push({ block: 'product', field: 'stock', reason: 'no-stock' });
    }
  }
  if (need.has('spec')) {
    const spec = String(goodsInfo.spec || '').trim();
    if (spec) {
      items.push({ block: 'product', label: '规格', text: `${title}：${spec}`, priority: need.has('price') ? 2 : 1, ...meta });
    } else {
      // 商品目录没有规格字段：先标缺失；如果说明书/政策能覆盖，后面会撤掉
      missing.push({ block: 'product', field: 'spec', reason: 'no-spec-field' });
    }
  }
  return { items, missing };
}

/** 说明书块：按商品绑定，绝不跨商品推断 */
/**
 * 说明书块：按商品绑定，绝不跨商品推断。
 * 有「关切」时先过焦点：问中毒却给「适用对象」，等于用相邻话题抢答（ISS-007）。
 * 宁可这一节不给、标成缺失，也不把不相关的段落喂给模型当依据。
 */
function manualItems(goodsId, buyerText, concern) {
  if (!goodsId) return { items: [], missing: [] };
  const mr = manualStore.match(goodsId, buyerText);
  if (mr.mode !== 'section') return { items: [], missing: [] };

  const sections = (mr.sections || []).filter((s) => {
    if (!concern) return true;
    return concern.a.test(String(s.title || '') + ' ' + String(s.content || ''));
  });
  if (!sections.length) return { items: [], missing: [] };

  const items = sections.slice(0, 2).map((s, i) => ({
    block: 'manual',
    label: scrub(s.title || `用法${i + 1}`),
    text: clip(scrub(s.content || '')),
    priority: 3 + i,
    source: 'manual',
  })).filter((x) => x.text);
  return { items, missing: [] };
}

/**
 * 政策/知识块：引擎已检索到的命中 + 多意图时按子问题补检索
 * 只用原文，不改写——模型可以组织语言，但不能替商家写政策。
 */
function policyItems({ hits, kb, scope, parts, asks, goodsInfo }) {
  const picked = [];
  const seen = new Set();
  const push = (h, priority) => {
    const e = h.entry || h;
    if (!e || !e.id || seen.has(e.id)) return;
    if (domainMismatch(e, goodsInfo)) return;
    const answer = scrub(e.answer || '');
    if (!answer) return;
    seen.add(e.id);
    picked.push({
      block: STORE_ASK.has(e.ask) || e.type === 'faq' || e.type === 'policy' ? 'policy' : 'general',
      label: scrub(e.title || '说明'),
      text: clip(answer),
      priority,
      ref: e.id,
      ask: e.ask || '',
      source: 'knowledge',
      updatedAt: e.updatedAt || null,
    });
  };

  (hits || []).slice(0, 4).forEach((h, i) => push(h, 2 + i));

  // 每个 ask 至少配一条同类知识：关键词没命中（「能发顺丰吗」vs「默认快递」）也能覆盖
  for (const ask of asks || []) {
    if (!ask || picked.some((x) => x.ask === ask)) continue;
    const cand = (kb || []).find((e) => e && e.enabled !== false && e.ask === ask && !seen.has(e.id));
    if (cand) push({ entry: cand }, 4);
  }

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

function concernMissing(concern, items) {
  const c = concern;
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

  const routing = factRoute.route({
    buyerText,
    hasGoods: Boolean(goodsId),
    understanding: input.understanding,
  });
  const { asks, parts, productAsks, orderAsked, concern } = routing;

  const blocks = [];
  const reasons = [];
  let items = [];
  const missing = [];

  // 1. 订单块：有信号、或注册表要求「必须有订单」，就一定要；没数据就明说缺
  const regNeeds = (routing.registry && routing.registry.needs) || [];
  const wantsOrderBlock = orderAsked || regNeeds.includes('order');
  if (wantsOrderBlock) {
    blocks.push('order');
    if (input.order && Object.keys(input.order).length) {
      items.push({
        block: 'order',
        label: '订单',
        text: clip(scrub(describeOrder(input.order))),
        priority: 0,
        source: 'order',
      });
      reasons.push('买家问到这一单，带订单事实');
    } else {
      missing.push({ block: 'order', reason: 'no-order-data' });
      reasons.push('买家问到这一单，但没有订单数据');
    }
  }

  // 2. 商品块
  const p = productItems(goodsInfo, productAsks);
  if (p.items.length) {
    blocks.push('product');
    items = items.concat(p.items);
    reasons.push('问到价格/库存/商品');
  }
  missing.push(...p.missing);

  // 3. 说明书块
  const manualText = facets.manualQueryFor(manualQuery(buyerText));
  const m = manualItems(goodsId, manualText, concern);
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
    asks,
    goodsInfo,
  });
  if (pol.length) {
    blocks.push('policy');
    items = items.concat(pol);
    reasons.push('店铺政策/通用说明命中');
  }

  // 5. 关切：安全/凭证/地域，有事实才算答得上
  missing.push(...concernMissing(concern, items));

  // 5.5 兜底：正常路由没覆盖到 → 扩召回，不直接认输
  const coreItems = items.filter((i) => i.block !== 'context');
  const uncovered = asks.filter((a) => {
    const need = factRoute.ASK_BLOCK[a] || 'policy';
    if (need === 'order') return false; // 订单没数据，扩召回补不出来
    if (need === 'product') return !items.some((i) => i.block === 'product');
    if (need === 'manual') return !items.some((i) => i.block === 'manual');
    return !items.some((i) => i.block === 'policy');
  });
  const concernGap = Boolean(concern) && !items.some((i) => concern.a.test(i.text));
  const triggers = [];
  if (coreItems.length === 0) triggers.push('no-core-facts');
  if (uncovered.length) triggers.push('uncovered:' + uncovered.join(','));
  if (concernGap) triggers.push('concern-gap');
  const widenTrigger = triggers.join('+');
  // 只问「这一单到哪了」且没有订单数据时，扩召回也补不出物流——不要拿无关政策凑数
  const orderOnly = asks.length > 0
    && asks.every((a) => factRoute.ASK_BLOCK[a] === 'order')
    && !(input.order && Object.keys(input.order).length);
  let widened = false;
  if (widenTrigger && !orderOnly) {
    const extra = widenItems({
      buyerText,
      kb: input.kb,
      scope: { storeId: input.storeId, goodsId },
      goodsInfo,
      goodsId,
      existing: items,
      concern,
    });
    if (extra.length) {
      items = items.concat(extra);
      widened = true;
      reasons.push('扩召回：' + widenTrigger);
    }
  }

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

  // ---- 冲突：同字段两种说法，不交给模型选边
  const resolved = resolveConflicts(items);
  items = resolved.items;
  const conflicts = resolved.conflicts;

  // ---- 预算：去重 → 按优先级排序 → 超预算从低优先级丢（扩召回用宽档）
  const packed = packItems(items, widened ? { maxItems: WIDE_MAX_ITEMS, soft: WIDE_TOKEN_SOFT } : {});

  // 扩召回补上了关切，就把「关切无依据」撤掉
  if (concern && packed.items.some((x) => concern.a.test(x.text))) {
    for (let i = missing.length - 1; i >= 0; i--) if (missing[i].block === 'concern') missing.splice(i, 1);
  }
  if (packed.items.length) {
    for (let i = missing.length - 1; i >= 0; i--) if (missing[i].block === 'all') missing.splice(i, 1);
  }
  // 实际给出的块，以入选事实为准（扩召回可能新增块）
  for (const it of packed.items) if (!blocks.includes(it.block)) blocks.push(it.block);

  // 规格：说明书（材质与规格/尺寸）或政策能答上，就不算缺失
  if (missing.some((m) => m.field === 'spec')) {
    // 只认说明书分节（材质与规格/尺寸）；政策里「以商品页为准」不算有规格
    const covered = packed.items.some((it) => it.block === 'manual' && /规格|尺寸|材质|重量|容量/.test(it.label));
    if (covered) {
      for (let i = missing.length - 1; i >= 0; i--) if (missing[i].field === 'spec') missing.splice(i, 1);
    }
  }

  // 注册表要求、但事实包里没有任何一块能顶上 → 明确标缺失，别让模型自己猜
  for (const need of regNeeds) {
    if (need === 'order') continue; // 订单已在上面单独处理
    if (!packed.items.some((x) => x.block === need) && !missing.some((m) => m.block === need)) {
      missing.push({ block: need, reason: 'registry-needs' });
    }
  }

  const mode = widened ? 'wide' : (packed.items.length ? 'normal' : 'empty');

  return {
    version: 1,
    route: {
      blocks,
      asks,
      orderAsked,
      multi: routing.multi,
      uncovered: (routing.unknownParts || []).length,
      reasons,
      wanted: routing.wanted.map((w) => w.key),
      mode,
      widen: widened ? { trigger: widenTrigger } : null,
      registry: routing.registry,
    },
    conflicts,
    index: buildIndex({ storeId: input.storeId, goodsId, kb: input.kb, products: input.products }),
    items: packed.items.map((x) => ({
      id: x.id, block: x.block, label: x.label, text: x.text,
      source: x.source || null, updatedAt: x.updatedAt || null, conflict: Boolean(x.conflict),
    })),
    missing: dedupeMissing(missing),
    budget: {
      limit: widened ? WIDE_TOKEN_LIMIT : TOKEN_LIMIT,
      soft: widened ? WIDE_TOKEN_SOFT : TOKEN_SOFT,
      tokens: packed.tokens,
      dropped: packed.dropped,
    },
  };
}

/**
 * 预算装箱：去重 → 优先级排序 → 达到软上限或条数上限就丢，并记原因。
 * 独立出来是为了能单测「预算真的会丢东西」，而不是只有 happy path。
 */
/**
 * 来源冲突：同一 label 出现两种不同说法时，不选边。
 * 返回：去掉冲突项后的 items + 冲突清单。
 */
function resolveConflicts(items) {
  const groups = new Map();
  for (const it of items || []) {
    const key = String(it.label || it.block || '').trim();
    if (!key || ['商品', '订单'].includes(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const conflicts = [];
  for (const [label, list] of groups) {
    const texts = [...new Set(list.map((x) => String(x.text || '').replace(/\s+/g, ' ').trim()))];
    if (texts.length > 1) {
      conflicts.push({
        label,
        sources: [...new Set(list.map((x) => x.source || 'unknown'))],
        texts: texts.slice(0, 2),
      });
      // 不丢弃：让模型看到两种说法，按上下文选更具体/更新的
      for (const it of list) it.conflict = true;
    }
  }
  return { items: items || [], conflicts };
}

function packItems(items, opts = {}) {
  const maxItems = opts.maxItems || MAX_ITEMS;
  const soft = opts.soft || TOKEN_SOFT;
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
    if (kept.length >= maxItems) {
      dropped.push({ block: it.block, label: it.label, reason: 'max-items' });
      continue;
    }
    const cost = estimateTokens(it.label) + estimateTokens(it.text) + PER_ITEM_OVERHEAD;
    if (kept.length >= 2 && tokens + cost > soft) {
      dropped.push({ block: it.block, label: it.label, reason: 'budget' });
      continue;
    }
    it.id = 'F' + (kept.length + 1);
    kept.push(it);
    tokens += cost;
  }
  return { items: kept, tokens, dropped };
}

/**
 * 扩召回：正常路由没覆盖时，把相邻信息补进来。
 * 只补「本店真实有的东西」：知识再检索、说明书摘要、商品字段。
 * 不补订单（没数据就是没有，补不出来）。
 */
function widenItems({ buyerText, kb, scope, goodsInfo, goodsId, existing, concern }) {
  const added = [];
  const seen = new Set((existing || []).map((x) => x.text));
  const push = (block, label, text, priority) => {
    const t = clip(scrub(String(text || '')));
    if (!t || seen.has(t)) return;
    // 有关切时（中毒/凭证/地域），只补「回应关切」的段落，别用相邻话题抢答（ISS-007）
    if (concern && block !== 'product' && !concern.a.test(t)) return;
    seen.add(t);
    const src = block === 'product' ? 'catalog' : block === 'manual' ? 'manual' : 'knowledge';
    added.push({ block, label: scrub(String(label || '补充')), text: t, priority, wide: true, source: src });
  };

  // 1) 知识：按整句再检索一次（引擎命中可能被 ask 标签过滤掉了）
  if (Array.isArray(kb) && kb.length) {
    const rs = knowledge.retrieve(buyerText, kb, scope || {});
    rs.slice(0, 3).forEach((h, i) => push('policy', h.entry.title, h.entry.answer, 5 + i));
  }

  // 2) 说明书：只有「怎么用/怎么种/清洗」这类问法才给摘要；
  //    问规格时给全部章节会把「要不要泡水」塞进来，反而带偏
  const wantManualSummary = /怎么用|怎么种|用法|步骤|教程|不会用|怎么清洗|怎么泡|要泡水|催芽/.test(buyerText);
  if (goodsId && wantManualSummary) {
    const manual = manualStore.find(goodsId);
    if (manual && Array.isArray(manual.sections)) {
      manual.sections.slice(0, 3).forEach((sec, i) => {
        const first = String(sec.content || '').split(/[。！？!?]/)[0];
        push('manual', sec.title || '用法', `${sec.title}：${first}`, 6 + i);
      });
    }
  }

  // 3) 商品：连价格/库存都没取到时，至少给标题与关键字段
  if (goodsInfo && goodsInfo.title) {
    const bits = [goodsInfo.title];
    const stale = isStaleGoods(goodsInfo);
    if (!stale && goodsInfo.price != null) bits.push(`价格 ${goodsInfo.price} 元`);
    if (!stale && goodsInfo.stock != null) bits.push(`库存 ${goodsInfo.stock}`);
    const it = { block: 'product', label: '商品', text: bits.join('，'), priority: 5, source: 'catalog', updatedAt: goodsInfo.syncedAt || null };
    const t = clip(scrub(it.text));
    if (t && !seen.has(t)) { seen.add(t); added.push(it); }
  }

  return added;
}

function describeOrder(o) {
  const bits = [];
  if (o.status) bits.push('状态：' + o.status);
  if (o.paidAt) bits.push('付款：' + o.paidAt);
  if (o.shippedAt) bits.push('发货：' + o.shippedAt);
  if (o.courier) bits.push('快递：' + o.courier);
  if (o.trackingNo && /^\d{6,}$/.test(String(o.trackingNo))) bits.push('运单尾号：' + String(o.trackingNo).slice(-4));
  if (Array.isArray(o.items) && o.items.length) bits.push('商品：' + o.items.map((x) => String(x.title || '')).filter(Boolean).join('、'));
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

/**
 * 店铺索引：标题级目录，**常驻**，不依赖路由命中
 *
 * 为什么要有它：路由是穷举，必有漏；漏了就"少给事实"，模型只能说不知道。
 * 索引放的是"这家店有什么"（商品/政策/说明书分节标题），成本很低（本店约 215 tokens），
 * 让模型即使路由没命中，也知道有哪些事实可用、缺什么。
 */
function buildIndex(input = {}) {
  const storeId = input.storeId || '';
  const lines = [];
  const inStore = (x) => !storeId || !x.storeId || x.storeId === storeId;

  const products = (input.products || []).filter(inStore).slice(0, 5);
  for (const p of products) {
    const name = String(p.title || '').slice(0, 14);
    const price = p.priceMax && Number(p.priceMax) > Number(p.price) ? `${p.price}~${p.priceMax}元` : `${p.price}元`;
    const stock = Number.isFinite(Number(p.stock)) ? `/库存${p.stock}` : '';
    if (name) lines.push(`商品：${name} ${price}${stock}`);
  }

  const kb = (input.kb || []).filter(inStore).slice(0, 12);
  for (const k of kb) {
    const t = String(k.title || '').slice(0, 12);
    const a = String(k.answer || '').replace(/\s+/g, '').slice(0, 18);
    if (t) lines.push(`政策：${t}·${a}`);
  }

  if (input.goodsId) {
    const manual = manualStore.find(input.goodsId);
    if (manual && Array.isArray(manual.sections) && manual.sections.length) {
      lines.push('说明书分节：' + manual.sections.map((x) => String(x.title || '').slice(0, 6)).join('/'));
    }
  }

  // 预算：索引最多 300 tokens（约 480 字），超了按顺序截断
  let out = [];
  let chars = 0;
  for (const line of lines) {
    if (chars + line.length > 480) break;
    out.push(line);
    chars += line.length;
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
  FIELD_SOURCE,
  buildIndex,
  resolveConflicts,
  productItems,
  build,
  packItems,
  render,
  validateUsed,
  estimateTokens,
  scrub,
  TOKEN_LIMIT,
  TOKEN_SOFT,
};
