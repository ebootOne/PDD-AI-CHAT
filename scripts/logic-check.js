'use strict';

/**
 * logic-check.js —— 端到端逻辑验收（API 级，不点页面）
 *
 * 用法：先启动本地服务（node server/index.js），再 node scripts/logic-check.js
 * 输出：每条 CASE 的 PASS/FAIL，最后汇总；有 FAIL 时退出码 1。
 *
 * 覆盖的是「规则」，不是「话术」：只断言必须出现/必须不出现的信号。
 */

const API = process.env.API_URL || 'http://127.0.0.1:8787';
const ENGINE = process.env.ENGINE || 'standard'; // standard | pro
const STD = ENGINE === 'standard';
const defer = (t) => /页面|商品页|链接|订单|物流/.test(String(t || '')); // 引导去看权威来源，也算答上了
let TITLE = process.env.GOODS_TITLE || '天然花椒木站杆鸟类通用虎皮小太阳和尚玄凤八哥文鸟牡丹鹩哥金刚';
let STORE_ID = process.env.STORE_ID || 'real';
let SECOND_TITLE = '';
let MIN_PRICE = 0;
let MAX_PRICE = 0;

// 用「数据最新」的店铺跑验收：商品过期时不该拿旧数据验逻辑
async function pickStore() {
  try {
    const items = (await (await fetch(API + '/api/products?storeId=' + encodeURIComponent(STORE_ID))).json()).items || [];
    const groups = {};
    for (const it of items) {
      if (!it || !it.syncedAt) continue;
      const k = it.storeId || '';
      (groups[k] = groups[k] || []).push(it);
    }
    let best = null;
    for (const k in groups) {
      const newest = Math.max(...groups[k].map((x) => Date.parse(x.syncedAt) || 0));
      if (!best || newest > best.newest) best = { k, newest, items: groups[k] };
    }
    if (best) {
      STORE_ID = process.env.STORE_ID || best.k;
      TITLE = process.env.GOODS_TITLE || best.items[0].title;
      SECOND_TITLE = best.items[1] ? best.items[1].title : '';
      MIN_PRICE = Number(best.items[0].price) || 0;
      MAX_PRICE = Number(best.items[0].priceMax) || 0;
    }
  } catch (_) {}
}

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

