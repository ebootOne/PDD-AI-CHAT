'use strict';

/**
 * preload-cs.js —— 注入到店铺页面（隔离世界）里的采集与操作层
 *
 * 只做三件事：读会话、填输入框、点发送。
 * 所有业务判断都在渲染进程/本地服务，这里保持"笨"，页面改版时只改这个文件。
 */

const { ipcRenderer } = require('electron');
const { parseOrderPanel } = require('./order-parse');

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
}

function textOf(el) {
  return el ? String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

function signature(el) {
  const cls = [...(el.classList || [])].filter(Boolean).sort().join('.');
  return el.tagName + (cls ? '.' + cls : '');
}

// ---------------------------------------------------------------- 定位

function findInput() {
  const raw = [...document.querySelectorAll('textarea, [contenteditable="true"], [contenteditable=""]')];
  const cands = raw.filter((el) => isVisible(el) && !el.disabled);
  if (!cands.length) return null;
  cands.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
  return cands[0];
}

function findSendButton(input) {
  const words = ['发送', '发送消息', '回复', '提交'];
  const base = input ? input.getBoundingClientRect() : { top: window.innerHeight, left: 0 };
  const scopes = [];
  if (input) {
    const d = input.closest('div');
    if (d && d.parentElement) scopes.push(d.parentElement);
  }
  scopes.push(document.body);

  const pick = (selector, strict) => {
    let best = null;
    let bestDist = Infinity;
    for (const scope of scopes) {
      for (const el of scope.querySelectorAll(selector)) {
        if (el === input || el.contains(input)) continue;
        if (el.querySelector('textarea, input, [contenteditable="true"]')) continue;
        if (strict && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') continue;
        const t = textOf(el);
        if (!t || t.length > 8) continue;
        if (!words.some((w) => t === w || t.endsWith(w))) continue;
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 200 || r.height > 80) continue;
        const dist = Math.abs(r.top - base.top) + Math.abs(r.left - base.left) * 0.15;
        if (dist < bestDist) {
          bestDist = dist;
          best = el;
        }
      }
    }
    return best;
  };

  return pick('button, [role="button"]', true) || pick('div, span, a', false);
}

function findChatColumn(input) {
  let el = input;
  for (let i = 0; i < 10 && el && el !== document.body; i++) {
    el = el.parentElement;
    if (!el) break;
    const r = el.getBoundingClientRect();
    if (r.height > Math.max(260, window.innerHeight * 0.35) && r.width > Math.max(280, window.innerWidth * 0.28)) {
      return el;
    }
  }
  return document.body;
}

function findMessageRows(col) {
  const colRect = col.getBoundingClientRect();
  const all = [...col.querySelectorAll('div, li, section, p, article')];
  const groups = new Map();

  for (const el of all) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 14) continue;
    if (r.height > colRect.height * 0.6) continue;
    if (r.width > colRect.width * 0.92) continue;
    if (!textOf(el)) continue;
    const sig = signature(el);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(el);
  }

  let best = [];
  let bestScore = 0;
  for (const [, list] of groups) {
    if (list.length < 3) continue;
    const tops = list.map((el) => Math.round(el.getBoundingClientRect().top));
    const uniqueTops = [...new Set(tops)];
    if (uniqueTops.length < 3) continue;
    const sorted = [...list].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const span = sorted[sorted.length - 1].getBoundingClientRect().bottom - sorted[0].getBoundingClientRect().top;
    const score = uniqueTops.length * Math.min(1, span / 200);
    if (score > bestScore) {
      bestScore = score;
      best = sorted;
    }
  }

  if (!best.length) {
    best = [...col.querySelectorAll('div')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return isVisible(el) && r.height > 14 && r.height < 160 && r.width > 24 && r.width < colRect.width * 0.85 && textOf(el);
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  }
  return best;
}

