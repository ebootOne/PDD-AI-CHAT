'use strict';

/**
 * capture-live-page.js —— 抓真实客服页结构（登录后运行）
 *
 * 只读取，不点击、不发送。产出：
 *   docs/screenshots/live-<ts>.png     页面截图
 *   data/live-structure-<ts>.json      结构摘要（选择器候选、计数、文本样例）
 *   data/live-masked-<ts>.html         脱敏后的 DOM（供定位选择器）
 *
 * 运行：node scripts/capture-live-page.js
 */

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.CDP_PORT || 9335);
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const DATA_DIR = path.join(__dirname, '..', 'data');
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /mms\.pinduoduo\.com/.test(t.url || ''));
  if (!page) {
    console.log('没有找到拼多多页面。当前页面：');
    list.filter((t) => t.type === 'page').forEach((t) => console.log(' -', t.url.slice(0, 90)));
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id);
      pending.delete(m.id);
      q(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result && r.result.value;
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(600);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotFile = path.join(OUT_DIR, `live-${ts}.png`);
  fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));

  const summary = await ev(`(() => {
    const vis = (el) => {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const txt = (el) => (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const out = { url: location.href, title: document.title, inputs: [], editors: [], candidates: {}, productHints: [], textSamples: [] };

    document.querySelectorAll('textarea, input, [contenteditable="true"], [contenteditable=""]').forEach((el) => {
      if (!vis(el)) return;
      out.inputs.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), ph: el.getAttribute('placeholder') || '', w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), top: Math.round(el.getBoundingClientRect().top) });
    });

    // 常见聊天容器关键词：按类名统计，找"重复次数多且垂直排列"的签名
    const groups = {};
    document.querySelectorAll('div,li,section,p').forEach((el) => {
      if (!vis(el)) return;
      const t = txt(el);
      if (!t || t.length > 200) return;
      const r = el.getBoundingClientRect();
      if (r.width > innerWidth * 0.9 || r.height > 300) return;
      const sig = el.tagName + '.' + [...el.classList].filter(Boolean).sort().join('.');
      if (!groups[sig]) groups[sig] = { sig, count: 0, sample: t.slice(0, 30) };
      groups[sig].count++;
    });
    out.candidates = Object.values(groups).filter((g) => g.count >= 3).sort((a, b) => b.count - a.count).slice(0, 15);

    // 商品卡线索
    const hints = ['商品详情页', '当前用户来自', '商品', '订单', '待支付'];
    hints.forEach((h) => {
      document.querySelectorAll('div,span').forEach((el) => {
        if (out.productHints.length > 40) return;
        const t = txt(el);
        if (t && t.length < 40 && t.includes(h) && vis(el)) out.productHints.push({ hint: h, text: t.slice(0, 40), cls: (el.className || '').toString().slice(0, 60) });
      });
    });

    out.textSamples = [...document.querySelectorAll('div,span')].filter((el) => vis(el) && txt(el).length > 4 && txt(el).length < 60).slice(0, 40).map((el) => txt(el));
    return out;
  })()`);

  fs.writeFileSync(path.join(DATA_DIR, `live-structure-${ts}.json`), JSON.stringify(summary, null, 2), 'utf8');

  const html = await ev('document.documentElement.outerHTML');
  if (typeof html === 'string') {
    const masked = html
      .replace(/1[3-9]\\d{9}/g, '1**********')
      .replace(/\\d{4}-\\d{2}-\\d{2}/g, '****-**-**');
    fs.writeFileSync(path.join(DATA_DIR, `live-masked-${ts}.html`), masked.slice(0, 2_000_000), 'utf8');
  }

  console.log('截图：' + shotFile);
  console.log('结构：' + path.join(DATA_DIR, `live-structure-${ts}.json`));
  console.log('HTML：' + path.join(DATA_DIR, `live-masked-${ts}.html`));
  console.log('\\n可见输入框：' + (summary.inputs || []).length);
  console.log('候选容器（重复签名）：');
  (summary.candidates || []).slice(0, 8).forEach((c) => console.log('  ' + c.count + '×  ' + c.sig.slice(0, 70) + '   e.g. ' + c.sample));
  console.log('商品线索：' + (summary.productHints || []).length + ' 条');
  (summary.productHints || []).slice(0, 6).forEach((h) => console.log('  [' + h.hint + '] ' + h.text));

  ws.close();
})().catch((e) => {
  console.error('抓取失败：', e.message);
  process.exit(1);
});
