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
    storeId: 'real',
  });
  check('F34', '商品卡标题能绑说明书', has(p, 'manual'), JSON.stringify(p.route));
  check('F35', '「多深」问法命中深度节', /覆土/.test(textOf(p, 'manual')), textOf(p, 'manual'));
  check('F36', '绑到的是这一款而不是别的商品', /厘米/.test(textOf(p, 'manual')) && !/番茄/.test(textOf(p, 'manual')), textOf(p, 'manual'));
}

console.log('\n----------------------------------------');
console.log(`事实包单测：${pass} PASS / ${fail} FAIL`);
if (fail) {
  console.log(fails.join('\n'));
  process.exit(1);
}