function guessByLabel(labelRe, { maxLen = 40, forbidTime = false, forbidMask = false } = {}) {
  const nodes = [...document.querySelectorAll('div, span, a, label, dt, th')].filter((el) => {
    const t = textOf(el);
    return t && t.length <= 6 && labelRe.test(t) && isVisible(el);
  });
  for (const n of nodes) {
    const sib = n.nextElementSibling;
    const t = sib ? textOf(sib) : '';
    if (!t || t.length < 2 || t.length > maxLen) continue;
    if (forbidTime && /\d{1,2}:\d{2}/.test(t)) continue;
    if (forbidMask && /\*\*/.test(t)) continue;
    return t;
  }
  return '';
}

// ---------------------------------------------------------------- 采集

let dismissedChatModal = false;

// ---------------------------------------------------------------- 拼多多真实页适配
// 结构来自 2026-11-07 真实页面取证（docs/25）
function isPddChat() {
  return /mms\.pinduoduo\.com$/.test(location.hostname) && !!document.querySelector('#replyTextarea, ul.msg-list');
}

function parseActionCards(rows) {
  const out = [];
  for (const row of rows) {
    const txt = (row.innerText || '').replace(/\s+/g, ' ').trim();
    if (/商家想帮您申请快捷退款|等待消费者确认/.test(txt)) {
      const card = row.querySelector('.stateful-double-column-card') || row;
      const goodsTitle = (card.querySelector('.good-content p') || {}).innerText || '';
      const amount = (card.querySelector('.good-content span') || {}).innerText || '';
      const rowsMap = {};
      for (const r of card.querySelectorAll('.col-row')) {
        const k = (r.querySelector('.row-name') || {}).innerText || '';
        const v = (r.querySelector('.row-content') || {}).innerText || '';
        if (k.trim()) rowsMap[k.trim()] = v.trim();
      }
      out.push({ kind: 'refund', goodsTitle: goodsTitle.trim(), amount: amount.trim(), type: rowsMap['申请类型'] || '', reason: rowsMap['申请原因'] || '', note: rowsMap['申请说明'] || '', status: /等待消费者确认/.test(txt) ? 'waiting_buyer' : /消费者已拒绝|已拒绝/.test(txt) ? 'refused' : /退款成功|已完成/.test(txt) ? 'done' : '', text: txt.slice(0, 300) });
    }
    if (/发起拼单/.test(txt) && row.querySelector('[class*="substitude_order"]')) {
      const q = (sel) => { const el = row.querySelector(sel); return el ? (el.innerText || '').trim() : ''; };
      out.push({
        kind: 'invite',
        goodsTitle: q('[class*="goods_name"]'),
        spec: q('[class*="spec___"]'),
        price: q('[class*="sku_price"]'),
        qty: q('[class*="goods_number"]'),
        total: q('[class*="total"]'),
        text: txt.slice(0, 300),
      });
    }
  }
  return out.slice(-6);
}

function pddCapture() {
  const list = document.querySelector('ul.msg-list');
  if (!list) return null;

  const rows = [...list.querySelectorAll('li.onemsg')];
  const messages = [];
  let goodsTitle = '';
  let goodsPrice = '';

  for (const row of rows) {
    // 商品卡（"当前用户来自 商品详情页"）
    const card = row.querySelector('.commonCard');
    if (card) {
      const p = card.querySelector('.good-content p');
      const sp = card.querySelector('.good-content span');
      if (p) goodsTitle = p.innerText.trim();
      if (sp) goodsPrice = sp.innerText.trim();
      continue;
    }
    // 系统提示
    if (row.querySelector('[class*="system-msg"]')) continue;

    const isBuyer = !!row.querySelector('.buyer-item');
    const box = row.querySelector('.msg-content-box') || row.querySelector('.msg-content');
    const text = box ? box.innerText.trim() : '';
    if (!text) continue;
    if (/消费者申请售后/.test(text) && /去处理/.test(text)) { messages.push({ role: 'system', text }); continue; }
    messages.push({ role: isBuyer ? 'buyer' : 'seller', text });
  }

  const lastBuyer = [...messages].reverse().find((m) => m.role === 'buyer');
  const nameEl = document.querySelector('.header-box .base-info-top .name')
    || document.querySelector('.header-box .base-info .name')
    || document.querySelector('.chat-nickname .nickname-span');

  const orderList = pddOrdersCapture();
  const firstOrder = orderList[0] || pddOrderCapture();
  return {
    ok: true,
    source: 'pdd',
    messages: messages.slice(-14),
    lastBuyerText: lastBuyer ? lastBuyer.text : '',
    goodsTitle,
    goodsPrice,
    buyerName: nameEl ? nameEl.innerText.trim() : '',
    order: firstOrder,
    orders: orderList.length ? orderList : (firstOrder && firstOrder.hasOrder ? [firstOrder] : []),
    actionCards: parseActionCards(rows),
    url: location.href,
  };
}

