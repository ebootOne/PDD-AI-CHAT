'use strict';

/**
 * desktop-probe-100.js —— 用桌面客户端跑 100 条随机问答
 *
 * 全程走客户端自己的「测试会话」输入框：点新会话 → 输入 → 点发送 → 读回渲染结果。
 * 不直接调 /api/reply，验证的是“商家真正看到的链路”。
 *
 * 前置：客户端带 --remote-debugging-port=9335 启动，本地服务 8787 在跑。
 * 运行：node scripts/desktop-probe-100.js [seed]
 */

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9335);
const OUT = path.join(__dirname, '..', 'eval', 'desktop-100.md');
const SEED = Number(process.argv[2]) || Date.now() % 100000;

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const PRODUCTS = ['白萝卜', '樱桃萝卜', '胡萝卜', '番茄', '生菜', '黄瓜', '螺丝椒', '大白菜', '水果玉米', '香葱', '菠菜', '朝天椒'];
const REGIONS = ['河南', '黑龙江', '新疆', '内蒙古', '广东', '四川', '浙江'];
const OPENERS = ['', '', '', '你好，', '老板，', '问一下，', '请问', '在吗 '];
const T = {
  stock: ['有{p}种子吗', '{p}还有货吗', '有没有{p}', '{p}现在有货吗'],
  price: ['{p}多少钱', '{p}多钱一袋', '{p}怎么卖', '{p}价格多少', '{p}便宜点行吗'],
  ship: ['什么时候发货', '今天拍的能发吗', '下单后多久发货', '发什么快递', '能顺丰吗'],
  arrival: ['几天能到{r}', '发{r}要多久', '{r}多久能到', '到{r}运费多少'],
  usage: ['{p}怎么种', '{p}要泡水吗', '{p}泡多久', '{p}几月种合适', '{p}发芽温度多少', '{p}适合阳台种吗'],
  spec: ['{p}一袋多少克', '{p}一袋能种多少', '{p}一袋多少粒'],
  after: ['收到{p}种子坏了怎么办', '{p}种下去没出芽', '{p}不发芽怎么回事', '{p}少发了一袋'],
  policy: ['能开发票吗', '专票要什么资料', '包邮吗', '能货到付款吗', '拆封了还能退吗', '有优惠券吗'],
  threat: ['再不发货我就退款', '再拖我就投诉', '都三天了还没发', '再不处理就差评'],
  misc: ['你们老板电话多少', '能加微信吗', '你是不是机器人', '土壤pH多少合适', '一亩地要几袋', '能帮我写个总结吗', '你们公司地址在哪', '种子能过海关吗'],
};
const KINDS = ['stock', 'price', 'ship', 'arrival', 'usage', 'spec', 'after', 'policy', 'threat', 'misc'];
const W = { stock: 12, price: 14, ship: 12, arrival: 10, usage: 16, spec: 8, after: 12, policy: 8, threat: 5, misc: 3 };

function one() {
  const total = Object.values(W).reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  let kind = 'price';
  for (const k of KINDS) { r -= W[k]; if (r <= 0) { kind = k; break; } }
  let t = pick(T[kind]).replace(/\{p\}/g, pick(PRODUCTS)).replace(/\{r\}/g, pick(REGIONS));
  return (pick(OPENERS) + t).trim();
}

const CASES = [];
const seen = new Set();
let guard = 0;
while (CASES.length < 100 && guard < 5000) {
  guard++;
  const t = one();
  if (seen.has(t)) continue;
  seen.add(t);
  CASES.push(t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && String(x.url).includes('/renderer/index.html'));
  if (!t) throw new Error('没找到客户端窗口；确认带 --remote-debugging-port=9335 启动');
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  // 关掉可能开着的弹窗，再打开测试会话
  await cdp.eval("document.querySelectorAll('.modal-close').forEach(b=>b.click())");
  await sleep(300);
  await cdp.eval("document.getElementById('btnTest').click()");
  await sleep(400);
  if (!(await cdp.eval("Boolean(document.getElementById('tsInput'))"))) throw new Error('测试会话没有打开');

  const rows = [];
  for (let i = 0; i < CASES.length; i++) {
    const text = CASES[i];
    await cdp.eval("document.getElementById('tsNew').click()");
    await sleep(60);
    await cdp.eval(`(() => {
      const i = document.getElementById('tsInput');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('tsSend').click();
      return true;
    })()`);

    let got = null;
    for (let k = 0; k < 80; k++) {
      await sleep(120);
      const st = await cdp.eval(`(() => {
        const ai = document.querySelectorAll('#tsBody .turn.ai');
        if (!ai.length) return null;
        const last = ai[ai.length - 1];
        const bubble = last.querySelector('.t-bubble');
        const meta = last.querySelector('.t-meta');
        const reply = bubble ? bubble.innerText : '';
        const metaText = meta ? meta.innerText.replace(/\\s+/g, ' ') : '';
        if (!metaText || !/点/.test(metaText) || reply === '（无回复）') return null;
        return { reply, meta: metaText };
      })()`);
      if (st) { got = st; break; }
    }
    rows.push({ text, reply: got ? got.reply : '(超时)', meta: got ? got.meta : '' });
    if ((i + 1) % 10 === 0) console.log(`  已跑 ${i + 1}/100`);
  }

  const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const md = [
    '# 桌面客户端 100 条随机问答',
    '',
    `> 种子 ${SEED} · ${new Date().toLocaleString('zh-CN', { hour12: false })} · 全程走客户端「测试会话」`,
    '',
    '| # | 买家 | 回复 | 标注 |',
    '|---|---|---|---|',
    ...rows.map((r, i) => `| ${i + 1} | ${cell(r.text)} | ${cell(r.reply)} | ${cell(r.meta)} |`),
  ];
  fs.writeFileSync(OUT, md.join('\n') + '\n');
  console.log('报告：' + OUT);
  cdp.close();
})().catch((e) => { console.error('执行失败：' + e.message); process.exitCode = 1; });
