'use strict';

/**
 * engine.js —— 回复决策引擎
 *
 * 输入一段会话上下文，输出：候选回复 + 决策（自动发送 / 建议人工确认 / 转人工）。
 * 引擎不依赖浏览器，可用模拟数据完整回归。
 *
 * 决策优先级（从高到低）：
 *   1. 投诉/纠纷/要求赔偿  → 一律转人工
 *   2. 生成内容命中违禁词  → 丢弃该候选，若全丢则转人工
 *   3. 无知识依据           → 不自动发送
 *   4. 非工作时段 / 触发限流 → 只建议不自动发
 *   5. 自动模式 + 白名单意图 + 置信度达标 → 自动发送
 */

const { retrieve, confidenceFromScore } = require('./knowledge');
const productStore = require('./products');
const manualStore = require('./manuals');
const facets = require('./facets');
const orderSelect = require('./order-select');
const router = require('./router');
const buffer = require('./buffer');
const { pickFallback, publicFallback, SHOP_ASK } = require('./policy');
const templates = require('./templates');
const natural = require('./natural');
const { rewrite, warm } = require('./style');
const tone = require('./tone');
const { chat, extractJson } = require('./llm');
const { buildMessages } = require('./prompt');
const understand = require('./understand');
const sensitive = require('./sensitive');

/**
 * 带「审题扩写」的检索：问法不同、问的事相同，也能召回。
 * 扩写命中的条目打 9 折，避免仅凭同义词就把置信度顶上去。
 */
const ASK_EXPECT = {
  arrival_time: /到货|时效/,
  shipping_time: /发货|物流/,
  shipping_status: /物流|发货/,
  courier: /快递/,
  freight: /包邮|运费|邮费/,
  after_sale: /售后|不发芽|退换/,
  return_policy: /退换|退货/,
  invoice: /发票/,
  payment: /支付/,
  price: /包邮|价格|议价|运费|优惠/,
  spec: /规格/,
  stock: /有货/,
  usage: /催芽|播种|温度|规格/,
  recommend: /商品|推荐/,
};