// 右侧订单面板（2026-11-09 真实页取证：.right-panel-container，含「最新订单/个人订单」）
// 只取白名单字段：状态/快递/运单号。收件人、电话、地址一律不取（docs/36 硬约束）。
function parseOrderCard(card) {
  if (!card) return null;
  const txt = card.innerText || card.textContent || '';
  const hintEl = card.querySelector('.order-status .title-status, .title-status');
  const hint = hintEl ? (hintEl.innerText || hintEl.textContent || '') : '';
  const parsed = parseOrderPanel(txt, hint);
  if (!parsed.hasOrder) return parsed;
  const names = [...card.querySelectorAll('.goods-name')].map((e) => (e.textContent || '').trim()).filter(Boolean);
  const specs = [...card.querySelectorAll('.goods-spec')].map((e) => (e.textContent || '').trim());
  const nums = [...card.querySelectorAll('.goods-num')].map((e) => (e.textContent || '').trim());
  const prices = [...card.querySelectorAll('.goods-price')].map((e) => (e.textContent || '').trim());
  parsed.items = names.map((title, i) => ({ title, spec: specs[i] || '', qty: nums[i] || '', price: prices[i] || '' }));
  const sn = card.querySelector('.order-sn');
  parsed.orderNo = sn ? (sn.textContent || '').trim() : '';
  const t = txt.match(/下单时间[:：]\s*([0-9/\- :]+)/);
  parsed.createdAt = t ? t[1].trim() : '';
  return parsed;
}

function pddOrdersCapture() {
  const panel = document.querySelector('.right-panel-container');
  if (!panel) return [];
  const cards = [...panel.querySelectorAll('.order-item')].slice(0, 5);
  return cards.map(parseOrderCard).filter((x) => x && x.hasOrder);
}

function pddOrderCapture() {
  const panel = document.querySelector('.right-panel-container');
  if (!panel) return null;
  const list = pddOrdersCapture();
  if (list.length) return list[0];
  const parsed = parseOrderPanel(panel.innerText || '', '');
  return parsed;
}

function pddInput() {
  return document.querySelector('#replyTextarea');
}

let lastOrderOpenAt = 0;
async function ensureOrderDetail() {
  const panel = document.querySelector('.right-panel-container');
  if (!panel) return;
  if (Date.now() - lastOrderOpenAt < 5000) return;
  let card = panel.querySelector('.order-item');
  if (!card) {
    const tab = [...panel.querySelectorAll('*')].find((e) => !e.children.length && (e.textContent || '').trim() === '个人订单');
    if (tab) { tab.click(); lastOrderOpenAt = Date.now(); await sleep(350); card = panel.querySelector('.order-item'); }
  }
  const cards = [...panel.querySelectorAll('.order-item')].slice(0, 3);
  for (const c of cards) {
    const txt = c.innerText || '';
    if (/(顺丰|中通|圆通|韵达|申通|极兔|邮政|EMS|京东快递|德邦)/.test(txt)) continue;
    const btns = [...c.querySelectorAll('*')]
      .filter((e) => (e.textContent || '').trim() === '物流信息' && e.getBoundingClientRect().width)
      .slice(0, 3);
    for (const btn of btns) { btn.click(); await sleep(180); }
  }
  if (cards.length) { lastOrderOpenAt = Date.now(); await sleep(250); }
}