async function reply(text, opts = {}) {
  const card = opts.goodsTitle || TITLE;
  const body = {
    storeId: STORE_ID,
    engine: ENGINE,
    storeName: 'logic-check',
    conversationId: 'lc-' + Math.random().toString(36).slice(2),
    messages: [{ role: 'buyer', text }],
    goods: opts.goods === false ? undefined : { title: card },
    mode: 'suggest',
    test: true,
  };
  const r = await fetch(API + '/api/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

const first = (r) => ((r && r.suggestions && r.suggestions[0]) || {}).text || '';

(async () => {
  await pickStore();
  console.log('测试店铺：' + STORE_ID + ' | 引擎：' + ENGINE + ' | 商品：' + TITLE.slice(0, 12));
  console.log('\n=== 1. 商品事实 ===');
  {
    const r = await reply('这个多少钱');
    const t = first(r);
    check('K01', '问价给价格', /元/.test(t) || (STD && defer(t)), t);
    check('K02', '区间价写成「起」', /元起/.test(t) || (STD && defer(t)), t);
    check('K03', '答价不带库存信息', !/库存|现货|有货/.test(t), t);
  }
  {
    const r = await reply('有没有货');
    const t = first(r);
    check('K04', '问库存答有货', /有货|现货/.test(t), t);
    check('K05', '答库存不夹价格', !/元/.test(t), t);
  }

  console.log('\n=== 2. 说明书 ===');
  {
    const r = await reply('怎么清洗');
    const t = first(r);
    check('K06', '说明书分节命中（清洗）', /清洗|刷洗|擦洗|清水/.test(t) || (STD && defer(t)), t);
    check('K07', '来源标为说明书', r.source === 'manual' || (STD && ['backend', 'policy'].includes(r.source)), r.source);
  }
  {
    const r = await reply('适合多大的鸟');
    const t = first(r);
    check('K08', '说明书优先于知识库', /虎皮|鹦鹉|鸟/.test(t) && !/发芽|适温|土壤/.test(t), t);
  }

  console.log('\n=== 3. 兜底与承诺 ===');
  {
    const r = await reply('什么快递公司');
    const t = first(r);
    check('K09', '不把【占位符】发出去', !/【[^】]+】/.test(t), t);
  }
  {
    const r = await reply('帮我查一下物流到哪了');
    const t = first(r);
    check('K10', '不出现流程承诺', !/我帮您查|稍后回复|安排人|转人工/.test(t), t);
  }
  {
    const r = await reply('你们公司老板叫什么名字');
    check('K11', '兜底也计费（本地 0.5 点）', r.decision !== 'fallback' || Number(r.cost) === 0.5, `decision=${r.decision} cost=${r.cost}`);
  }

  console.log('\n=== 4. 知识库隔离 ===');
  {
    const r = await fetch(API + '/api/knowledge?storeId=real').then((x) => x.json());
    const items = r.items || [];
    check('K12', '只返回本店或通用条目', items.every((k) => !k.storeId || k.storeId === 'real'), 'mixed storeIds');
    check('K13', '归档条目不出现在列表', items.every((k) => !k.archived), 'archived leaked');
  }
  {
    const r = await fetch(API + '/api/knowledge/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'nonexistent' }),
    });
    check('K14', '启用不存在的条目返回 404', r.status === 404, String(r.status));
  }

  console.log('\n=== 5. 商品同步保护 ===');
  {
    const r = await fetch(API + '/api/products/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: 'real', items: [] }),
    }).then((x) => x.json());
    check('K15', '空同步不改数据', r.ok && r.skipped === 'empty', JSON.stringify(r));
  }

  console.log('\n=== 6. 商品未知 ===');
  {
    const r = await reply('怎么种', { goods: false });
    const t = first(r);
    check('K16', '商品未知不乱套说明书', r.source !== 'manual', r.source);
    check('K17', '商品未知不冒充知道是哪款', !/这款|您买的|您拍的/.test(t), t);
  }

  console.log('\n=== 6.5 焦点与域（ISS-002/003/006）===');
  if (SECOND_TITLE) {
    // 商品卡是第一款，买家点名第二款：以他问的为准
    const r = await reply('抽纸多少钱', { goodsTitle: SECOND_TITLE });
    const t = first(r);
    check('K19', '点名另一款商品时按他问的答', (/元/.test(t) && !/1\.85 元起/.test(t)) || (STD && defer(t)), t);
  }
  {
    // 用品店不能拿种子的种植口径来答
    const r = await reply('放阳台晒太阳可以吗');
    const t = first(r);
    check('K20', '不拿种子口径答用品', !/浸种|催芽|露白|播种|土壤/.test(t), t);
  }
  {
    // 真实商品卡标题是截断的（带 …）
    const truncated = TITLE.slice(0, 12) + '…';
    const r = await reply('这个多少钱', { goodsTitle: truncated });
    const t = first(r);
    check('K21', '截断的商品标题也能认出商品', (/元/.test(t) && ['product', 'backend'].includes(r.source)) || (STD && defer(t)), `[${r.source}] ${t}`);
  }

  console.log('\n=== 6.55 包邮 ≠ 价格（ISS-004）===');
  {
    const r = await reply('包邮吗');
    const t = first(r);
    check('K24', '问包邮答包邮，不报价', /包邮|运费|邮费/.test(t) && !/\d+(\.\d+)?\s*元起/.test(t), t);
  }

  console.log('\n=== 6.57 焦点：不许拿"都能用"糊弄（ISS-007）===');
  {
    const r = await reply('鹦鹉啃了会不会中毒');
    const t = first(r);
    check('K25', '安全类问题不被适用对象抢答', !/都能用|中小型鹦鹉更合适/.test(t), t);
  }

  console.log('\n=== 6.58 关切兜底要贴题 ===');
  {
    const r = await reply('这个木头有没有质检报告');
    const t = first(r);
    check('K26', '问凭证就答凭证，不答库存', /报告|检测|凭证|证书/.test(t) && !/库存以商品页/.test(t), t);
  }
  {
    const r = await reply('这个能寄到香港吗');
    const t = first(r);
    const fabricated = /可以寄|能寄|发不了|不发/.test(t);
    check('K27', '没有配送口径就转人工，不编能发不能发', r.decision === 'handoff' || !fabricated, `decision=${r.decision} ${t}`);
  }
  {
    // 流程承诺是硬约束：任何回答都不许出现
    const r = await reply('我的快递怎么还没到');
    const t = first(r);
    check('K28', '不出现流程承诺', !/确认后.{0,6}回复|马上回复|稍后回复|帮您查|安排人/.test(t), t);
  }

  console.log('\n=== 6.59 三级缓冲（ISS-009）===');
  {
    const r = await reply('我要退款');
    const t = first(r);
    check('K29', '退款先问原因，不直接甩规则', /问题|情况|怎么弄|方便/.test(t) && !/以平台售后页面为准/.test(t), t);
  }
  {
    const r = await reply('怎么申请退款');
    const t = first(r);
    check('K30', '问怎么退就给自助入口', /申请售后|订单页/.test(t), t);
  }
  {
    const r = await reply('我要去平台投诉你们');
    const t = first(r);
    check('K31', '投诉不转人工，先共情', !/转人工|安排人|稍后回复/.test(t), t);
  }

  console.log('\n=== 6.61 地区槽位：偏远地区问发货 → 答配送/运费（ISS-011）===');
  {
    for (const q of ['新疆发货吗', '西藏能发吗', '内蒙古包邮吗']) {
      const r = await reply(q);
      const t = first(r);
      check('K32', q + ' → 答配送/运费，不拿发货时间糊弄', (/包邮|运费|邮费/.test(t) || (STD && defer(t))) && !/16点|顺延/.test(t), t);
    }
    // 反例：同样点了地区，问「几天到」是时效问题，不能抢答包邮
    const r = await reply('新疆几天能到');
    const t = first(r);
    check('K33', '反例：新疆几天到 → 答时效，不答包邮', (/天/.test(t) && !/包邮|运费/.test(t)) || defer(t), t);
  }

  console.log('\n=== 6.62 价格档位：问最贵报上限（ISS-016）===');
  {
    const hitMax = (t) => MAX_PRICE > 0 && new RegExp(String(MAX_PRICE).replace('.', '\\.')).test(t);
    for (const q of ['最贵的那个多少钱', '最高多少钱', '最贵的一款多少钱']) {
      const r = await reply(q);
      const t = first(r);
      check('K34', q + ' → 报区间上限', hitMax(t) || (STD && defer(t)), t);
    }
    // 反例：问最便宜报起点，不能报上限
    const r = await reply('最便宜多少钱');
    const t = first(r);
    const hitMin = MIN_PRICE > 0 && new RegExp(String(MIN_PRICE).replace('.', '\\.')).test(t);
    check('K35', '反例：问最便宜 → 报起点，不报上限', (hitMin && !hitMax(t)) || (STD && defer(t)), t);
  }

  console.log('\n=== 6.6 语气（亲近但不轻佻）===');
  {
    const r = await reply('这个多少钱');
    const t = first(r);
    check('K22', '事实短句带语气词', /[哈呢哦啦]。[。！!]?$/.test(t) || /[哈呢哦啦]/.test(t) || (STD && defer(t)), t);
  }
  {
    const r = await reply('收到货破损了怎么办');
    const t = first(r);
    // 只要求「道歉那半句」不带撒娇语气；后面接的服务时间等不算
    check('K23', '道歉/售后句不撒娇', !/(抱歉|对不起|不好意思)[^。！]{0,12}[哈呢啦]/.test(t), t);
  }

  console.log('\n=== 7. 知识隔离（ISS-001）===');
  {
    const r = await fetch(API + '/api/knowledge?storeId=real').then((x) => x.json());
    const generic = (r.items || []).filter((k) => !k.storeId).length;
    check('K18', '通用知识不参与店铺回答', generic === 0, `仍有 ${generic} 条无 storeId 的条目混入`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) {
    console.log('\n失败明细：');
    fails.forEach((f) => console.log(' - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('运行失败：', e.message);
  process.exit(2);
});
