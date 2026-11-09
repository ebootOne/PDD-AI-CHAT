'use strict';

/**
 * desktop-e2e.js —— 驱动真正的桌面客户端（Electron）跑一轮测试会话
 *
 * 不启动新实例：连接已经跑起来的客户端（默认 9335 调试端口），
 * 打开「测试会话」，以买家身份逐条发消息，读回面板里渲染的决策/来源/点数。
 *
 * 前置：客户端已带 --remote-debugging-port=9335 启动；本地服务 8787 在跑。
 * 运行：node scripts/desktop-e2e.js
 */

const fs = require('fs');
const path = require('path');

const CDP_PORT = Number(process.env.CDP_PORT || 9335);
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
  close() {
    try { this.ws.close(); } catch (_) { /* ignore */ }
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok || !detail ? '' : ' — ' + detail));
}

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && String(t.url).includes('/renderer/index.html'));
  if (!target) throw new Error('没找到客户端主窗口，确认 Electron 带 --remote-debugging-port 启动');
  console.log('已连接客户端：' + target.title);

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 打开测试会话，清成新会话
  await cdp.eval("document.getElementById('btnTest').click()");
  await sleep(400);
  await cdp.eval("(document.getElementById('tsNew')||{click(){}}).click()");
  await sleep(300);
  const modalOk = await cdp.eval("Boolean(document.getElementById('tsInput'))");
  check('桌面客户端打开「测试会话」', modalOk);

  const CASES = [
    '什么时候发货',
    '发什么快递',
    '菠菜多少钱',
    '再不发货我就退款',
    '你们卖假种子 我要投诉',
    '土壤pH多少合适',
  ];

  const turns = [];
  for (const text of CASES) {
    const before = await cdp.eval("document.querySelectorAll('#tsBody .turn.ai').length");
    await cdp.eval(`(() => {
      const i = document.getElementById('tsInput');
      i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('tsSend').click();
      return true;
    })()`);

    // 等这一轮渲染出来
    let got = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await cdp.eval(`(() => {
        const ai = document.querySelectorAll('#tsBody .turn.ai');
        if (ai.length <= ${before}) return null;
        const last = ai[ai.length - 1];
        const bubble = last.querySelector('.t-bubble');
        const meta = last.querySelector('.t-meta');
        const reply = bubble ? bubble.innerText : '';
        const metaText = meta ? meta.innerText.replace(/\\s+/g, ' ') : '';
        // 结果没回来时先渲染一条「（无回复）」，要等 meta 出来、且不是思考中
        if (!metaText || !/点/.test(metaText) || reply === '（无回复）') return null;
        return { reply, meta: metaText, turns: ai.length };
      })()`);
      if (st) { got = st; break; }
    }
    turns.push({ text, ...(got || {}) });
    check(`「${text}」有回复`, Boolean(got && got.reply), got ? got.reply.slice(0, 40) : '超时');
  }

  // 点数显示
  const quota = await cdp.eval("(document.getElementById('quotaVal')||{}).innerText || ''").catch(() => '');
  await cdp.shot('desktop-test-session.png');
  await sleep(200);

  console.log('\n客户端里看到的：');
  for (const t of turns) {
    console.log(`\n买家：${t.text}`);
    console.log(`回复：${(t.reply || '').slice(0, 80)}`);
    console.log(`标注：${t.meta || '-'}`);
  }
  console.log('\n点数显示：' + (quota || '(未读到)'));

  console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' 通过');
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  cdp.close();
})().catch((e) => {
  console.error('执行失败：' + e.message);
  process.exitCode = 1;
});