async function capture() {
  if (/mms\.pinduoduo\.com\/login/.test(location.href)) {
    return {
      ok: false,
      code: 'auth_expired',
      error: '登录已过期',
      hint: '拼多多的登录态有时效，扫码一次就能回来',
    };
  }

  // 平台要求先过「新客服岗前培训考试」，没过之前不给开客服
  const bodyText = document.body ? document.body.innerText : '';
  if (/newCsExam/.test(location.href) || bodyText.includes('岗前培训考试') || bodyText.includes('岗位前培训')) {
    return {
      ok: false,
      code: 'cs_exam',
      error: '平台要求先完成「新客服岗前培训考试」',
      hint: '考试在拼多多商家后台进行，通过后客服会话才会开启',
    };
  }

  if (bodyText.includes('聊天未开启')) {
    if (!dismissedChatModal) {
      const btn = [...document.querySelectorAll('button, div, span, a')].find((el) => textOf(el) === '我知道了');
      if (btn) {
        btn.click();
        dismissedChatModal = true;
      }
    }
    return {
      ok: false,
      code: 'chat_disabled',
      error: '店铺还没有审核通过的商品，拼多多暂未开放客服会话',
      hint: '上架 1 个商品并通过审核后，客服会话会自动开启',
    };
  }

  if (isPddChat()) {
    await ensureOrderDetail();
    const pdd = pddCapture();
    if (pdd) return pdd;
  }

  const input = findInput();
  if (!input) return { ok: false, error: '没有找到聊天输入框' };

  const col = findChatColumn(input);
  const colRect = col.getBoundingClientRect();
  const centerX = colRect.left + colRect.width / 2;
  const rows = findMessageRows(col);

  const messages = [];
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    if (r.top < colRect.top - 20 || r.bottom > colRect.bottom + 20) continue;
    const text = textOf(row);
    if (!text || text.length > 500) continue;
    if (/^(发送|表情|图片|订单|商品|快捷回复)$/.test(text)) continue;
    const cx = r.left + r.width / 2;
    const role = cx < centerX - 8 ? 'buyer' : cx > centerX + 8 ? 'seller' : 'system';
    messages.push({ role, text, top: Math.round(r.top) });
  }

  const seen = new Set();
  const dedup = [];
  for (const m of messages) {
    const key = m.text.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(m);
  }

  const lastBuyer = [...dedup].reverse().find((m) => m.role === 'buyer');
  return {
    ok: true,
    messages: dedup.slice(-14).map(({ role, text }) => ({ role, text })),
    lastBuyerText: lastBuyer ? lastBuyer.text : '',
    buyerName: guessByLabel(/^(昵称|买家昵称|客户昵称|用户昵称)$/, { maxLen: 24 }),
    goodsTitle: guessByLabel(/^(商品|商品信息|商品名称|宝贝|拍下商品)$/, { maxLen: 40, forbidTime: true, forbidMask: true }),
    rows: dedup.length,
    order: null,
    url: location.href,
  };
}

// ---------------------------------------------------------------- 操作

function setNativeValue(el, value) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus();
    el.innerText = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
  }
}

function clearInput() {
  const pdd = pddInput();
  if (pdd) {
    setNativeValue(pdd, '');
    return { ok: true, source: 'pdd' };
  }
  const input = findInput();
  if (!input) return { ok: false, error: '没有输入框' };
  setNativeValue(input, '');
  return { ok: true };
}

async function fill(text) {
  const pdd = pddInput();
  if (pdd) {
    pdd.focus();
    // 先清空，让 React 收到空值；再用主进程真实输入，发送按钮才会进入可发送状态
    setNativeValue(pdd, '');
    const typed = await trustedType(text);
    if (!typed.ok || String(pdd.value || '') !== String(text || '')) setNativeValue(pdd, text);
    return { ok: true, source: 'pdd-trusted' };
  }
  const input = findInput();
  if (!input) return { ok: false, error: '没有找到输入框' };
  input.focus();
  setNativeValue(input, text);
  return { ok: true };
}

