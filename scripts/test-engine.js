'use strict';

/**
 * test-engine.js —— 回复引擎回归（不联网、不依赖浏览器）
 * 运行：node scripts/test-engine.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const engine = require('../server/engine');
const { retrieve, confidenceFromScore } = require('../server/knowledge');

const KB = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'knowledge.json'), 'utf8'));

const baseCfg = {
  mode: 'suggest',
  autoIntentWhitelist: ['logistics', 'spec', 'usage'],
  autoMinConfidence: 0.82,
  businessHours: { enabled: false, start: '08:00', end: '23:00' },
  forbiddenOutput: ['微信', '手机号', '二维码', 'http://', '赔你'],
  llm: { baseUrl: '' },
};

function ctx(text, extra = {}) {
  return Object.assign(
    {
      storeId: 'test',
      storeName: '测试店',
      conversationId: 'c1',
      goods: { title: '', goodsId: '' },
      messages: [{ role: 'buyer', text }],
    },
    extra
  );
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

// ---- 意图 ----
test('意图识别：发货 → logistics', () => {
  assert.strictEqual(engine.classifyIntent('什么时候发货？'), 'logistics');
});
test('意图识别：投诉 → complaint', () => {
  assert.strictEqual(engine.classifyIntent('我要投诉你们'), 'complaint');
});
test('意图识别：发芽率 → usage', () => {
  assert.strictEqual(engine.classifyIntent('这个发芽率多少'), 'usage');
});

// ---- 检索 ----
test('检索：能命中发货知识且排第一', () => {
  const hits = retrieve('什么时候发货', KB);
  assert.ok(hits.length > 0, '应有命中');
  assert.strictEqual(hits[0].entry.id, 'kb-logistics-ship-time');
});
test('检索：无关问题不应高分命中', () => {
  const hits = retrieve('你们公司老板叫什么名字', KB);
  assert.ok(!hits.length || hits[0].score < 4, '不应强命中，实际 ' + (hits[0] && hits[0].score));
});

// ---- 决策 ----
test('建议模式：给候选但 decision=suggest', async () => {
  const r = await engine.generate(ctx('什么时候发货？'), baseCfg, KB, {});
  assert.strictEqual(r.decision, 'suggest');
  assert.ok(r.suggestions.length >= 1, '应有候选');
  assert.ok(r.suggestions[0].text.length > 5);
});

test('自动模式 + 白名单意图 + 高置信 → auto_send', async () => {
  const cfg = Object.assign({}, baseCfg, { mode: 'auto' });
  const r = await engine.generate(ctx('什么时候发货？'), cfg, KB, { rateOk: true });
  assert.strictEqual(r.intent, 'logistics');
  assert.ok(r.confidence >= 0.82, '置信度应达标，实际 ' + r.confidence);
  assert.strictEqual(r.decision, 'auto_send', r.reason);
});

test('自动模式但意图不在白名单 → 退回 suggest', async () => {
  const cfg = Object.assign({}, baseCfg, { mode: 'auto', autoIntentWhitelist: ['spec'] });
  const r = await engine.generate(ctx('什么时候发货？'), cfg, KB, { rateOk: true });
  assert.strictEqual(r.decision, 'suggest');
});

test('自动模式但限流 → 退回 suggest', async () => {
  const cfg = Object.assign({}, baseCfg, { mode: 'auto' });
  const r = await engine.generate(ctx('什么时候发货？'), cfg, KB, { rateOk: false });
  assert.strictEqual(r.decision, 'suggest');
});

test('自动模式但不在工作时段 → 退回 suggest', async () => {
  const cfg = Object.assign({}, baseCfg, {
    mode: 'auto',
    businessHours: { enabled: true, start: '00:00', end: '00:01' },
  });
  const r = await engine.generate(ctx('什么时候发货？'), cfg, KB, { rateOk: true });
  assert.strictEqual(r.decision, 'suggest');
});

test('请求携带 mode=auto 时应覆盖服务端 suggest 配置', async () => {
  const r = await engine.generate(ctx('什么时候发货？', { mode: 'auto' }), baseCfg, KB, { rateOk: true });
  assert.strictEqual(r.decision, 'auto_send', r.reason);
});

test('请求携带 mode=suggest 时应覆盖服务端 auto 配置', async () => {
  const cfg = Object.assign({}, baseCfg, { mode: 'auto' });
  const r = await engine.generate(ctx('什么时候发货？', { mode: 'suggest' }), cfg, KB, { rateOk: true });
  assert.strictEqual(r.decision, 'suggest');
});

test('投诉 → 三级缓冲先共情，不是不回复', async () => {
  for (const mode of ['suggest', 'auto']) {
    const cfg = Object.assign({}, baseCfg, { mode });
    const r = await engine.generate(ctx('种下去没出芽，我要投诉你们！'), cfg, KB, { rateOk: true });
    assert.strictEqual(r.decision, 'suggest');
    assert.ok(r.suggestions.length >= 1);
    assert.ok(/抱歉|问题|情况/.test(r.suggestions[0].text), r.suggestions[0].text);
    assert.strictEqual(r.alert, 'high');
    assert.ok(r.buffer && r.buffer.stage >= 1);
  }
});

test('兜底话术不承诺时间/赔付', async () => {
  const r = await engine.generate(ctx('你们老板叫什么名字'), baseCfg, KB, {});
  assert.strictEqual(r.decision, 'fallback');
  const t = r.suggestions[0].text;
  for (const bad of ['分钟', '保证', '赔', '退款', '一定']) {
    assert.ok(!t.includes(bad), '兜底话术不该出现「' + bad + '」：' + t);
  }
});

test('同一个会话多次兜底会换说法', async () => {
  const first = await engine.generate(ctx('你们老板叫什么名字'), baseCfg, KB, { attempt: 0 });
  const second = await engine.generate(ctx('你们老板叫什么名字'), baseCfg, KB, { attempt: 1 });
  const third = await engine.generate(ctx('你们老板叫什么名字'), baseCfg, KB, { attempt: 2 });
  assert.notStrictEqual(first.suggestions[0].text, third.suggestions[0].text);
  assert.ok(/页面|标注/.test(third.suggestions[0].text), third.suggestions[0].text);
});

test('索赔 → 走缓冲，不转人工也不甩规则', async () => {
  const r = await engine.generate(ctx('必须赔我钱，否则我就去投诉'), baseCfg, KB, {});
  assert.strictEqual(r.decision, 'suggest');
  assert.strictEqual(r.alert, 'high');
  assert.ok(!/转人工|安排人|稍后回复/.test(r.suggestions[0].text));
});

test('买家问加微信 → 不自动发送，但给合规话术', async () => {
  const cfg = Object.assign({}, baseCfg, { mode: 'auto' });
  const r = await engine.generate(ctx('能加个微信聊吗？'), cfg, KB, { rateOk: true });
  assert.strictEqual(r.decision, 'suggest');
  assert.ok(r.risks.includes('引流站外'));
  assert.ok(r.suggestions.length >= 1, '应给出「平台规定不能站外沟通」类话术');
  assert.ok(/站外|微信/.test(r.suggestions[0].text));
});

test('知识库无覆盖 → 兜底，不编造', async () => {
  const r = await engine.generate(ctx('你们老板叫什么名字'), baseCfg, KB, {});
  assert.strictEqual(r.decision, 'fallback');
  assert.ok(!/老板叫/.test(r.suggestions[0].text), '不能编人名');
});

test('没有买家消息 → 转人工', async () => {
  const r = await engine.generate({ storeId: 't', messages: [] }, baseCfg, KB, {});
  assert.strictEqual(r.decision, 'handoff');
});

// ---- 输出侧过滤 ----
test('违禁词过滤：命中即拦截', () => {
  const s = engine.screenOutput('加我微信发你地址', baseCfg);
  assert.strictEqual(s.ok, false);
  assert.ok(s.hits.includes('微信'));
});

test('两条知识打平 → 置信度被打折，不自动发送', async () => {
  const KB2 = [
    { id: 'a', title: '发货时间', keywords: ['发货', '什么时候发'], question: '什么时候发货', answer: '当天发出。' },
    { id: 'b', title: '发货说明', keywords: ['发货', '什么时候发'], question: '什么时候发货', answer: '48小时内发出。' },
  ];
  const cfg = Object.assign({}, baseCfg, { mode: 'auto' });
  const r = await engine.generate(ctx('什么时候发货'), cfg, KB2, { rateOk: true });
  assert.ok(r.ambiguous, '应标记为打平');
  assert.ok(!r.confidence || r.confidence < 0.82, '置信度应被折扣，实际 ' + r.confidence);
  assert.notStrictEqual(r.decision, 'auto_send');
});

test('第一名明显领先 → 不打折，仍可自动发送', async () => {
  const r = await engine.generate(ctx('什么时候发货？'), Object.assign({}, baseCfg, { mode: 'auto' }), KB, { rateOk: true });
  assert.ok(r.margin >= 0.8, '分差应明显，实际 margin=' + r.margin);
  assert.strictEqual(r.decision, 'auto_send');
});

test('礼貌：回答里的「你」被改成「您」', async () => {
  const KB2 = [{ id: 'p', title: '发货时间', keywords: ['什么时候发货'], question: '什么时候发货', answer: '你可以在晴天发货。' }];
  const cfg = Object.assign({}, baseCfg, { style: { tone: 'formal', forbidden: ['随便'], maxExclaim: 1 }, salutation: { enabled: false } });
  const r = await engine.generate(ctx('什么时候发货'), cfg, KB2, {});
  assert.ok(r.suggestions[0].text.includes('您'), r.suggestions[0].text);
  assert.ok(!r.suggestions[0].text.includes('你'), r.suggestions[0].text);
});

test('礼貌：命中「随便」→ 自动改写成「都可以」，不丢回复', async () => {
  const KB2 = [{ id: 'q', title: '包邮', keywords: ['包邮吗'], question: '包邮吗', answer: '随便发哪家都行。' }];
  const cfg = Object.assign({}, baseCfg, { style: { tone: 'formal', maxExclaim: 1 }, salutation: { enabled: false } });
  const r = await engine.generate(ctx('包邮吗'), cfg, KB2, {});
  assert.strictEqual(r.decision, 'suggest');
  assert.ok(!r.suggestions[0].text.includes('随便'), r.suggestions[0].text);
  assert.ok(r.suggestions[0].text.includes('都可以'), r.suggestions[0].text);
});

test('礼貌：生硬否定开头「不知道」→ 改写为「这个我帮您确认一下」', async () => {
  const KB2 = [{ id: 'z', title: '快递公司', keywords: ['发什么快递'], question: '发什么快递', answer: '不知道，你自己看商品页。' }];
  const cfg = Object.assign({}, baseCfg, { style: { tone: 'formal', maxExclaim: 1 }, salutation: { enabled: false } });
  const r = await engine.generate(ctx('发什么快递'), cfg, KB2, {});
  const t = r.suggestions[0].text;
  assert.ok(!t.includes('不知道'), t);
  assert.ok(!t.includes('你自己看'), t);
});

test('事实校验：数字不同视为改坏', () => {
  const { sameFacts } = require('../server/style');
  assert.strictEqual(sameFacts('85% 以上', '85% 以上'), true);
  assert.strictEqual(sameFacts('85% 以上', '90% 以上'), false);
  assert.strictEqual(sameFacts('不能退', '可以退'), false);
});

test('语气档位：催单/投诉 → 歉意，夸奖 → 热情，规格 → 专业', () => {
  const t = require('../server/tone');
  assert.strictEqual(t.detectTier('什么时候发货？', { intent: 'logistics' }), 'standard');
  assert.strictEqual(t.detectTier('怎么还没发货，急死了', { intent: 'logistics' }), 'apology');
  assert.strictEqual(t.detectTier('收到了，谢谢老板', { intent: 'other' }), 'warm');
  assert.strictEqual(t.detectTier('这两个品种有啥区别', { intent: 'spec' }), 'pro');
  assert.strictEqual(t.detectTier('你们这是骗人的吧', { intent: 'complaint', risks: ['投诉威胁'] }), 'apology');
});

test('歉意档位会把「安抚」候选提到第一位', async () => {
  const tone = require('../server/tone');
  assert.strictEqual(tone.detectTier('怎么还没发货，急死了'), 'apology');
  const list = [{ tone: '标准', text: 'a' }, { tone: '安抚', text: 'b' }];
  assert.strictEqual(tone.preferCandidate(list, 'apology')[0].tone, '安抚');
});

test('关闭歉意档 → 回落标准档', async () => {
  const cfg = Object.assign({}, baseCfg, { tone: { enabled: true, disabled: ['apology'] } });
  const r = await engine.generate(ctx('什么时候发货，急死了'), cfg, KB, {});
  assert.strictEqual(r.tier, 'standard');
});

test('商品说明书：白萝卜要泡水，番茄可以不泡', () => {
  const m = require('../server/manuals');
  const radish = m.match('1001', '那要泡水吗');
  const tomato = m.match('1004', '那要泡水吗');
  assert.strictEqual(radish.mode, 'section');
  assert.strictEqual(tomato.mode, 'section');
  assert.ok(radish.sections[0].content.includes('要泡水'), radish.sections[0].content);
  assert.ok(tomato.sections[0].content.includes('不泡'), tomato.sections[0].content);
});

test('说明书优先于知识库（问用法 + 有商品上下文）', async () => {
  const r = await engine.generate(
    { engine: 'pro', messages: [{ role: 'buyer', text: '那要泡水吗' }], goods: { goodsId: '1001' } },
    baseCfg,
    KB,
    {}
  );
  assert.strictEqual(r.source, 'manual');
  assert.ok(r.suggestions[0].text.includes('要泡水'), r.suggestions[0].text);
});

test('没有商品上下文时，说明书不参与（不乱答）', async () => {
  const m = require('../server/manuals');
  const r = m.match('', '那要泡水吗');
  assert.strictEqual(r.mode, 'none');
});

test('问题分流：该由谁回答', () => {
  const r = require('../server/router');
  const cases = [
    ['我要投诉你们', 'risk', {}],
    ['有白萝卜种子吗', 'product', { productKnown: true }],
    ['多少钱一袋', 'product', { productKnown: true }],
    ['那要泡水吗', 'manual', { productKnown: true }],
    ['怎么还没发货', 'policy', { productKnown: true }],
    ['能开发票吗', 'policy', {}],
    ['你们怎么种出来的', 'model', { productKnown: true }],
    ['你们老板叫什么名字', 'model', {}],
  ];
  for (const [q, expect, ctx] of cases) {
    assert.strictEqual(r.classify(q, ctx).route, expect, q + ' 应走 ' + expect);
  }
});

test('商品未知时，说明书路由会降权（不乱套说明书）', () => {
  const r = require('../server/router');
  const known = r.classify('那要泡水吗', { productKnown: true });
  const unknown = r.classify('那要泡水吗', { productKnown: false });
  assert.ok(unknown.scores.manual < known.scores.manual, '未知商品时说明书分数应更低');
});

test('置信度映射单调递增且封顶', () => {
  assert.ok(confidenceFromScore(1) < confidenceFromScore(5));
  assert.ok(confidenceFromScore(9999) <= 0.98);
  assert.strictEqual(confidenceFromScore(0), 0);
});

(async () => {
  let pass = 0;
  const failed = [];
  for (const c of cases) {
    try {
      await c.fn();
      pass++;
      console.log('  ✓ ' + c.name);
    } catch (err) {
      failed.push({ name: c.name, err });
      console.log('  ✗ ' + c.name + '\n      ' + err.message);
    }
  }
  console.log(`\n${pass}/${cases.length} 通过`);
  if (failed.length) process.exit(1);
})();
