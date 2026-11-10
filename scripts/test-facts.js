'use strict';

/**
 * test-facts.js —— Pro 事实包单测（不起服务、不调模型、不花钱）
 *
 * 断言的是「路由/取数/预算/PII/引用」这些机制，不是某一句回复。
 * 用法：node scripts/test-facts.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const facts = require(path.join(ROOT, 'server', 'facts.js'));
const knowledge = require(path.join(ROOT, 'server', 'knowledge.js'));

const kb = require(path.join(ROOT, 'data', 'knowledge.json'));
const products = require(path.join(ROOT, 'data', 'products.json'));

let pass = 0;
let fail = 0;
const fails = [];

function check(id, name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${id}  ${name}`);
  } else {
    fail++;
    fails.push(`${id} ${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${id}  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const p1001 = products.find((x) => String(x.goodsId) === '1001');
const goods = { goodsId: '1001', title: p1001.title };
const storeKb = kb.filter((x) => x.storeId === 'real');

function pack(text, extra = {}) {
  return facts.build({
    buyerText: text,
    goods,
    products: extra.products === undefined ? [{ ...p1001, priceMax: 12 }] : extra.products,
    knowledgeHits: knowledge.retrieve(text, storeKb, { storeId: 'real', goodsId: '1001' }),
    kb: storeKb,
    storeId: 'real',
    ...extra,
  });
}

const has = (p, block) => p.items.some((x) => x.block === block);
const textOf = (p, block) => p.items.filter((x) => x.block === block).map((x) => x.text).join(' / ');
const missingOf = (p, block) => p.missing.some((x) => x.block === block);

console.log('=== 1. 路由 ===');
{
  const p = pack('这个多少钱');
  check('F01', '问价带商品块', has(p, 'product'), JSON.stringify(p.route));
  check('F02', '问价只取价格字段', /元/.test(textOf(p, 'product')) && !/库存/.test(textOf(p, 'product')), textOf(p, 'product'));
  check('F03', '问价不触发订单块', !p.route.orderAsked && !missingOf(p, 'order'));
}
{
  const p = pack('有没有货');
  check('F04', '问库存带库存事实', /有货|无货/.test(textOf(p, 'product')), textOf(p, 'product'));
  check('F05', '问库存不夹价格', !/元/.test(textOf(p, 'product')), textOf(p, 'product'));
}
{
  const p = pack('要泡水吗');
  check('F06', '用法带说明书节', has(p, 'manual') && /泡/.test(textOf(p, 'manual')), textOf(p, 'manual'));
}
{
  const p = pack('我的订单到哪了');
  check('F07', '问这一单必须标订单缺失', p.route.orderAsked && missingOf(p, 'order'), JSON.stringify(p.missing));
  check('F08', '没有订单数据不编订单事实', !has(p, 'order'));
}
{
  const p = pack('多少钱，发什么快递');
  check('F09', '多意图拆出两个 ask', p.route.asks.includes('price') && p.route.asks.includes('courier'), JSON.stringify(p.route.asks));
  check('F10', '多意图事实取并集', has(p, 'product') && /快递/.test(JSON.stringify(p.items)), JSON.stringify(p.items.map((x) => x.label)));
}
{
  const p = facts.build({ buyerText: '嗯嗯', goods: null, products: [], knowledgeHits: [], kb: [], storeId: 'real' });
  check('F11', '全无事实时标 all 缺失', missingOf(p, 'all') && p.items.length === 0, JSON.stringify(p));
}

console.log('\n=== 2. 预算与结构 ===');
{
  const p = pack('这个多少钱');
  check('F12', 'tokens 不超硬上限', p.budget.tokens <= facts.TOKEN_LIMIT, String(p.budget.tokens));
  check('F13', 'id 连续且唯一', p.items.every((x, i) => x.id === 'F' + (i + 1)) && new Set(p.items.map((x) => x.id)).size === p.items.length);
  check('F14', '每条事实有 block/label/text', p.items.every((x) => x.block && x.label && x.text));
}
{
  // 预算装箱：10 条长事实必须被收住，且丢掉的要记原因（不是静默截断）
  const long = '这是一条很长的政策说明，用来把预算顶穿。'.repeat(8);
  const items = Array.from({ length: 10 }, (_, i) => ({ block: 'policy', label: '条目' + i, text: long + i, priority: 1 + i }));
  const packed = facts.packItems(items);
  check('F15', '超预算不顶穿 800', packed.tokens <= facts.TOKEN_LIMIT, String(packed.tokens));
  check('F16', '丢弃有记录', packed.dropped.length > 0, JSON.stringify(packed.dropped.slice(0, 2)));
  check('F17', '事实条数受限', packed.items.length <= 8, String(packed.items.length));
}

console.log('\n=== 3. PII ===');
{
  // 订单块只允许白名单字段：状态/时间/快递/运单尾号，收件人信息一律不进包
  const p = facts.build({
    buyerText: '我的订单到哪了，电话 13812345678',
    goods: { goodsId: '9', title: '种子' },
    products: [{ goodsId: '9', title: '种子', price: 9.9, stock: 3 }],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
    order: {
      status: '已发货',
      receiver: '张三',
      phone: '13900001111',
      address: '北京市朝阳区某路1号院2号楼',
      courier: '中通快递',
      trackingNo: '781234567890123',
    },
  });
  const all = JSON.stringify(p.items);
  check('F18', '事实包不出现手机号', !/1[3-9]\d{9}/.test(all), all.slice(0, 160));
  check('F19', '事实包不出现收件人姓名', !all.includes('张三'), all.slice(0, 160));
  check('F20', '事实包不出现详细地址', !/朝阳区|某路|号楼/.test(all), all.slice(0, 160));
  check('F26', '订单可答字段保留', /已发货/.test(all) && /中通/.test(all), all.slice(0, 160));
  check('F27', '运单号只留尾号', !/781234567890123/.test(all), all.slice(0, 160));
}

console.log('\n=== 4. 引用校验 ===');
{
  const p = pack('这个多少钱');
  const v = facts.validateUsed(p, ['F1', 'f1', 'F99', '']);
  check('F21', '合法的 used 保留', v.valid.includes('F1'), JSON.stringify(v));
  check('F22', '不存在的 id 被识别', v.invalid.includes('F99'), JSON.stringify(v));
  check('F23', '大小写归一', v.valid.length === 1, JSON.stringify(v));
}

console.log('\n=== 5. 渲染 ===');
{
  const p = pack('这个多少钱');
  const r = facts.render(p);
  check('F24', '渲染带编号', /^\[F1\]/.test(r), r.split('\n')[0]);
  check('F25', '渲染条数一致', r.split('\n').length === p.items.length, String(p.items.length));
}

console.log('\n=== 6. 质检引用校验 ===');
{
  const judge = require(path.join(ROOT, 'server', 'judge.js'));
  const base = {
    understanding: { ask: 'price', text: '这个多少钱' },
    intent: 'price',
    risks: [],
    knowledge: [{ id: 'kb1', title: '价格' }],
    products: [{ goodsId: '1001', title: '白萝卜种子', price: 9.9 }],
    capabilities: {},
  };
  const fp = {
    items: [{ id: 'F1', block: 'product', label: '价格', text: '白萝卜种子：9.9 元' }],
    used: ['F1'],
    invalid: [],
    asks: ['price'],
    blocks: ['product'],
  };

  const ok = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款白萝卜种子是 9.9 元，可以直接拍。' }], facts: fp });
  check('F28', '有引用且数字有据 → 放行', ok.action === 'keep', JSON.stringify(ok));

  const badCite = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款 9.9 元。' }], facts: { ...fp, invalid: ['F9'] } });
  check('F29', '引用不存在的编号 → 兜底', badCite.action === 'fallback' && badCite.issues.includes('引用不存在'), JSON.stringify(badCite));

  const badNum = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款白萝卜种子是 8.8 元，可以直接拍。' }], facts: fp });
  check('F30', '数字在事实里找不到 → 兜底', badNum.action === 'fallback' && badNum.issues.includes('数字无依据'), JSON.stringify(badNum));

  const multi = {
    ...base,
    understanding: { ask: 'price', text: '多少钱，发什么快递' },
    facts: {
      items: [
        { id: 'F1', block: 'product', label: '价格', text: '白萝卜种子：9.9 元' },
        { id: 'F2', block: 'policy', label: '默认快递', text: '默认发中通，偏远地区发邮政。' },
      ],
      used: ['F1'],
      invalid: [],
      asks: ['price', 'courier'],
      blocks: ['product', 'policy'],
    },
  };
  const partial = judge.review({ ...multi, suggestions: [{ tone: '标准', text: '这款是 9.9 元，可以直接拍。' }] });
  check('F31', '多意图只答一半 → 兜底', partial.action === 'fallback' && partial.issues.includes('多意图未覆盖'), JSON.stringify(partial));

  const full = judge.review({ ...multi, suggestions: [{ tone: '标准', text: '这款是 9.9 元，默认发中通快递。' }] });
  check('F32', '多意图逐条覆盖 → 放行', full.action === 'keep', JSON.stringify(full));

  const neg = judge.review({
    ...base,
    buyerText: '有质检报告吗',
    suggestions: [{ tone: '标准', text: '这款暂时没有质检报告，是天然原木材质。' }],
    facts: null,
  });
  check('N01', '替商家否定资质 → 兜底', neg.action === 'fallback' && neg.issues.includes('替商家否定'), JSON.stringify(neg));

  const certOk = judge.review({
    ...base,
    buyerText: '有质检报告吗',
    suggestions: [{ tone: '标准', text: '亲，都是经过严格筛选的产品，检测信息以商品页标注为准哈。' }],
    facts: null,
  });
  check('N02', '正面口径不误杀', certOk.action === 'keep', JSON.stringify(certOk));

  check('N03', '已给天数 → 不缺数值', judge.missingDims('一般3~5天露白', ['days']).length === 0);
  check('N04', '只给形容 → 判缺天数', judge.missingDims('温度合适就发芽', ['days']).includes('days'));

  const unitBad = judge.review({
    ...base,
    buyerText: '抽纸多少抽',
    understanding: { ask: 'spec', text: '抽纸多少抽' },
    suggestions: [{ tone: '标准', text: '这款是520张的大包抽纸哈。' }],
    facts: { items: [{ id: 'F1', block: 'product', label: '商品', text: '加量520张大包抽纸：520张/包' }], missing: [] },
  });
  check('N05', '问抽答张 → 只替换数量句', ['replace', 'fallback'].includes(unitBad.action) && unitBad.issues.includes('单位不一致'), JSON.stringify(unitBad));

  const unitOk = judge.review({
    ...base,
    buyerText: '抽纸多少抽',
    understanding: { ask: 'spec', text: '抽纸多少抽' },
    suggestions: [{ tone: '标准', text: '520张/包，多少抽以包装标注为准哈。' }],
    facts: { items: [{ id: 'F1', block: 'product', label: '商品', text: '加量520张大包抽纸：520张/包' }], missing: [] },
  });
  check('N06', '明确说包装标注 → 不误杀', unitOk.action === 'keep', JSON.stringify(unitOk));

  const multiProduct = judge.review({
    ...base,
    buyerText: '还有货嘛',
    understanding: { ask: 'stock', text: '还有货嘛', dims: [] },
    suggestions: [{ tone: '标准', text: '亲，是申通哦，订单页可查物流哈。' }],
    facts: { items: [
      { id: 'F1', block: 'order', label: '订单1', text: '状态：已发货；商品：金乡大蒜' },
      { id: 'F2', block: 'order', label: '订单2', text: '状态：退款成功；商品：天然花椒木站杆' },
      { id: 'F3', block: 'order', label: '订单3', text: '状态：退款成功；商品：抽纸' },
    ], missing: [] },
    multiEntity: true,
  });
  check('N15', '多商品库存问题不能假定某款', multiProduct.action === 'replace' && /花椒木/.test((multiProduct.cleanedList || []).join('')), JSON.stringify(multiProduct));

  const multiPkg = judge.review({
    ...base,
    buyerText: '发的哪家快递',
    understanding: { ask: 'courier', text: '发的哪家快递' },
    suggestions: [{ tone: '标准', text: '这单发的是申通哈。' }],
    facts: { items: [{ id: 'F1', block: 'order', label: '订单', text: '状态：已发货；包裹：申通尾号9410；中通尾号6789' }], missing: [] },
  });
  check('N13', '多包裹必须逐个报', multiPkg.action === 'replace' && /中通/.test((multiPkg.cleanedList || []).join('')), JSON.stringify(multiPkg));

  const clarify = judge.review({
    ...base,
    buyerText: '还有吗',
    understanding: { ask: 'stock', text: '还有吗', dims: [] },
    suggestions: [{ tone: '标准', text: '亲，您问的是金乡大蒜还是抽纸呀？' }],
    facts: { items: [{ id: 'F1', block: 'order', label: '订单商品', text: '商品：金乡大蒜、抽纸' }], missing: [] },
    clarify: true,
  });
  check('N12', '多商品澄清问句 → 放行', clarify.action === 'keep', JSON.stringify(clarify));

  const courier = judge.review({
    ...base,
    buyerText: '发的哪家的快递呢',
    understanding: { ask: 'courier', text: '发的哪家的快递呢' },
    suggestions: [{ tone: '标准', text: '默认中通，偏远走邮政哈。' }],
    facts: { items: [
      { id: 'F1', block: 'policy', label: '快递', text: '默认中通，偏远走邮政' },
      { id: 'F2', block: 'order', label: '订单', text: '状态：已发货；快递：申通；运单尾号：9410' },
    ], missing: [] },
  });
  check('N11', '订单实际快递优先于默认政策', courier.action === 'replace' && /申通/.test((courier.cleanedList || []).join('')), JSON.stringify(courier));

  const noSuch = judge.review({
    ...base,
    buyerText: '到底什么时候能到呢',
    suggestions: [{ tone: '标准', text: '亲，您发的这串数字我这边看不到物流详情呢。' }],
    facts: { items: [{ id: 'F1', block: 'order', label: '订单', text: '状态：已发货' }], missing: [] },
  });
  check('N10', '不能说买家没发过的数字', noSuch.action === 'fallback' && noSuch.issues.includes('无中生有'), JSON.stringify(noSuch));

  const numBad = judge.review({
    ...base,
    buyerText: '这个多少钱',
    suggestions: [{ tone: '标准', text: '亲，2.5 元呢。' }],
    facts: { items: [{ id: 'F1', block: 'product', label: '价格', text: '天然花椒木：1.85 元起' }], missing: [] },
  });
  check('N07', '事实 1.85 却答 2.5 → 数字无依据', numBad.action === 'fallback' && numBad.issues.includes('数字无依据'), JSON.stringify(numBad));

  const numOk = judge.review({
    ...base,
    buyerText: '几天发芽',
    understanding: { ask: 'usage', text: '几天发芽' },
    suggestions: [{ tone: '标准', text: '一般3~5天露白哈。' }],
    facts: { items: [{ id: 'F1', block: 'manual', label: '催芽', text: '一般3~5天露白就能播' }], missing: [] },
  });
  check('N08', '事实 3~5天 → 不误杀', numOk.action === 'keep', JSON.stringify(numOk));

  const noFacts = judge.review({ ...base, suggestions: [{ tone: '标准', text: '这款 9.9 元。' }] });
  check('F33', '非 Pro 路径不受引用校验影响', noFacts.action === 'keep', JSON.stringify(noFacts));
}

console.log('\n=== 7. 商品卡绑定 ===');
{
  // 只有商品卡标题、这句话里没提商品名：说明书也要按商品卡绑上
  const p = facts.build({
    buyerText: '土要多深',
    goods: { title: p1001.title },
    products: [],
    knowledgeHits: [],
    kb: [],
    storeId: 'demo',
  });
  check('F34', '商品卡标题能绑说明书', has(p, 'manual'), JSON.stringify(p.route));
  check('F35', '「多深」问法命中深度节', /覆土/.test(textOf(p, 'manual')), textOf(p, 'manual'));
  check('F36', '绑到的是这一款而不是别的商品', /厘米/.test(textOf(p, 'manual')) && !/番茄/.test(textOf(p, 'manual')), textOf(p, 'manual'));
}

console.log('\n=== 8. 关切焦点 ===');
{
  const title = '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚';
  const p = facts.build({ buyerText: '鹦鹉啃了会不会中毒', goods: { title }, products: [], knowledgeHits: [], kb: [], storeId: 'real' });
  check('F37', '问安全不给「适用对象」当依据', !p.items.some((i) => i.block === 'manual' && /适用对象/.test(i.label)), JSON.stringify(p.items.map((i) => i.label)));
  check('F38', '关切没有依据要标缺失', p.missing.some((m) => m.block === 'concern'), JSON.stringify(p.missing));

  const q = facts.build({ buyerText: '鹦鹉能用吗', goods: { title }, products: [], knowledgeHits: [], kb: [], storeId: 'real' });
  check('F39', '不涉及关切时保留适用对象', q.items.some((i) => /适用对象/.test(i.label)), JSON.stringify(q.items.map((i) => i.label)));
}

console.log('\n=== 9. 本地路由 ===');
{
  const factRoute = require(path.join(ROOT, 'server', 'fact-route.js'));

  const a = factRoute.route({ buyerText: '我的订单到哪了', hasGoods: false });
  check('R01', '问这一单 → 订单块最优先', a.wanted[0].key === 'order' && a.orderAsked, JSON.stringify(a.wanted));
  check('R02', '同时识别出物流状态', a.asks.includes('shipping_status'), JSON.stringify(a.asks));

  const b = factRoute.route({ buyerText: '多少钱，发什么快递', hasGoods: true });
  check('R03', '多意图拆两个 ask', b.asks.includes('price') && b.asks.includes('courier'), JSON.stringify(b.asks));
  check('R04', '商品块优先于政策', b.wanted.findIndex((w) => w.key === 'product') < b.wanted.findIndex((w) => w.key === 'policy'), JSON.stringify(b.wanted.map((w) => w.key)));

  const c = factRoute.route({ buyerText: '多少钱', hasGoods: false });
  check('R05', '没识别商品就不取商品/说明书', !c.wanted.some((w) => w.key === 'product' || w.key === 'manual'), JSON.stringify(c.wanted));

  const d = factRoute.route({ buyerText: '鹦鹉啃了会不会中毒', hasGoods: true });
  check('R06', '识别安全关切', d.concern && d.concern.key === 'safety', JSON.stringify(d.concern && d.concern.key));

  const e = factRoute.route({ buyerText: '嗯嗯', hasGoods: true, understanding: { ask: 'other' } });
  check('R07', '没明确问法也要查政策与说明书', e.wanted.some((w) => w.key === 'policy') && e.wanted.some((w) => w.key === 'manual'), JSON.stringify(e.wanted.map((w) => w.key)));

  // 反例：问优惠不是问这一单，不能被「查一下」误判成订单
  const f = factRoute.route({ buyerText: '帮我查一下能不能便宜', hasGoods: true });
  check('R08', '「查一下」不触发订单块', !f.orderAsked, JSON.stringify(f.wanted.map((w) => w.key)));

  const g = factRoute.route({ buyerText: '包邮吗', hasGoods: true });
  check('R10', '「这个多大」识别为规格', factRoute.route({ buyerText: '这个多大', hasGoods: true }).asks.includes('spec'));
  const t22 = factRoute.route({ buyerText: '这个多大，能寄到新疆吗，包邮吗', hasGoods: true });
  check('R11', '三连问标记多意图', t22.multi === true && t22.asks.includes('spec') && t22.asks.includes('freight'), JSON.stringify({ asks: t22.asks, unknown: t22.unknownParts.length, multi: t22.multi }));
  const i8 = factRoute.route({ buyerText: '我想问下这个站杆多长 能发顺丰吗 今天下单明天能到吗 能便宜点不', hasGoods: true });
  check('R12', '空格连写也能拆出多个诉求', i8.multi === true && i8.asks.length >= 2, JSON.stringify({ asks: i8.asks, multi: i8.multi }));

  check('R13', '「种子几天发芽」按时长对象归 usage', factRoute.route({ buyerText: '种子几天发芽', hasGoods: true }).asks.includes('usage'));
  check('R14', '「几天能到」才是到货时效', factRoute.route({ buyerText: '几天能到', hasGoods: true }).asks.includes('arrival_time'));
  check('R15', '「几天发货」归发货时间', factRoute.route({ buyerText: '几天发货', hasGoods: true }).asks.includes('shipping_time'));
  const r16 = factRoute.route({ buyerText: '大概几天', hasGoods: true });
  check('R16', '反例：只说几天不给对象 → 不猜意图', !r16.asks.length || r16.asks[0] === 'other', JSON.stringify(r16.asks));

  check('R09', '包邮问题不取订单块', !g.orderAsked && g.asks.includes('freight'), JSON.stringify(g.asks));
}

console.log('\n=== 10. 兜底扩召回 ===');
{
  const storeKb2 = kb.filter((x) => x.storeId === 'real');
  const a = facts.build({
    buyerText: '能开发票吗',
    goods: null,
    products: [],
    knowledgeHits: [],
    kb: storeKb2,
    storeId: 'real',
  });
  check('E01', '按 ask 直接补到发票口径（不靠扩召回）', a.route.mode === 'normal' && a.items.some((i) => /发票/.test(i.text)), JSON.stringify({ mode: a.route.mode, items: a.items.map((i) => i.label) }));
  check('E02', '扩召回补到发票口径', a.items.some((i) => /发票/.test(i.text)), JSON.stringify(a.items.map((i) => i.label)));
  check('E03', '正常档预算 800', a.budget.limit === 800 && a.budget.tokens <= 800, JSON.stringify(a.budget));

  const b = facts.build({
    buyerText: '多少钱',
    goods: { title: p1001.title },
    products: [{ ...p1001, priceMax: 12 }],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('E04', '正常命中不扩召回', b.route.mode === 'normal', JSON.stringify(b.route.mode));

  const c = facts.build({
    buyerText: '规格是多少',
    goods: { title: p1001.title },
    products: [p1001],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('E05', '未覆盖的 ask 触发扩召回', c.route.mode === 'wide' && /spec/.test((c.route.widen || {}).trigger || ''), JSON.stringify(c.route.widen));

  // 关切无依据：扩召回不能拿「适用对象」来凑数
  const d = facts.build({
    buyerText: '鹦鹉啃了会不会中毒',
    goods: { title: '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚' },
    products: [],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  const e = facts.build({
    buyerText: '我的订单到哪了',
    goods: null,
    products: [],
    knowledgeHits: [],
    kb: kb.filter((x) => x.storeId === 'real'),
    storeId: 'real',
  });
  const o = facts.build({
    buyerText: '我的订单到哪了',
    goods: null,
    products: [],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
    order: {
      status: '已发货',
      courier: '中通快递',
      trackingNo: '781234567890123',
      receiver: '张三',
      phone: '13900001111',
      address: '北京市朝阳区某路1号院',
    },
  });
  check('E08', '有订单数据 → 订单块生效', o.route.mode === 'normal' && o.items[0] && o.items[0].block === 'order' && !o.missing.some((m) => m.block === 'order'), JSON.stringify(o.items));
  check('E09', '订单只给白名单字段', /已发货/.test(o.items[0].text) && !/张三|13900001111|朝阳/.test(JSON.stringify(o.items)), o.items[0].text);

  const g = facts.build({
    buyerText: '发货了吗',
    goods: null,
    products: [],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('E10', '注册表命中 → 问法改为物流状态', g.route.registry && g.route.registry.id === 'reg_shipped_or_not' && g.route.asks[0] === 'shipping_status', JSON.stringify(g.route.registry));
  check('E11', '注册表要求订单但没数据 → 标缺失', g.missing.some((m) => m.block === 'order'), JSON.stringify(g.missing));

  check('E07', '只问物流且无订单 → 不硬凑政策', e.route.mode === 'empty' && e.items.length === 0, JSON.stringify({ mode: e.route.mode, items: e.items.map((i) => i.label) }));

  check('E06', '关切扩召回仍不放适用对象', !d.items.some((i) => i.block === 'manual' && /适用对象/.test(i.label)), JSON.stringify(d.items.map((i) => i.label)));
}

console.log('\n=== 11. 规格块 ===');
{
  const withSpec = facts.build({
    buyerText: '规格是多少',
    goods: { title: p1001.title },
    products: [{ ...p1001, spec: '20g/袋' }],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('S01', '有 spec 字段 → 出规格事实', withSpec.items.some((i) => i.block === 'product' && /规格/.test(i.label) && /20g/.test(i.text)), JSON.stringify(withSpec.items));
  check('S02', '有 spec 就不标缺失', !withSpec.missing.some((m) => m.field === 'spec'), JSON.stringify(withSpec.missing));

  const stand = facts.build({
    buyerText: '尺寸多大',
    goods: { title: '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚' },
    products: [],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('S03', '说明书有尺寸节 → 不算缺规格', stand.items.some((i) => i.block === 'manual') && !stand.missing.some((m) => m.field === 'spec'), JSON.stringify({ items: stand.items.map((i) => i.label), missing: stand.missing }));

  const noSpec = facts.build({
    buyerText: '规格是多少',
    goods: { title: p1001.title },
    products: [p1001],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('S04', '没有规格也没说明书 → 标缺失', noSpec.missing.some((m) => m.field === 'spec'), JSON.stringify(noSpec.missing));
}

console.log('\n=== 12. 商品域隔离 ===');
{
  const storeKb3 = kb.filter((x) => x.storeId === 'real');
  const stand = facts.build({
    buyerText: '放阳台晒太阳可以吗',
    goods: { title: '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚' },
    products: [],
    knowledgeHits: [],
    kb: storeKb3,
    storeId: 'real',
  });
  const standText = JSON.stringify(stand.items);
  check('D01', '用品不取种子口径', !/浸种|催芽|露白|播种|覆土|土壤|发芽/.test(standText), stand.items.map((x) => x.label).join(','));
  check('D02', '用品仍有关切/说明', stand.items.length > 0, String(stand.items.length));

  const seed = facts.build({
    buyerText: '土要多深',
    goods: { title: p1001.title },
    products: [p1001],
    knowledgeHits: [],
    kb: [],
    storeId: 'real',
  });
  check('D03', '种子仍保留种植口径', /覆土|厘米/.test(JSON.stringify(seed.items)), seed.items.map((x) => x.label).join(','));
}

console.log('\n=== 13. 事实元数据/冲突/过期 ===');
{
  const conflict = facts.resolveConflicts([
    { block: 'product', label: '规格', text: '规格：18cm', source: 'catalog' },
    { block: 'manual', label: '规格', text: '规格：20cm', source: 'manual' },
    { block: 'policy', label: '包邮范围', text: '全国包邮', source: 'knowledge' },
  ]);
  check('M01', '同字段两种说法 → 标记冲突但保留给模型', conflict.conflicts.length === 1 && conflict.items.length === 3 && conflict.items.filter((i) => i.conflict).length === 2, JSON.stringify(conflict));
  check('M02', '冲突带来源', conflict.conflicts[0] && conflict.conflicts[0].sources.length === 2, JSON.stringify(conflict.conflicts[0]));

  const stale = facts.productItems({ goodsId: 'g', title: '白萝卜种子', price: '9.9', stock: 10, syncedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }, ['price']);
  check('M03', '商品过期 → 不报价', stale.items.length === 0 && stale.missing.some((m) => m.reason === 'stale'), JSON.stringify(stale));

  const fresh = facts.productItems({ goodsId: 'g', title: '白萝卜种子', price: '9.9', stock: 10, syncedAt: new Date().toISOString() }, ['price']);
  check('M04', '商品带来源与时间', fresh.items[0] && fresh.items[0].source === 'catalog' && fresh.items[0].updatedAt, JSON.stringify(fresh.items[0]));
}

  const kbPrice = { id: 'kb-price', ask: 'price', title: '价格', answer: '白萝卜种子：1.9 元', keywords: ['价格'] };
  const oneSource = facts.build({
    buyerText: '多少钱',
    goods: { goodsId: 'g1', title: '白萝卜种子' },
    products: [{ goodsId: 'g1', title: '白萝卜种子', price: '9.9', stock: 10, syncedAt: new Date().toISOString() }],
    knowledgeHits: [{ entry: kbPrice, score: 9 }],
    kb: [kbPrice],
    storeId: 'real',
  });
  check('M05', '价格多来源 → 冲突交给模型判断', oneSource.conflicts.length === 1 && oneSource.items.length >= 2, JSON.stringify({ items: oneSource.items.map((i) => i.text), conflicts: oneSource.conflicts }));

  const jg = require(require('path').join(__dirname, '..', 'server', 'judge.js'));
  const safety = jg.review({
    buyerText: '鹦鹉啃了会不会中毒',
    understanding: { ask: 'other', text: '鹦鹉啃了会不会中毒' },
    suggestions: [{ tone: '标准', text: '这款是天然木，您可以放心使用。' }],
    knowledge: [{ id: 'k', title: '适用对象' }],
    products: [],
  });
  check('N09', '安全类「放心使用」→ 兜底', safety.action === 'fallback' && safety.issues.includes('安全绝对化'), JSON.stringify(safety));

console.log('\n----------------------------------------');
console.log(`事实包单测：${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log(fails.join('\n'));
  process.exit(1);
}