function trustedType(text) {
  return ipcRenderer.invoke('cs:trusted-type', String(text || '')).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}

function trustedEnter() {
  return new Promise((resolve) => {
    const rid = 'te' + Date.now() + Math.random().toString(36).slice(2, 6);
    const on = (_e, msg) => {
      if (!msg || msg.rid !== rid) return;
      ipcRenderer.removeListener('cs:trusted-result', on);
      resolve(msg);
    };
    ipcRenderer.on('cs:trusted-result', on);
    ipcRenderer.send('cs:trusted-enter', { rid });
    setTimeout(() => { ipcRenderer.removeListener('cs:trusted-result', on); resolve({ ok: false, error: 'trusted enter timeout' }); }, 2000);
  });
}

function trustedClick(x, y) {
  return new Promise((resolve) => {
    const rid = 'tc' + Date.now() + Math.random().toString(36).slice(2, 6);
    const on = (_e, msg) => {
      if (!msg || msg.rid !== rid) return;
      ipcRenderer.removeListener('cs:trusted-result', on);
      resolve(msg);
    };
    ipcRenderer.on('cs:trusted-result', on);
    ipcRenderer.send('cs:trusted-click', { rid, x, y });
    setTimeout(() => { ipcRenderer.removeListener('cs:trusted-result', on); resolve({ ok: false, error: 'trusted click timeout' }); }, 2000);
  });
}

async function send() {
  const pdd = pddInput();
  if (pdd) {
    const btn = document.querySelector('.send-btn');
    const valOf = () => String(pdd.value || '').trim();
    if (btn) {
      // 拼多多真正认的是可信 Enter；鼠标点击在程序化输入后不生效
      pdd.focus();
      await trustedEnter();
      for (let i = 0; i < 12; i++) {
        await sleep(200);
        if (!pdd.isConnected || !valOf()) return { ok: true, source: 'pdd-enter', waitedMs: (i + 1) * 200 };
      }
      // Enter 没发出去再补真实鼠标点击
      const r = btn.getBoundingClientRect();
      if (r.width && r.height) await trustedClick(r.x + r.width / 2, r.y + r.height / 2);
      for (let i = 0; i < 8; i++) {
        await sleep(200);
        if (!pdd.isConnected || !valOf()) return { ok: true, source: 'pdd-click', waitedMs: 2400 + (i + 1) * 200 };
      }
    }
    return { ok: false, error: '点了发送但输入框没清空' };
  }

  const input = findInput();
  if (!input) return { ok: false, error: '没有找到输入框' };
  const valOf = () => String(input.value != null ? input.value : input.innerText || '').trim();

  const btn = findSendButton(input);
  if (btn) {
    btn.click();
    await sleep(400);
    if (!input.isConnected || !valOf()) return { ok: true };
  }
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await sleep(400);
  return { ok: !input.isConnected || !valOf(), error: valOf() ? '点击发送后输入框未清空' : '' };
}

/**
 * 发商品卡片：点「商品」→ 在弹出的选择器里搜索 → 点中商品 → 页面自己发卡片。
 *
 * 关键点：搜索框必须锁定在「含商品项的那个弹层」里。
 * 页面左上角还有一个「搜索会话/订单号」的输入框，按 placeholder 找会打错地方。
 */
