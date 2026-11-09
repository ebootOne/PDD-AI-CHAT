'use strict';

/**
 * preload-cs.js —— 注入到店铺页面（隔离世界）里的采集与操作层
 *
 * 只做三件事：读会话、填输入框、点发送。
 * 所有业务判断都在渲染进程/本地服务，这里保持"笨"，页面改版时只改这个文件。
 */

const { ipcRenderer } = require('electron');

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
    messages.push({ role: isBuyer ? 'buyer' : 'seller', text });
  }

  const lastBuyer = [...messages].reverse().find((m) => m.role === 'buyer');
  const nameEl = document.querySelector('.chat-nickname .nickname-span');

  return {
    ok: true,
    source: 'pdd',
    messages: messages.slice(-14),
    lastBuyerText: lastBuyer ? lastBuyer.text : '',
    goodsTitle,
    goodsPrice,
    buyerName: nameEl ? nameEl.innerText.trim() : '',
    url: location.href,
  };
}

function pddInput() {
  return document.querySelector('#replyTextarea');
}

function capture() {
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

function fill(text) {
  const pdd = pddInput();
  if (pdd) {
    pdd.focus();
    setNativeValue(pdd, text);
    return { ok: true, source: 'pdd' };
  }
  const input = findInput();
  if (!input) return { ok: false, error: '没有找到输入框' };
  input.focus();
  setNativeValue(input, text);
  return { ok: true };
}

async function send() {
  const pdd = pddInput();
  if (pdd) {
    const btn = document.querySelector('.send-btn');
    const valOf = () => String(pdd.value || '').trim();
    if (btn) {
      btn.click();
      await sleep(600);
      if (!pdd.isConnected || !valOf()) return { ok: true, source: 'pdd' };
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
    if (msg.action === 'capture') data = capture();
    else if (msg.action === 'fill') data = fill(msg.payload && msg.payload.text);
    else if (msg.action === 'send') data = await send();
    else if (msg.action === 'clear') data = clearInput();
    else if (msg.action === 'sendProduct') data = await sendProductCard(msg.payload && msg.payload.goodsId);
    else data = { ok: false, error: '未知动作' };
    ipcRenderer.send('cs:result', { rid: msg.rid, data });
  } catch (err) {
    ipcRenderer.send('cs:result', { rid: msg.rid, error: String((err && err.message) || err) });
  }
});

// 轮询：页面是 SPA，MutationObserver 在切会话时容易丢，2 秒轮询最稳
let lastKey = '';
let lastSentAt = 0;
setInterval(() => {
  try {
    const cap = capture();
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
  }
}, 2000);