function dedupeByTitle(hits) {
  const best = new Map();
  for (const h of hits) {
    const key = String((h.entry && h.entry.title) || h.entry.id).trim();
    const cur = best.get(key);
    if (!cur || h.score > cur.score) best.set(key, h);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

function retrieveWithAsk(text, un, knowledge, scope) {
  const base = retrieve(text, knowledge, scope);
  const extra = understand.ASK_EXPANSION[un && un.ask];
  if (!extra) return base;
  // 第一名的条目已经对上问题类型，就不要扩写——扩写会塞进相近条目，把原本干净的分差搅浑。
  const expect = ASK_EXPECT[un.ask];
  if (base.length && expect && expect.test(base[0].entry.title || '')) return base;
  const more = retrieve(text + ' ' + extra, knowledge, scope);
  const byId = new Map(base.map((h) => [h.entry.id, h]));
  for (const h of more) {
    const cur = byId.get(h.entry.id);
    if (!cur) byId.set(h.entry.id, Object.assign({}, h, { score: h.score * 0.9, viaExpansion: true }));
    else if (h.score > cur.score) byId.set(h.entry.id, h);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, 4);
}

const INTENTS = [
  ['complaint', /投诉|差评|举报|12315|平台介入|起诉|曝光|骗|假货|骗子|垃圾|退一赔/],
  ['refund', /退款|退货|售后|坏|破损|少发|漏发|错发|质量问题|不发芽|没出芽|没发芽|不出芽|不出苗|死苗|枯死|(苗|花|菜|株|芽)死了|枯萎|退钱|退吗/],
  ['logistics', /发货|什么时候发|什么时候能到|什么时候到|什么时候能收到|几天到|几天能到|几天可以到|多久能到|多久到|快递|物流|单号|到货|派送|签收|顺丰|中通|圆通|韵达|邮政/],
  ['product', /有没有|有卖|有货|还有吗|哪款|推荐|卖不卖|能买|搜不到|找不到|有这个|有.{1,6}吗/],
  ['price', /价格|多少钱|优惠|便宜|包邮|活动|满减|券|划算|降价/],
  ['usage', /怎么用|用法|怎么种|种植|播种|催芽|浸种|泡种|泡水|泡一下|育苗|栽|养护|施肥|浇水|发芽|适合|能不能种|地区|季节|温度|光照/],
  ['spec', /规格|尺码|尺寸|多大|多长|多高|型号|颜色|重量|克|斤|袋|包|含量|容量|净含量|几粒|多少粒/],
];

function classifyIntent(text) {
  const t = String(text || '');
  for (const [name, re] of INTENTS) if (re.test(t)) return name;
  return 'other';
}

/** 买家消息里的高危信号：命中即转人工，不交给模型自由发挥 */
function detectRisk(text) {
  const t = String(text || '');
  const risks = [];
  if (/投诉|差评|举报|12315|平台介入|起诉|曝光|骗子|假货/.test(t)) risks.push('投诉威胁');
  const wantsMoney = /赔|补偿|三倍|十倍|退一赔/.test(t) || /(退钱|退款|退货)[^。！？]{0,6}(否则|必须|马上|立刻)/.test(t);
  if (wantsMoney && /多少|怎么|必须|马上|立刻|否则/.test(t)) risks.push('索赔诉求');
  if (/微信|手机号|电话|QQ|加我|私聊|二维码/i.test(t)) risks.push('引流站外');
  return risks;
}

/**
 * 称呼（亲/亲亲/您好）：店铺级唯一配置，不做"按场景动态切换"。
 * 动态切换看起来聪明，实际会让同一个客服号说话忽冷忽热，也会让买家觉得是机器人。
 */
function applySalutation(text, cfg, isFirstReply) {
  const sal = cfg.salutation;
  if (!sal || !sal.enabled) return text;
  if (sal.onlyFirst !== false && !isFirstReply) return text;
  const word = String(sal.text || '亲').trim();
  if (!word) return text;
  if (text.startsWith(word)) return text;
  return word + '，' + text;
}

function inBusinessHours(cfg, now = new Date()) {
  const bh = cfg.businessHours || {};
  if (!bh.enabled) return true;
  const m = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(bh.start || '00:00').split(':').map(Number);
  const [eh, em] = String(bh.end || '23:59').split(':').map(Number);
  return m >= sh * 60 + sm && m <= eh * 60 + em;
}

/** 违禁词过滤：返回 {ok, hits} */
function screenOutput(text, cfg) {
  // 分层校验：block 丢弃候选，warn 保留但记录；词表在 data/sensitive.json，可热更。
  const r = sensitive.check(text, cfg.forbiddenOutput);
  // hits 保持「词数组」的老契约（调用方/测试都按字符串用），详情放 details
  return { ok: r.ok, hits: r.hits.map((h) => h.word), details: r.hits, warned: r.warned };
}

/**
 * 无模型时的规则兜底：把知识条目拆成候选。
 *
 * 只做「拆句」，不做「编话」：
 *   标准 = 知识原文；
 *   简短 = 第一句（超过 50 字才退到第一个分句，绝不截断半句）；
 *   安抚 = 只有买家带着情绪时才加，避免对一句普通提问说"理解您着急"。
 * 所以本地路径通常只给 2 条，3 条候选是模型路径才有的。
 */
// 知识条目有「域」：种子/种植口径的知识不能拿去答用品（ISS-003）
const SEED_WORDS = /种子|播种|催芽|浸种|泡种|育苗|发芽|土壤|施肥|浇水|盆栽|地栽/;
const SEED_PRODUCT = /种子|籽|蔬菜|萝卜|生菜|菠菜|番茄|辣椒|白菜|甘蓝|豆角|黄瓜|南瓜|茄子|葱|蒜/;

function domainMismatch(entry, product) {
  if (!entry || !product) return false;
  const p = String(product.title || '') + ' ' + String(product.category || '');
  if (SEED_PRODUCT.test(p)) return false; // 商品本身就是种子/菜，不拦
  const e = String(entry.answer || '') + ' ' + (entry.keywords || []).join(' ');
  return SEED_WORDS.test(e);
}

const concerns = require('./concerns');

function focusMismatch(query, answer, extra = '') {
  return concerns.mismatch(query, answer, extra);
}

function ruleCandidates(hits, buyerText) {
  const top = hits[0];
  if (!top) return [];
  const answer = String(top.entry.answer || '').trim();
  if (!answer) return [];
  // 政策示例：条件句不能截短，否则会丢「节假日/指定快递/专票」这些边界
  if (top.entry.noShort) return [{ tone: '标准', text: answer }];

  const sentences = answer.split(/[。！!？?\n]/).filter((x) => x.trim());
  const first = sentences[0] || answer;
  const clauses = first.split(/[，,；;]/).filter((x) => x.trim());
  const short = first.length <= 50 ? first : clauses.length > 1 ? clauses[0] : first.slice(0, 50) + '…';

  const out = [
    { tone: '标准', text: answer },
    { tone: '简短', text: short },
  ];
  // 通用常识（非店铺事实）必须标注来源，避免被当成检测数据
  if (top.entry.type === 'general') out[0].text = out[0].text + '（通用建议，非本店检测）';

  const emotional = /急|催|怎么还没|怎么回事|生气|失望|太慢|无语|投诉|差评|骗/.test(String(buyerText || ''));
  if (emotional && !answer.startsWith('理解')) {
    out.push({ tone: '安抚', text: '理解您着急，' + answer });
  }
  return out;
}

/**
 * 生成回复
 * @param {object} ctx { storeId, storeName, conversationId, goods, messages, mode }
 * @param {object} cfg 配置
 * @param {Array} knowledge 知识库
 * @param {{rateOk?:boolean}} opts 外部限流结果
 */
async function generate(ctx, cfg, knowledge, opts = {}) {
  const started = Date.now();
  const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
  const buyerMsgs = messages.filter((m) => m.role === 'buyer');
  const lastBuyer = buyerMsgs.length ? buyerMsgs[buyerMsgs.length - 1].text : '';
  // 先用「归一化后」的说法理解，再用它检索；展示给商家的仍是买家原话。
  const un = understand.extract(lastBuyer);
  const queryText = un.text || lastBuyer;
  const intent = classifyIntent(queryText);
  const risks = detectRisk(queryText);
  let hits = dedupeByTitle(retrieveWithAsk(queryText, un, knowledge, { storeId: ctx.storeId, goodsId: ctx.goods && ctx.goods.goodsId }));
  // 模板带着 ask 标签：先把不属于这类问题的模板剔掉，再比分数与具体度
  const askKey = (un && un.ask) || 'other';
  hits = hits.filter((h) => !h.entry.ask || h.entry.ask === askKey);
  // 焦点校验：问「有没有质检报告」，库里只有「有没有货」，不算命中——让位给模型
  hits = hits.filter((h) => !focusMismatch(queryText, h.entry.answer || ''));
  hits.sort((a, b) => (b.score - a.score) || ((b.entry.priority || 2) - (a.entry.priority || 2)));

  // 商品按店铺作用域：多店铺时不能拿别家商品报错价（ISS-013）
  const productItems = opts.products || (ctx.storeId ? productStore.forStore(ctx.storeId) : []);

  // 补充召回：问句里出现的词，如果还命中别的条目（新疆 → 包邮范围），一起带上交给模型。
  // 这里不判断「这是地名/型号/颜色」，只做包含匹配；判断交给模型。
  const SUPP_STOP = /请问|想问|麻烦|一下|什么|怎么|怎样|多少|几天|几个|哪儿|哪里|哪个|是不是|能不能|可不可以|有没有|你们|我们|咱们|这边|那边|可以|需要|这个|那个|的话|吗|呢|吧|啊|呀|哦|哈|的|了|是|有|能|会|要|在|和|与|就|都|我|你/g;
  const qTokens = (() => {
    const clean = String(queryText || '').replace(SUPP_STOP, '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
    const out = new Set();
    for (let i = 0; i + 2 <= clean.length; i++) out.add(clean.slice(i, i + 2));
    return [...out];
  })();
  let supplemental = [];
  if (qTokens.length && hits.length) {
    // 只找「主命中解释不了」的词：西藏/新疆/乌鲁木齐 这类主条目答不了的实体，
    // 如果别的条目里有，就一并带上；主条目自己已经覆盖的词不算
    const topCorpus = [hits[0].entry.title, ...(hits[0].entry.keywords || []), hits[0].entry.answer].join('');
    const uncovered = qTokens.filter((g) => !topCorpus.includes(g));
    const have = new Set(hits.map((h) => String(h.entry.id)));
    supplemental = uncovered.length ? knowledge
      .filter((e) => e && e.enabled !== false && !have.has(String(e.id)))
      .filter((e) => {
        const corpus = [e.title, ...(e.keywords || []), e.answer].join('');
        return uncovered.some((g) => corpus.includes(g));
      })
      .slice(0, 3)
      .map((e) => ({ entry: e, score: 0.8, reasons: ['补充召回'], supplemental: true }))
      : [];
    if (supplemental.length) hits = hits.concat(supplemental);
  }

  // 第二层检索：知识库没覆盖时，去店铺商品里找「有没有这个」
  const wantsProduct = intent === 'product' || un.ask === 'price' || hits.length === 0;
  const pm = wantsProduct ? productStore.match(queryText, productItems) : null;

  // 打平惩罚：第 1 名和第 2 名分差越小，说明"到底该用哪条"越不确定。
  // 光看分数会给出 0.98 的假自信，这对自动发送是致命的。
  // 打平惩罚只和「不同类问题」比：同类模板重复（如两条发货时间）不算歧义，否则会自己把自己压到阈值以下
  const topAsk = hits.length ? hits[0].entry.ask || '' : '';
  const rival = topAsk
    ? hits.find((h, i) => i > 0 && (h.entry.ask || '') !== topAsk)
    : hits[1];
  const margin = hits.length ? (hits[0].score - (rival ? rival.score : 0)) / hits[0].score : 0;
  const isFirstReply = !messages.some((m) => m.role === 'seller');
  const attempt = Math.max(0, Number(opts.attempt) || 0);
  const disabledTiers = (cfg.tone && cfg.tone.disabled) || [];
  let tier = tone.detectTier(queryText, { intent, risks });
  if (disabledTiers.includes(tier)) tier = 'standard';

  // 分流：这句话该由谁回答（商品 / 说明书 / 政策 / 模型）
  let goodsId = (ctx.goods && ctx.goods.goodsId) || (pm && pm.best && pm.best.goodsId);
  // 聊天里的商品卡只有标题，没有 ID：用标题反查商品库
  if (!goodsId && ctx.goods && ctx.goods.title) {
    const byTitle = productStore.findByTitle(ctx.goods.title, productItems);
    if (byTitle) goodsId = byTitle.goodsId;
  }

  // 焦点：买家嘴里点名了另一款（"抽纸多少钱"，商品卡却是站杆）→ 以他问的为准
  // 只在文本里确实命中商品时才切换，且置信度不能太低，避免被 2 字片段带偏
  let focusSwitched = false;
  if (pm && pm.best && pm.best.goodsId && pm.confidence >= 0.6 && String(pm.best.goodsId) !== String(goodsId)) {
    goodsId = pm.best.goodsId;
    focusSwitched = true;
  }
  let goodsInfo = goodsId ? productStore.find(goodsId, productItems) : null;

  // 商品数据过期（价格/库存可能已变）→ 不用它报价，改走口径，避免报错价
  const PRODUCT_FRESH_MS = 2 * 60 * 60 * 1000;
  if (goodsInfo && goodsInfo.syncedAt && Date.now() - Date.parse(goodsInfo.syncedAt) > PRODUCT_FRESH_MS) {
    goodsInfo = null;
  }

  // 商品已知，且是用品类：把种子/种植口径的知识剔掉，宁可兜底也不答错域
  if (goodsInfo) {
    const kept = hits.filter((h) => !domainMismatch(h.entry, goodsInfo));
    if (kept.length !== hits.length) hits = kept;
  }
  const route = router.classify(queryText, { productKnown: Boolean(goodsId) });
  const usageQuestion = route.route === 'manual';

  const base = {
    intent,
    understanding: un,
    tier,
    tierName: (tone.TIERS[tier] || {}).name,
    route: route.route,
    routeReason: route.reasons.join(' / '),
    buyerText: lastBuyer,
    margin: Number(Math.max(0, margin).toFixed(2)),
    ambiguous: hits.length > 1 && margin < 0.25,
    risks,
    knowledge: hits.map((h) => ({ id: h.entry.id, title: h.entry.title, score: Number(h.score.toFixed(2)), reasons: h.reasons })),

    products: pm ? pm.items.map((p) => ({ goodsId: p.goodsId, title: p.title, price: p.price, stock: p.stock, url: p.url })) : [],
    latencyMs: 0,
  };

  // 0. 打招呼：本地秒回，没必要花一次模型调用
  if (/^(在吗|在么|在不在|有人吗|你好|您好|hi|hello)[\s?？!！。~]*$/i.test(queryText.trim()) && !risks.length) {
    const text = applySalutation('在的，您有什么问题直接说，我帮您看。', cfg, isFirstReply);
    return Object.assign(base, {
      decision: 'suggest',
      reason: '打招呼，本地秒回',
      confidence: 0.95,
      source: 'rule',
      suggestions: [{ tone: '标准', text }],
      cost: 1,
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  // 0.4 退款/退货诉求：三级缓冲，不直接甩规则
  const howTo = /怎么退|如何退|能退吗|可以退吗|退款流程|怎么申请/.test(queryText);
  const refundDemand = buffer.REFUND_WORDS.test(queryText) && /我要|想|给我|申请|直接|干脆|还是|退了/.test(queryText);
  const prevRefundTalk = buyerMsgs.slice(0, -1).some((m) => buffer.REFUND_WORDS.test(m.text || ''));
  const refundTalk = !howTo && (refundDemand || prevRefundTalk);
  if ((refundTalk || howTo) && !risks.some((r) => r === '投诉威胁')) {
    const stage = howTo ? 3 : buffer.stageFor(messages, queryText);
    const text = buffer.replyFor('refund', stage);
    return Object.assign(base, {
      decision: 'suggest',
      reason: '退款诉求：第 ' + stage + ' 级缓冲',
      confidence: 0.8,
      source: 'rule',
      suggestions: [{ tone: '标准', text: applySalutation(text, cfg, isFirstReply) }],
      buffer: { kind: 'refund', stage },
      cost: 1,
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  // 0.5 售后追问：已经聊过售后，买家还在追问"怎么处理"，就别再重复"把照片发我"
  const prevRefund = buyerMsgs.slice(0, -1).some((m) => /退款|退货|售后|不发芽|没出芽|质量问题/.test(m.text));
  const pushing = /怎么处理|怎么办|给个说法|怎么解决|是不是你们|你们负责|赔/.test(queryText);
  if (prevRefund && pushing && !risks.length) {
    const text = applySalutation(
      '非常抱歉给您带来困扰，如果是质量问题，可以按平台规则申请售后处理。',
      cfg,
      isFirstReply
    );
    return Object.assign(base, {
      decision: 'suggest',
      reason: '售后追问：给规则陈述，不承诺跟进',
      confidence: 0.9,
      source: 'rule',
      suggestions: [{ tone: '标准', text }],
      cost: 1,
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  // 1. 高危买家消息：先安抚（不能让买家干等），同时把告警级别拉满
  const mustHandoff = risks.some((r) => r === '投诉威胁' || r === '索赔诉求');
  if (mustHandoff) {
    const fb = pickFallback({ risks, intent, attempt, ask: un.ask, capabilities: cfg.capabilities });
    // 投诉：只陈述商家已确认的事实（如正规渠道），没有声明就只道歉。
    // 不承诺跟进、不索取订单号/照片——全自动没有人接。
    const stmt = (knowledge || []).find(
      (k) => k.type === 'statement' && k.enabled !== false && (!k.storeId || k.storeId === ctx.storeId)
    );
    const kind = risks.includes('投诉威胁') ? 'complaint' : 'refund';
    const stage = kind === 'complaint' ? buffer.refundStage(messages) : buffer.refundStage(messages);
    const body = (stmt && stmt.answer) || buffer.replyFor(kind, stage);
    return Object.assign(base, {
      decision: 'suggest',
      source: 'rule',
      reason: '高风险诉求（' + risks.join('、') + '）：第 ' + stage + ' 级缓冲，共情 + 给方向',
      suggestions: [{ tone: '兜底', text: applySalutation(body, cfg, isFirstReply) }],
      fallback: { level: fb.level, attempt: fb.attempt },
      alert: 'high',
      buffer: { kind, stage },
      cost: 1,
      costReason: 'fallback',
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  if (!lastBuyer) {
    return Object.assign(base, {
      decision: 'handoff',
      reason: '未读到买家消息',
      suggestions: [],
      cost: 0,
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  let candidates = [];
  let confidence = 0;
  let needHuman = false;
  let missing = '';
  let source = 'rule';

  // 配了服务端就走服务端：本地不再直连模型，避免密钥落在商家电脑上
  const useBackend = Boolean(cfg.backend && cfg.backend.url);
  const llmReady = cfg.llm && cfg.llm.baseUrl && !useBackend && opts.allowLlm !== false;

  // 商品命中：用模板拼，确定性最高、0 token
  // 注：用法/规格类不在这里出候选（交给说明书）
  const ask0 = un.ask || '';
  const band = (un.slots && un.slots.priceBand) || null;
  if (pm && pm.best && (ask0 === 'price' || ask0 === 'stock' || ask0 === 'product')) {
    // 问价就直接报价；问规格/用法不该用"有没有货"来糊弄（ISS-012）
    candidates = ask0 === 'price' ? priceCandidates(pm, band) : productCandidates(pm, cfg);
    if (candidates.length && focusMismatch(queryText, candidates[0].text)) candidates = [];
    confidence = pm.confidence;
    source = 'product';
  }

  // 分流在 base 之前算好（base 里要带 route）
  let manualHit = null;
  // 说明书用它自己的分节关键词匹配，不再依赖分流器的"用法"判定
  // （不然"怎么清洗""会不会掉色"这种，分流器不认识就不会去查说明书）
  const facet = facets.facetOf(queryText);
  if (!candidates.length && goodsId && facet !== 'durability' && facet !== 'behavior') {
    const mr = manualStore.match(goodsId, facets.manualQueryFor(queryText));
    if (mr.mode !== 'none') {
      let cs = manualStore.candidatesOf(mr);
      // 焦点不过（问中毒答"都能用"）→ 不算命中，让位给模型
      if (cs.length && focusMismatch(queryText, cs[0].text, (mr.section && (mr.section.title + ' ' + (mr.section.keywords || []).join(' '))) || '')) {
        cs = [];
      }
      if (cs.length) {
        candidates = cs;
        confidence = mr.mode === 'section' ? 0.92 : 0.8;
        source = 'manual';
        manualHit = { goodsId, mode: mr.mode, title: mr.manual && mr.manual.title };
      }
    }
  }

  // 用法类问题 + 商品已知，但这款没有说明书 → 不要用通用知识硬答（会答错），交给模型
  const skipRule = !candidates.length && Boolean(goodsId) && usageQuestion && !manualHit;

  // 知道是哪个商品，且问的是价格/有没有 → 直接用商品事实回答（不推理）
  // 只有「问价 / 问有没有」才用商品事实；「有发票吗」这种弱「有…吗」不能当库存问题
  const askKind = (un && un.ask) || '';
  if (!candidates.length && goodsInfo && (askKind === 'price' || askKind === 'stock')) {
    const one = { best: goodsInfo, items: [goodsInfo], confidence: 0.95 };
    candidates = un.ask === 'price' ? priceCandidates(one, band) : productCandidates(one, cfg);
    if (candidates.length && focusMismatch(queryText, candidates[0].text)) candidates = [];
    if (candidates.length) {
      confidence = 0.95;
      source = 'product';
      // 让质检层看得见依据：这条回答来自商品目录，不是编的
      base.products = [{
        goodsId: goodsInfo.goodsId,
        title: goodsInfo.title,
        price: goodsInfo.price,
        stock: goodsInfo.stock,
        url: goodsInfo.url,
      }];
    }
  }

  if (!candidates.length && llmReady) {
    const res = await chat(cfg.llm, buildMessages({ messages, knowledgeHits: hits, goods: ctx.goods, storeName: ctx.storeName, style: cfg.style, tier }));
    const parsed = res.ok ? extractJson(res.text) : null;
    if (parsed && Array.isArray(parsed.candidates) && parsed.candidates.length) {
      candidates = parsed.candidates
        .filter((c) => c && c.text)
        .map((c) => ({ tone: c.tone || '标准', text: String(c.text).trim() }));
      confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      needHuman = Boolean(parsed.need_human);
      missing = parsed.missing || '';
      source = 'llm';
      if (parsed.intent) base.intent = parsed.intent;
    } else {
      base.llmError = res.error || '模型输出无法解析';
    }
  }

  // 2. 商品没命中、模型也不可用：知识库兜底（但用法类且商品已知时跳过，避免答错）
  if (!candidates.length && !skipRule) {
    candidates = ruleCandidates(hits, lastBuyer);
    // 基础置信度 × 打平惩罚（margin=1 不打折；margin=0 直接打 0.55 折）
    confidence = hits.length ? confidenceFromScore(hits[0].score) * (0.55 + 0.45 * Math.max(0, margin)) : 0;
    source = candidates.length ? 'rule' : 'none';
    if (!hits.length) missing = '知识库中没有覆盖该问题的资料';
  }

  // 输出侧：带【占位符】的候选一律不放行（那是模板没填）
  candidates = candidates.filter((c) => !/【[^】]+】/.test(String(c.text || '')));

  // 3. 输出侧：先改写（不改事实），改完仍有高危问题才放弃这条
  const styled = [];
  const styleViolations = [];
  for (const c of candidates) {
    const r = await rewrite(c.text, cfg.style);
    if (r.fixed.length || r.remaining.length) {
      styleViolations.push({
        tone: c.tone,
        before: c.text,
        after: r.text,
        fixed: r.fixed,
        polished: r.polished,
        remaining: r.remaining,
      });
    }
    const stillBad = r.remaining.some((i) => i.severity === 'high');
    if (stillBad) continue;
    styled.push({ ...c, text: r.text });
  }
  candidates = styled;

  const screened = [];
  const blocked = [];
  const warnings = [];
  for (const c of candidates) {
    const s = screenOutput(c.text, cfg);
    if (s.ok) screened.push(c);
    else blocked.push({ text: c.text, hits: s.hits });
    if (s.warned && s.warned.length) warnings.push({ text: c.text.slice(0, 40), words: s.warned.map((w) => w.word) });
  }
  candidates = screened;

  // 称呼：只在本次会话的第一次回复加，避免每句都"亲"
  // 先补称呼，再补语气词：事实短句不带语气词会像机器播报（"1.85 元起。"）
  candidates = candidates.map((c) => {
    const withSalutation = applySalutation(c.text, cfg, isFirstReply);
    return { ...c, text: natural.speakTime(warm(withSalutation, { tier, emotion: un.emotion, ask: un.ask })) };
  });

  // 多订单/多商品：本地只筛候选，要不要问、选哪个由模型决定
  const picked = orderSelect.pickOrders(queryText, ctx.orders, ctx.order);
  const orderList = picked.orders;
  const orderItems = orderList.length === 1 && Array.isArray(orderList[0].items) ? orderList[0].items : [];
  const multiEntity = orderList.length > 1 || orderItems.length > 1;
  const entitySensitive = ['shipping_status', 'courier', 'arrival_time', 'order_change', 'after_sale', 'return_policy', 'stock', 'price', 'product', 'recommend'].includes(un.ask);
  if (multiEntity && entitySensitive) {
    return Object.assign(base, {
      decision: 'suggest', source: 'none', suggestions: [], confidence: 0,
      needsModel: true, multiEntity: true,
      reason: '多订单/多商品，交模型判断问哪一单/哪一款',
      engine: ctx.engine || cfg.engine || 'standard',
      latencyMs: Date.now() - started,
    });
  }

  // 本地能答的前提：有候选 + 置信度 ≥0.85 + 来源是知识/商品/说明书。
  // 不再限定「四个模板」：模板会随商家增长，本地也跟着多答，模板之外的才交模型。
  const engineMode = ctx.engine || cfg.engine || 'standard';
  const guardOk = un.ask === 'greeting' || un.ask === 'privacy'; // 问候/隐私不是事实题
  const confidentLocal = candidates.length > 0
    && confidence >= 0.85
    && (!supplemental.length || orderClarify) // 跨了多条知识：交给模型综合，别用单条硬答
    && (source === 'product' || source === 'manual' || source === 'rule' || source === 'order');
  // 没有模型通道时（评测/离线），交模型等于没有回复——直接走兜底，保证每句都有可发的话
  const hasModelChannel = Boolean((cfg.backend && cfg.backend.url) || (cfg.llm && cfg.llm.baseUrl));
  if (!confidentLocal && !guardOk && hasModelChannel) {
    return Object.assign(base, {
      decision: 'suggest',
      confidence: 0,
      source: 'none',
      reason: '本地置信不足，交模型',
      suggestions: [],
      needsModel: true,
      engine: engineMode,
      latencyMs: Date.now() - started,
    });
  }
  // 有模型通道：低置信的不本地答（交给模型）；没有通道：本地尽力答，答不上再兜底
  if (!confidentLocal && hasModelChannel) {
    candidates = [];
    source = 'none';
  }

  if (!candidates.length) {
    const fb = pickFallback({ risks, intent, attempt, ask: un.ask, noContext: hits.length === 0 && !pm, offtopic: un.ask === 'other' && hits.length === 0 && !pm && !(ctx.goods && ctx.goods.title), capabilities: cfg.capabilities });
    // 店铺事实缺口：对外用“以实际为准”的口径，不暴露内部没录
    const shopGap = !blocked.length && !hits.length && !pm && SHOP_ASK.has(un.ask);
    const concernText = concerns.fallbackText(ctx.buyerText || '');
    const text = concernText || (shopGap ? publicFallback(un.ask, ctx.buyerText || '') : fb.text);
    return Object.assign(base, {
      decision: 'fallback',
      reason: shopGap ? '知识缺口：按公开口径回答，并提示商家补录' : blocked.length ? '候选回复命中违禁词，改为兜底话术' : '知识库与模型都没接住，先给兜底话术',
      suggestions: [{ tone: '兜底', text: applySalutation(text, cfg, isFirstReply) }],
      fallback: { level: fb.level, attempt: fb.attempt },
      alert: blocked.length ? 'high' : 'normal',
      blocked,
      cost: 1,
      costReason: 'fallback',
      marginCost: 0,
      latencyMs: Date.now() - started,
    });
  }

  // 4. 决策
  // 模式以本次请求为准（面板上的开关），请求没带才回落到服务端配置。
  const effectiveMode = ctx.mode === 'auto' || ctx.mode === 'suggest' ? ctx.mode : cfg.mode;
  let decision = 'suggest';
  let reason = '';
  if (needHuman) {
    decision = 'handoff';
    reason = '资料不足或需人工判断' + (missing ? '：' + missing : '');
  } else if (risks.includes('引流站外')) {
    decision = 'suggest';
    reason = '买家提到站外联系方式，按平台规则必须人工确认后发送';
  } else if (effectiveMode !== 'auto') {
    decision = 'suggest';
    reason = '当前为建议模式';
  } else if (source === 'rule' && confidence < 0.55) {
    decision = 'suggest';
    reason = '知识匹配度较低，建议人工确认后发送';
  } else if (base.ambiguous) {
    decision = 'suggest';
    reason = '多条知识分数接近（分差 ' + base.margin + '），无法确定用哪条';
  } else if (!(cfg.autoIntentWhitelist || []).includes(base.intent)) {
    decision = 'suggest';
    reason = '意图「' + base.intent + '」不在自动回复白名单';
  } else if (confidence < (cfg.autoMinConfidence || 0.82)) {
    decision = 'suggest';
    reason = `置信度 ${confidence.toFixed(2)} 低于自动发送阈值 ${cfg.autoMinConfidence}`;
  } else if (!inBusinessHours(cfg)) {
    decision = 'suggest';
    reason = '不在自动回复时段';
  } else if (opts.rateOk === false) {
    decision = 'suggest';
    reason = '触发限流，改为人工确认';
  } else {
    decision = 'auto_send';
    reason = '满足自动发送条件';
  }

  // 对外计价：只要产出了可发送的回复，就扣 1 点（不分本地还是模型）。
  // 对内成本：本地命中 = 0 token，模型 = 约 0.004 元。差额就是毛利。
  const delivered = candidates.length > 0 && decision !== 'handoff';

  const ordered = tone.preferCandidate(candidates.slice(0, 3), tier);

  return Object.assign(base, {
    decision,
    reason,
    manual: manualHit,
    tier,
    tierName: (tone.TIERS[tier] || {}).name,
    styleViolations,
    warnings,
    confidence: Number(confidence.toFixed(2)),
    source,
    cost: delivered ? 1 : 0,
    costReason: delivered ? 'answer' : 'none',
    marginCost: source === 'llm' ? 0.004 : 0,
    suggestions: ordered,
    blocked,
    latencyMs: Date.now() - started,
  });
}

/**
 * 商品命中后的候选：用模板拼，保证不编造价格/库存。
 * 列出 1~3 个同品类商品，让买家自己挑——比直接甩一个链接转化更高。
 */
function productCandidates(pm, cfg, ask) {
  const items = pm.items || [];
  if (!items.length) return [];
  const inStock = items.filter((p) => Number(p.stock) > 0);
  const label = (p) => {
    let s = String(p.title || '').trim().split(/[\s，,]/)[0];
    s = s.replace(/(鸟类通用|鸟用|鸟类|专用|通用).*$/, '') || s;
    s = s.replace(/种子$/, '');
    if (s.length > 10) s = s.slice(0, 10);
    return s || p.category || '这款';
  };

  // 同一品类只留一个，避免出现"白萝卜、白萝卜、樱桃萝卜"
  const seenLabel = new Set();
  const unique = [];
  for (const p of inStock.length ? inStock : items) {
    const l = label(p);
    if (seenLabel.has(l)) continue;
    seenLabel.add(l);
    unique.push(p);
  }
  const best = pm.best || items[0];
  const bestInStock = Number(best.stock) > 0;

  // 买家问的那款没货：先如实说没货，再给替代，不能默默换成别的
  if (!bestInStock) {
    const alts = unique.filter((p) => Number(p.stock) > 0 && label(p) !== label(best)).slice(0, 2);
    const head = `${label(best)}暂时没货呢`;
    const text = alts.length
      ? `${head}；同类的${alts.map(label).join('、')}有货，您要哪个？`
      : `${head}。`;
    return [
      { tone: '标准', text },
      { tone: '简短', text: alts.length ? `${label(best)}没货呢，${alts.map(label).join('、')}有货。` : `${label(best)}暂时没货呢。` },
    ];
  }

  const use = unique.slice(0, 3);
  const top = use[0];

  const out = [];
  const priceText = top.priceMax && Number(top.priceMax) > Number(top.price) ? `${top.price} 元起` : `${top.price} 元`;

  if (use.length === 1) {
    if (Number(top.stock) > 0) {
      if (ask === 'price') {
        // 问价格就答价格，不夹杂库存，也不列规格
        out.push({ tone: '标准', text: `${label(top)}是 ${priceText}，可以直接拍。` });
        out.push({ tone: '简短', text: `${priceText}。` });
      } else {
        out.push({
          tone: '标准',
          text: `${label(top)}有货呢！可以直接拍。`,
        });
        out.push({ tone: '简短', text: `${label(top)}有货呢！` });
      }
    } else {
      out.push({ tone: '标准', text: `这款暂时没货了：${top.title}。` });
    }
  } else {
    const names = use.map(label).join('、');
    out.push({ tone: '标准', text: `${names}都有货呢！您要哪个？` });
    out.push({ tone: '简短', text: `${names}都有货呢！` });
  }

  // 可选：带商品链接（部分平台会拦截站外/裸链接，默认关闭）
  if (cfg.productLink && top.url && Number(top.stock) > 0) {
    out.push({ tone: '带链接', text: `${top.title}：${top.url}` });
  }
  return out;
}

function priceCandidates(pm, band) {
  const p = pm.best;
  const name = String(p.title || '').slice(0, 22);
  if (Number(p.stock) === 0) {
    return [{ tone: '标准', text: `${name} 暂时没货了。` }];
  }
  // 价格可能是区间（1.85～16.15），不写死「一袋」
  const max = Number(p.priceMax) || 0;
  const hasRange = max > Number(p.price);
  // 问「最贵/最高」：要的是区间上限；拿「元起」回答只答了一半（ISS-016）
  if (band === 'max' && hasRange) {
    return [
      { tone: '标准', text: `${name}，最高 ${p.priceMax} 元，不同规格价格不一样，具体看下单页。` },
      { tone: '简短', text: `最高 ${p.priceMax} 元。` },
    ];
  }
  const priceText = hasRange ? `${p.price} 元起` : `${p.price} 元`;
  return [
    { tone: '标准', text: `${name}，${priceText}，直接拍就行。` },
    { tone: '简短', text: `${priceText}。` },
  ];
}

module.exports = { generate, priceCandidates, classifyIntent, detectRisk, screenOutput, inBusinessHours, productCandidates, applySalutation };