async function openRefundForm() {
  const icon = document.querySelector('.c-help-aftersale') || [...document.querySelectorAll('i,span,div')].find((x) => isVisible(x) && /帮消费者申请售后/.test(x.getAttribute('title') || ''));
  if (!icon) return { ok: false, error: '没找到「帮消费者申请售后」图标' };
  icon.click();
  await sleep(900);
  const dialog = [...document.querySelectorAll('.el-dialog')].find((x) => isVisible(x) && /帮消费者申请售后/.test(x.innerText || ''));
  if (!dialog) return { ok: false, error: '退款弹窗未打开' };
  const orders = [...dialog.querySelectorAll('button')].filter((b) => /^选择订单$/.test(textOf(b))).map((b) => {
    let row = b.parentElement;
    for (let i = 0; i < 5 && row; i++) {
      if ((row.innerText || '').includes('订单号')) break;
      row = row.parentElement;
    }
    const no = ((row && row.innerText) || '').match(/订单号[:：]\s*([0-9-]+)/);
    return { orderNo: no ? no[1] : '', text: (row && row.innerText || '').replace(/\s+/g, ' ').slice(0, 200) };
  }).filter((x) => x.orderNo);
  return { ok: true, step: 'orders', orders };
}

async function refundSelectOrder(orderNo) {
  const dialog = [...document.querySelectorAll('.el-dialog')].find((x) => isVisible(x) && /帮消费者申请售后/.test(x.innerText || ''));
  if (!dialog) return { ok: false, error: '退款弹窗未打开' };
  const b = [...dialog.querySelectorAll('button')].find((x) => /^选择订单$/.test(textOf(x)) && (() => {
    let row = x.parentElement;
    for (let i = 0; i < 5 && row; i++) { if ((row.innerText || '').includes(String(orderNo))) return true; row = row.parentElement; }
    return false;
  })());
  if (!b) return { ok: false, error: '没找到该订单的选择按钮' };
  b.click();
  await sleep(800);
  return { ok: true, step: 'form' };
}

function clickRadio(text) {
  const label = [...document.querySelectorAll('.el-radio')].find((x) => isVisible(x) && textOf(x) === text);
  if (!label) return false;
  const input = label.querySelector('input') || label;
  input.click();
  return true;
}

async function refundFill(input = {}) {
  const typeMap = { refund_only: '退款', return_refund: '退货退款', resend: '补寄' };
  const typeText = typeMap[input.type] || input.type || '退款';
  if (!clickRadio(typeText)) return { ok: false, error: '没找到申请类型：' + typeText };
  const hasReceiveGroup = [...document.querySelectorAll('.el-radio')].some((x) => isVisible(x) && /^(未收到货|已收到货)$/.test(textOf(x)));
  if (input.received === false && hasReceiveGroup && !clickRadio('未收到货')) return { ok: false, error: '没找到未收到货' };
  if (input.received === true && hasReceiveGroup && !clickRadio('已收到货')) return { ok: false, error: '没找到已收到货' };
  await sleep(200);
  const reasonInput = [...document.querySelectorAll('.el-dialog input')].find((x) => x.placeholder === '请选择退款原因');
  if (!reasonInput) return { ok: false, error: '没找到退款原因' };
  reasonInput.click();
  await sleep(300);
  const opt = [...document.querySelectorAll('.el-select-dropdown__item, .el-select-dropdown li')].find((x) => isVisible(x) && textOf(x) === String(input.reason || '不想要了'));
  if (!opt) return { ok: false, error: '没找到退款原因选项' };
  opt.click();
  await sleep(200);
  const amount = [...document.querySelectorAll('.el-dialog input[type=number]')].find((x) => x.offsetParent !== null);
  if (amount && input.amount != null) {
    setNativeValue(amount, String(input.amount));
  }
  const note = [...document.querySelectorAll('.el-dialog textarea')].find((x) => x.offsetParent !== null);
  if (note && input.note) setNativeValue(note, String(input.note));
  return { ok: true, step: 'filled', type: typeText, received: input.received, reason: input.reason, amount: amount ? amount.value : '', note: note ? note.value : '' };
}

async function refundSubmit() {
  const dialog = [...document.querySelectorAll('.el-dialog')].find((x) => isVisible(x) && /帮消费者申请售后/.test(x.innerText || ''));
  if (!dialog) return { ok: false, error: '退款弹窗未打开' };
  const b = [...dialog.querySelectorAll('button')].find((x) => /^提交$/.test(textOf(x)) && isVisible(x));
  if (!b) return { ok: false, error: '没找到提交按钮' };
  b.click();
  for (let i = 0; i < 15; i++) {
    await sleep(200);
    const still = [...document.querySelectorAll('.el-dialog')].find((x) => x.offsetParent !== null && /帮消费者申请售后/.test(x.innerText || ''));
    if (!still) return { ok: true, submitted: true };
    const err = [...still.querySelectorAll('.el-form-item__error,.el-message')].find((x) => isVisible(x));
    if (err) return { ok: false, error: textOf(err) || '表单校验失败' };
  }
  return { ok: false, error: '提交后弹窗未关闭，可能校验失败' };
}

async function openInvitePicker() {
  const tool = [...document.querySelectorAll('span,button,div,a')].find((el) => isVisible(el) && /^邀请下单$/.test(textOf(el)));
  if (!tool) return { ok: false, error: '没找到「邀请下单」' };
  tool.click();
  await sleep(700);
  const items = [...document.querySelectorAll('.goods-item')].filter(isVisible);
  if (!items.length) return { ok: false, error: '邀请下单商品列表未打开' };
  return { ok: true, items };
}

async function inviteCatalog() {
  const opened = await openInvitePicker();
  if (!opened.ok) return opened;
  const items = opened.items.map((el) => ({
    title: ((el.querySelector('.goods-name') || {}).innerText || '').trim(),
    price: ((el.querySelector('[class*=groupPrice],[class*=goods-price]') || {}).innerText || '').trim(),
  })).filter((x) => x.title);
  return { ok: true, items };
}

async function inviteDraft(title, spec) {
  const opened = await openInvitePicker();
  if (!opened.ok) return opened;
  const key = String(title || '').replace(/\s+/g, '');
  const item = opened.items.find((el) => {
    const t = ((el.querySelector('.goods-name') || {}).innerText || '').replace(/\s+/g, '');
    return t && (t.includes(key) || key.includes(t.slice(0, 8)));
  });
  if (!item) return { ok: false, error: '邀请列表没找到该商品' };
  const add = [...item.querySelectorAll('button,a,div,span')].find((x) => /^加入清单$/.test(textOf(x)));
  if (!add) return { ok: false, error: '没找到加入清单' };
  add.click();
  await sleep(600);
  const modal = [...document.querySelectorAll('.sku-select-modal')].find(isVisible);
  if (!modal) return { ok: false, error: 'SKU 弹窗未打开' };
  const groups = [...modal.querySelectorAll('.sku-group')];
  const chosen = [];
  for (const g of groups) {
    const name = ((g.querySelector('.sku-type-name') || {}).innerText || '').replace(/[:：]/g, '').trim();
    const opts = [...g.querySelectorAll('.sku-item')].filter(isVisible);
    if (!opts.length) continue;
    let pick = opts.find((o) => { const t = textOf(o); const q = String(spec || ''); return t && (q.includes(t) || t.includes(q)); });
    if (!pick && opts.length === 1) pick = opts[0];
    if (!pick) return { ok: false, error: '规格不唯一，需要买家确认：' + name, options: opts.map(textOf) };
    pick.click();
    await sleep(200);
    chosen.push({ name, value: textOf(pick) });
  }
  const okBtn = [...modal.querySelectorAll('button')].find((x) => /^确定$/.test(textOf(x)) && isVisible(x));
  if (!okBtn) return { ok: false, error: 'SKU 弹窗没有确定' };
  okBtn.click();
  await sleep(600);
  return { ok: true, chosen, sent: false };
}

async function sendInvite() {
  const bs = [...document.querySelectorAll('button')].filter((x) => isVisible(x) && /^发送$/.test(textOf(x)));
  for (const b of bs) {
    let p = b.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      if (/邀请下单的商品清单/.test(p.innerText || '')) {
        b.click();
        await sleep(800);
        return { ok: true, source: 'invite-modal' };
      }
      p = p.parentElement;
    }
  }
  return { ok: false, error: '没找到邀请清单的发送按钮' };
}

async function sendProductCard(goodsId) {
  const tool = [...document.querySelectorAll('span, button, div, a')].find(
    (el) => isVisible(el) && textOf(el) === '商品' && !el.querySelector('textarea') && !el.querySelector('input')
  );
  if (!tool) return { ok: false, error: '没找到「商品」按钮' };
  tool.click();
  await sleep(600);

  const visibleItems = () => [...document.querySelectorAll('[data-goods-id]')].filter(isVisible);
  if (!visibleItems().length) return { ok: false, error: '商品选择器没有打开' };

  // 从商品项往上找，直到某个祖先同时包含「可见输入框」——那就是这个弹层
  let popup = null;
  let search = null;
  for (const item of visibleItems()) {
    let p = item.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      const inp = [...p.querySelectorAll('input')].find((el) => isVisible(el));
      if (inp) {
        popup = p;
        search = inp;
        break;
      }
      p = p.parentElement;
    }
    if (popup) break;
  }
  if (!popup) return { ok: false, error: '没找到商品搜索框' };

  search.focus();
  setNativeValue(search, String(goodsId));
  await sleep(700);

  const items = [...popup.querySelectorAll('[data-goods-id]')].filter(isVisible);
  const target = items.find((el) => String(el.getAttribute('data-goods-id')) === String(goodsId)) || items[0];
  if (!target) return { ok: false, error: '没搜到该商品' };

  target.click();
  await sleep(600);

  // 清空搜索框，避免污染下一次
  if (search.isConnected) setNativeValue(search, '');
  return { ok: true };
}

// ---------------------------------------------------------------- 通道

ipcRenderer.on('cs:do', async (_e, msg) => {
  try {
    let data;
    if (msg.action === 'capture') data = await capture();
    else if (msg.action === 'fill') data = await fill(msg.payload && msg.payload.text);
    else if (msg.action === 'send') data = await send();
    else if (msg.action === 'clear') data = clearInput();
    else if (msg.action === 'sendProduct') data = await sendProductCard(msg.payload && msg.payload.goodsId);
    else if (msg.action === 'openRefund') data = await openRefundForm();
    else if (msg.action === 'refundSelect') data = await refundSelectOrder(msg.payload && msg.payload.orderNo);
    else if (msg.action === 'refundFill') data = await refundFill(msg.payload || {});
    else if (msg.action === 'refundSubmit') data = await refundSubmit();
    else if (msg.action === 'inviteCatalog') data = await inviteCatalog();
    else if (msg.action === 'inviteDraft') data = await inviteDraft(msg.payload && msg.payload.title, msg.payload && msg.payload.spec);
    else if (msg.action === 'sendInvite') data = await sendInvite();
    else data = { ok: false, error: '未知动作' };
    ipcRenderer.send('cs:result', { rid: msg.rid, data });
  } catch (err) {
    ipcRenderer.send('cs:result', { rid: msg.rid, error: String((err && err.message) || err) });
  }
});

// 轮询：页面是 SPA，MutationObserver 在切会话时容易丢，2 秒轮询最稳
let lastKey = '';
let lastSentAt = 0;
let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const cap = await capture();
    if (!cap.ok) {
      if (lastKey !== '__noinput__') {
        lastKey = '__noinput__';
        ipcRenderer.send('cs:changed', { ok: false, error: cap.error, url: location.href });
      }
      return;
    }
    const key = cap.lastBuyerText.slice(0, 60) + '|' + cap.messages.length;
    // 每 10 秒兜底重发一次：页面刷新后如果错过一次事件，面板也能自己恢复
    if (key === lastKey && Date.now() - lastSentAt < 10000) return;
    lastKey = key;
    lastSentAt = Date.now();
    ipcRenderer.send('cs:changed', cap);
  } catch (_) {
    /* 页面还没加载完 */
  } finally {
    polling = false;
  }
}, 2000);
