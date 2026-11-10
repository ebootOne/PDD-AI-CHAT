'use strict';

/**
 * app.js —— 渲染进程（工作台 UI）
 *
 * 职责：只管"显示什么、点什么"，不碰 DOM 采集（那在 preload-cs）、不碰模型（那在本地服务）。
 */

const B = window.bridge;

const state = {
  stores: [],
  activeId: null,
  capture: null,
  result: null,
  busy: false,
  auto: localStorage.getItem('autoReply') === '1',
  dryRun: localStorage.getItem('dryRun') === '1',
  devMode: localStorage.getItem('devMode') === '1',
  lastFilled: '',
  quota: null,
  health: false,
  stats: null,
  engine: 'standard', // standard | pro：以本地配置为准，界面只是开关
  lastAutoKey: '', // 自动模式：上一次自动生成的「会话+最后一句」，防止同一句反复扣点
  logView: 'current', // 回复日志：current=当前店铺 / all=所有店铺
  logScope: 'current', // 从日志加入模板：current=当前店铺 / global=整个工具
};

const $ = (s) => document.querySelector(s);
const stageEl = $('#stage');
const asBody = $('#asBody');

// ---------------------------------------------------------------- 工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 点数现在有小数（本地 0.5、模型下限 0.5，长回答按成本往上），显示到 3 位并去掉末尾 0
function fmtPts(n) {
  const v = Number(n) || 0;
  if (!v) return '0';
  return (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

async function api(path, method = 'GET', body) {
  const r = await B.api(path, method, body);
  if (!r || r.ok === false) throw new Error((r && r.error) || '本地服务无响应');
  return r.data;
}

// ---------------------------------------------------------------- 布局同步

function syncStageBounds() {
  const r = stageEl.getBoundingClientRect();
  B.view.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
}

new ResizeObserver(syncStageBounds).observe(stageEl);
window.addEventListener('resize', () => setTimeout(syncStageBounds, 60));

// ---------------------------------------------------------------- 店铺

async function loadStores() {
  const r = await B.stores.list();
  state.stores = r.stores || [];
  state.activeId = r.activeId;
  renderStores();
}

function renderStores() {
  $('#storeCount').textContent = state.stores.length;
  const list = $('#storeList');
  list.innerHTML = state.stores
    .map((s) => {
      const active = s.id === state.activeId;
      const initial = (s.name || '店').slice(0, 1);
      return `
      <div class="store-item ${active ? 'active' : ''}" data-id="${esc(s.id)}" title="${esc(s.url)}">
        <div class="store-avatar">${esc(initial)}</div>
        <div class="store-main">
          <div class="store-name">${esc(s.name)}</div>
          <div class="store-sub">${esc(shortUrl(s.url))}</div>
        </div>
        <button class="store-del" data-del="${esc(s.id)}" title="移除">×</button>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.store-item').forEach((el) => {
    el.addEventListener('click', async (e) => {
      if (e.target.closest('[data-del]')) return;
      const id = el.dataset.id;
      if (id === state.activeId) return;
      state.activeId = id;
      state.capture = null;
      state.result = null;
      renderStores();
      renderAssistant();
      await B.stores.switch(id);
    });
  });

  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      const s = state.stores.find((x) => x.id === id);
      if (!confirm(`移除店铺「${s ? s.name : id}」？\n（不会退出登录，重新添加即可恢复）`)) return;
      const r = await B.stores.remove(id);
      if (r.ok) {
        state.stores = r.stores;
        state.activeId = r.activeId;
        renderStores();
      }
    });
  });
}

function shortUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname + (url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : '');
  } catch (_) {
    return u || '';
  }
}

// ---------------------------------------------------------------- 助手面板

function renderAssistant() {
  $('#modeTag').textContent = (state.auto ? '自动模式' : '建议模式') + (state.engine === 'pro' ? ' · Pro' : '');
  $('#modeTag').classList.toggle('auto', state.auto);

  const cap = state.capture;
  const r = state.result;

  if (!cap) {
    asBody.innerHTML = `
      <div class="as-empty">
        <div class="as-empty-icon">💬</div>
        <div class="as-empty-t">等待买家消息</div>
        <div class="as-empty-s">${esc('选中左侧店铺，等买家发来消息后点「生成回复」')}</div>
      </div>`;
    return;
  }

  if (cap.ok === false) {
    if (cap.code === 'auth_expired') {
      asBody.innerHTML = `
        <div class="as-empty">
          <div class="as-empty-icon" style="background:#fff7ed;border-color:#fed7aa">🔑</div>
          <div class="as-empty-t">登录已过期</div>
          <div class="as-empty-s">拼多多的登录态有时效，长时间无操作会失效。<br>扫码一次就回来了。</div>
          <button class="btn-primary" id="btnRelogin2" style="margin-top:12px;width:180px">扫码重新登录</button>
        </div>`;
      const rb = $('#btnRelogin2');
      if (rb) rb.addEventListener('click', () => { B.auth.relogin(); toast('请用拼多多商家版扫码'); });
      return;
    }
    if (cap.code === 'cs_exam') {
      asBody.innerHTML = `
        <div class="as-empty">
          <div class="as-empty-icon" style="background:#fff7ed;border-color:#fed7aa">📝</div>
          <div class="as-empty-t">差一步：岗前培训考试</div>
          <div class="as-empty-s">${esc(cap.error || '')}<br>${esc(cap.hint || '')}</div>
        </div>`;
      return;
    }
    if (cap.code === 'chat_disabled') {
      asBody.innerHTML = `
        <div class="as-empty">
          <div class="as-empty-icon" style="background:#fff7ed;border-color:#fed7aa">🔒</div>
          <div class="as-empty-t">客服会话还没开启</div>
          <div class="as-empty-s">${esc(cap.error || '')}<br>${esc(cap.hint || '')}</div>
        </div>`;
      return;
    }
    asBody.innerHTML = `
      <div class="as-empty">
        <div class="as-empty-icon" style="background:#fef1f1;border-color:#ffd9d9">!</div>
        <div class="as-empty-t">没找到聊天区</div>
        <div class="as-empty-s">${esc(cap.error || '页面结构可能变了')}<br>请确认已进入客服会话页</div>
      </div>`;
    return;
  }

  let html = '';

  html += `<div class="quote-card">
      <div class="quote-label">买家最后一句</div>
      <div class="quote-text">${esc((cap.lastBuyerText || '（还没读到买家消息）').slice(0, 200))}</div>
    </div>`;

  const chips = [];
  chips.push(`<span class="chip">识别 ${cap.messages ? cap.messages.length : 0} 条</span>`);
  if (cap.goodsTitle) chips.push(`<span class="chip blue">${esc(cap.goodsTitle.slice(0, 12))}</span>`);
  if (r && r.manual && r.manual.title) chips.push(`<span class="chip blue">说明书 · ${esc(r.manual.title)}</span>`);
  if (r && r.tierName) chips.push(`<span class="chip blue">${esc(r.tierName)}语气</span>`);
  if (r) chips.push(`<span class="chip ${r.decision === 'auto_send' ? 'ok' : 'warn'}">${decisionText(r.decision)}</span>`);
  html += `<div class="chips">${chips.join('')}</div>`;

  if (!r) {
    html += `<div class="as-empty" style="height:auto;padding:34px 0 20px">
        <div class="as-empty-s">点下方「生成回复」，AI 会给出 3 条可直接发送的候选</div>
      </div>`;
    asBody.innerHTML = html;
    return;
  }

  if (r.knowledgeGap) {
    html += `<div style="border:1px solid #fde68a;background:#fffbeb;border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;color:#92400e;display:flex;gap:8px;align-items:center">
      <span style="flex:1">这条还没有模板，先用了「以实际为准」的口径。补一条模板，下次同类问题直接答——不用兜底，也更省点。</span>
      <button class="btn-line ghost" id="gapAdd" style="height:26px;padding:0 10px;font-size:12px">补一条模板</button>
    </div>`;
  }

  const cost = fmtPts(r.cost) + ' 点';
  const src = r.source === 'llm' ? '模型' : r.source === 'rule' ? '本地知识' : (r.source || '—');
  html += `<div class="meta-line">
      意图 <b>${esc(r.intent)}</b> · 置信度 <b>${r.confidence != null ? r.confidence : '—'}</b> · 来源 <b>${src}</b> · 消耗 <b>${cost}</b> · ${r.latencyMs}ms
      ${r.reason ? '<br>' + esc(r.reason) : ''}
    </div>`;

  if (r.products && r.products.length) {
    html += `<div class="prod-hit">
      <div class="prod-hit-t">匹配到 ${r.products.length} 个商品</div>
      ${r.products.slice(0, 3).map((p) => `<div class="prod-row"><span>${esc(p.title)}</span><b>¥${esc(p.price)}</b><i class="${Number(p.stock) > 0 ? 'ok' : 'no'}">${Number(p.stock) > 0 ? '有货' : '缺货'}</i><button class="prod-send" data-goods="${esc(p.goodsId)}">发卡片</button></div>`).join('')}
    </div>`;
  }

  if (r.decision === 'fallback') {
    const lp = fmtPts(state.localPoints != null ? state.localPoints : 0.5);
    html += `<div class="fallback-tip">这条用的是兜底话术，已按 ${lp} 点计费。补一条模板，下次同类问题直接答，不用兜底。${r.alert === 'high' ? ' 已标记为高优先级，请尽快人工接手。' : ''}
      <button class="btn-line ghost" id="fallbackAdd" style="height:24px;padding:0 8px;font-size:11px;margin-left:8px">补一条模板</button></div>`;
  }

  if (r.risks && r.risks.length) {
    html += `<div class="chip warn" style="margin-bottom:10px">风险：${esc(r.risks.join('、'))}</div>`;
  }

  if (r.suggestions && r.suggestions.length) {
    r.suggestions.forEach((s, i) => {
      html += `
      <div class="card ${i === 0 ? 'reco' : ''}">
        <div class="card-top">
          <span class="tone ${i === 0 ? 'reco' : ''}">${esc(s.tone)}${i === 0 ? ' · 推荐' : ''}</span>
          <span class="card-idx">${i + 1}/${r.suggestions.length}</span>
        </div>
        <div class="card-text">${esc(s.text)}</div>
        <div class="card-actions">
          <button class="btn-fill" data-act="fill" data-idx="${i}">填入输入框</button>
          <button class="btn-send" data-act="send" data-idx="${i}">填入并发送</button>
        </div>
      </div>`;
    });

    if (r.knowledge && r.knowledge.length) {
      html += `<details class="ground"><summary>依据 · ${r.knowledge.length} 条知识</summary><ul>`;
      for (const k of r.knowledge) {
        html += `<li>${esc(k.title)} · ${k.score} 分 · ${esc((k.reasons || []).slice(0, 3).join(' / '))}</li>`;
      }
      html += `</ul></details>`;
    }
  } else {
    html += `<div class="as-empty" style="height:auto;padding:30px 0">
        <div class="as-empty-t" style="font-size:12.5px">${esc(r.reason || '没有可用候选')}</div>
        <div class="as-empty-s">建议在店铺页面直接人工处理</div>
      </div>`;
  }

  asBody.innerHTML = html;

  const gapAdd = document.getElementById('gapAdd');
  if (gapAdd) gapAdd.addEventListener('click', () => openWorkbench('kb'));
  const fallbackAdd = document.getElementById('fallbackAdd');
  if (fallbackAdd) fallbackAdd.addEventListener('click', () => openWorkbench('kb'));

  asBody.querySelectorAll('button[data-goods]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const gid = btn.dataset.goods;
      btn.disabled = true;
      btn.textContent = '发送中…';
      const r = await B.page.sendProduct(gid);
      if (r && r.ok) toast('商品卡片已发送');
      else toast('发卡片失败：' + ((r && r.error) || '未知'));
      btn.disabled = false;
      btn.textContent = '发卡片';
    });
  });

  asBody.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const s = state.result.suggestions[Number(btn.dataset.idx)];
      if (!s) return;
      if (btn.dataset.act === 'fill') await doFill(s.text);
      else await doSend(s.text);
    });
  });
}

function decisionText(d) {
  return { auto_send: '可自动发送', suggest: '需人工确认', fallback: '兜底回复', handoff: '转人工' }[d] || d || '';
}

// ---------------------------------------------------------------- 动作

function capKey(cap) {
  return [cap && cap.url, cap && cap.buyerName, cap && cap.lastBuyerText].join('|');
}

async function generate(isAuto = false) {
  if (state.busy) return;
  state.busy = true;
  const btn = $('#btnGen');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spark">✦</span> 生成中…';

  try {
    const cap = await B.page.capture();
    if (!cap || !cap.ok) {
      state.capture = cap || { ok: false, error: '读取页面失败' };
      state.result = null;
      renderAssistant();
      return;
    }
    state.capture = cap;
    // 手动点「生成」也算这句已处理，避免自动监控紧接着再生成一遍、再扣一次点
    state.lastAutoKey = capKey(cap);
    state.result = null;
    renderAssistant();

    // 稳定会话 id：店铺 + 页面会话标识（URL），不再拿买家昵称当 id
    let h = 0;
    const ck = String(cap.url || cap.buyerName || '');
    for (let i = 0; i < ck.length; i++) h = (h * 31 + ck.charCodeAt(i)) | 0;
    const convKey = Math.abs(h).toString(36);
    const ctx = {
      storeId: state.activeId,
      storeName: (state.stores.find((s) => s.id === state.activeId) || {}).name || '店铺',
      storeId: state.activeId || '',
      conversationId: (state.activeId || 'store') + ':' + convKey,
      buyerName: cap.buyerName || '',
      goods: { title: cap.goodsTitle || '', goodsId: '', spec: '' },
      order: cap.order || null,
      messages: cap.messages || [],
      mode: state.auto ? 'auto' : 'suggest',
      engine: state.engine,
      requestId: (crypto.randomUUID && crypto.randomUUID()) || 'r' + Date.now(),
    };

    const result = await api('/api/reply', 'POST', ctx);
    state.result = result;
    if (result.quota) state.quota = { balance: result.quota.balance };
    renderAssistant();
    refreshStatus();

    if (isAuto && !result.deduped && result.decision === 'auto_send' && result.suggestions && result.suggestions[0]) {
      if (state.dryRun) {
        // 演练模式不自动填：否则每条新消息都会在输入框里留一份草稿
        toast('演练模式：已生成候选，请手动点「填入」');
      } else {
        await sleep(1200 + Math.random() * 1800);
        await doSend(result.suggestions[0].text, true);
      }
    }
  } catch (e) {
    toast('生成失败：' + e.message);
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-spark">✦</span> 生成回复';
  }
}

async function doFill(text) {
  const r = await B.page.fill(text);
  if (r && r.ok) {
    state.lastFilled = text;
    toast('已填入输入框');
  } else toast('填入失败：' + ((r && r.error) || '未知'));
}

async function doSend(text, auto) {
  const filled = await B.page.fill(text);
  if (!filled || !filled.ok) return toast('填入失败，未发送');
  state.lastFilled = text;

  // 演练模式：只填不发。真实店铺第一次联调必须开着它。
  if (state.dryRun) {
    toast('演练模式：已填入输入框，未发送');
    B.api('/api/log', 'POST', { type: 'dryrun', mode: auto ? 'auto' : 'manual', replyText: text, conversationId: state.activeId }).catch(() => {});
    return;
  }

  await sleep(300 + Math.random() * 300);
  const sent = await B.page.send();
  if (sent && sent.ok) {
    toast(auto ? '已自动发送' : '已发送');
    B.api('/api/log', 'POST', {
      type: 'send',
      mode: auto ? 'auto' : 'manual',
      replyText: text,
      conversationId: state.activeId,
    }).catch(() => {});
    refreshStatus();
  } else {
    toast('没发出去：' + ((sent && sent.error) || '输入框未清空，请手动回车'));
  }
  setTimeout(renderAssistant, 600);
}

// ---------------------------------------------------------------- 事件

B.on('cs:changed', (cap) => {
  if (cap && cap.url && !cap.url.startsWith('http')) return;

  // 换会话/来新消息时，把自己上一轮填进去的草稿清掉（拼多多会保留草稿）
  const prevBuyer = state.capture && state.capture.lastBuyerText;
  if (cap && cap.ok && cap.lastBuyerText && cap.lastBuyerText !== prevBuyer) {
    if (state.lastFilled) {
      B.page.clear().catch(() => {});
      state.lastFilled = '';
    }
  }

  state.capture = cap;
  if (!state.busy) renderAssistant();

  const lastMsg = cap && Array.isArray(cap.messages) ? cap.messages[cap.messages.length - 1] : null;
  // 只有「最后一条是买家」才自动生成：最后一条是客服（刚回过/手动回过）就不该再答一遍
  if (state.auto && !state.busy && cap && cap.ok && cap.lastBuyerText && lastMsg && lastMsg.role === 'buyer') {
    // 演练模式不会把回复发出去，买家那句还是「未答」；如果只看「有没有新消息」，
    // 监控会每秒都认为有新消息，于是反复生成、反复扣点（2026-11-09 日志刷屏的原因）。
    const key = capKey(cap);
    if (key !== state.lastAutoKey) {
      state.lastAutoKey = key;
      generate(true);
    }
  }
});

B.on('auth:expired', (p) => {
  if (p && p.storeId && p.storeId !== state.activeId) return;
  const body = $('#asBody');
  if (!body) return;
  body.innerHTML = `
    <div class="as-empty">
      <div class="as-empty-icon" style="background:#fff7ed;border-color:#fed7aa">🔑</div>
      <div class="as-empty-t">登录已过期</div>
      <div class="as-empty-s">拼多多的登录态有时效，长时间无操作会失效。<br>点下面按钮，扫码一次就回来了。</div>
      <button class="btn-primary" id="btnRelogin" style="margin-top:12px;width:180px">扫码重新登录</button>
    </div>`;
  const b = $('#btnRelogin');
  if (b) b.addEventListener('click', () => { B.auth.relogin(); toast('请用拼多多商家版扫码'); });
});

B.on('stores:changed', () => {
  loadStores().catch(() => {});
});

B.on('sync:stale', () => {
  const el = $('#stSync');
  if (el) el.textContent = '商品数据已过期，正在补同步…';
  setTimeout(() => { if (el && /过期/.test(el.textContent)) el.textContent = ''; }, 60000);
});

B.on('sync:status', (st) => {
  const el = $('#stSync');
  if (!el) return;
  if (!st || st.status === 'running') el.textContent = '商品同步中…';
  else if (st.status === 'ok') el.textContent = '商品已同步 ' + (st.count || '') + ' 件';
  else if (st.status === 'anomaly') el.textContent = '商品同步异常，已保留旧数据';
  else if (st.status === 'empty') el.textContent = '商品同步：没抓到商品';
  else if (st.status === 'failed') el.textContent = '商品同步失败';
  else if (st.status === 'unverified') el.textContent = '商品同步未校验通过，请重试';
  setTimeout(() => { if (el) el.textContent = ''; }, 8000);
});

B.on('store:active', (s) => {
  $('#stStore').textContent = s.name || s.url;
  state.capture = null;
  state.lastAutoKey = '';
  state.result = null;
  renderAssistant();
});

$('#btnGen').addEventListener('click', () => generate(false));
const clearBtn = $('#btnClearDraft');
if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    await B.page.clear().catch(() => {});
    state.lastFilled = '';
    toast('已清空输入框');
  });
}

$('#autoToggle').checked = state.auto;
$('#dryToggle').checked = state.dryRun;
const wakeEl = $('#wakeToggle');
if (wakeEl) {
  B.power.state().then((st) => { wakeEl.checked = Boolean(st && st.keepAwake); }).catch(() => {});
  wakeEl.addEventListener('change', async (e) => {
    const r = await B.power.setKeepAwake(e.target.checked).catch(() => null);
    toast(e.target.checked ? '已开启保持唤醒：不会息屏休眠' : '已关闭保持唤醒：按系统设置休眠');
    if (r && !r.on && e.target.checked) wakeEl.checked = false;
  });
}

$('#dryToggle').addEventListener('change', (e) => {
  state.dryRun = e.target.checked;
  localStorage.setItem('dryRun', state.dryRun ? '1' : '0');
  toast(state.dryRun ? '演练模式已开：只填输入框，不会点发送' : '演练模式已关：会真的发送');
});

$('#autoToggle').addEventListener('change', (e) => {
  state.auto = e.target.checked;
  localStorage.setItem('autoReply', state.auto ? '1' : '0');
  renderAssistant();
  toast(state.auto ? '自动回复已开启：新消息将按规则自动发送' : '自动回复已关闭：只给建议，需人工点发送');
});

// ---------------------------------------------------------------- 回复引擎（普通 / Pro）

function applyEngineUI() {
  const pro = state.engine === 'pro';
  const t = $('#proToggle');
  if (t) t.checked = pro;
  const hint = $('#proHint');
  if (hint) {
    hint.textContent = pro
      ? '模型优先：长尾、多问题答得更全；慢 1~2 秒，每条 0.5 点起'
      : '本地知识秒回：价格、发货、退换这类有标准答案的问题';
  }
  renderAssistant();
}

async function loadEngine() {
  try {
    const cfg = await api('/api/config');
    state.engine = cfg.engine === 'pro' ? 'pro' : 'standard';
    state.localPoints = Number(cfg.billing && cfg.billing.localPoints);
    if (!Number.isFinite(state.localPoints)) state.localPoints = 0.5;
  } catch (_) {
    state.engine = 'standard';
  }
  applyEngineUI();
}

$('#proHelp').addEventListener('click', openProHelp);

$('#proToggle').addEventListener('change', async (e) => {
  const want = e.target.checked ? 'pro' : 'standard';
  e.target.disabled = true;
  try {
    const r = await api('/api/config', 'POST', { engine: want });
    state.engine = r.config && r.config.engine === 'pro' ? 'pro' : want;
    toast(want === 'pro' ? '已切到专业版：回复会走模型，慢 1~2 秒' : '已切到普通版：本地知识秒回');
  } catch (err) {
    toast('切换失败：' + err.message);
    e.target.checked = state.engine === 'pro';
  } finally {
    e.target.disabled = false;
    applyEngineUI();
  }
});

function openProHelp() {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">普通版 / 专业版，怎么选？</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <table class="pro-table">
        <thead><tr><th></th><th>普通版</th><th>专业版 Pro</th></tr></thead>
        <tbody>
          <tr><td>速度</td><td>毫秒级</td><td>1~2 秒</td></tr>
          <tr><td>怎么答</td><td>命中本地知识就直接答</td><td>本地没直接命中时，把这一单的事实交给模型组织</td></tr>
          <tr><td>擅长</td><td>价格、库存、发货、退换、发票</td><td>一句话问好几件事、问法绕、说明书细节</td></tr>
          <tr><td>计费</td><td colspan="2">本地模板 0.5 点/条；专业版按实际消耗扣点，一条通常 0.5~0.7 点，答得越复杂扣得越多；没生成出来不扣。</td></tr>
        </tbody>
      </table>
      <div class="pro-note">
        专业版不会改变「建议 / 自动」模式；承诺、敏感词、质检对两种版本一样生效。<br>
        点数有小数，账单里按 3 位显示；模型那条贵多少由回答长度和输入量决定。<br>批量秒回、只问价格库存时用普通版更划算；长问题、多问题再开专业版。
      </div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button class="btn-line primary" data-close>知道了</button>
      </div>
    </div>`);
  $('#modal').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
}

$('#btnAddStore').addEventListener('click', openAddStore);
$('#btnWorkbench').addEventListener('click', () => openWorkbench('kb'));

async function refreshOnboard() {
  try {
    const d = await api('/api/kb/suggestions');
    const imp = (d && d.important) || { done: 0, total: 0 };
    const el = document.getElementById('obCount');
    if (el) el.textContent = imp.total ? imp.done + '/' + imp.total : '—';
    const btn = document.getElementById('btnOnboard');
    if (btn) {
      btn.title = !imp.total
        ? '模板库已清空，按需新建知识'
        : imp.done >= imp.total
          ? '开店清单已完成'
          : '开店清单：还差 ' + (imp.total - imp.done) + ' 条';
    }
  } catch (_) { /* 离线忽略 */ }
}
$('#btnOnboard').addEventListener('click', () => openWorkbench('kb'));
$('#btnTest').addEventListener('click', openTestSession);
$('#btnAssets').addEventListener('click', openStoreAssets);

$('#winMin').addEventListener('click', () => B.win.min());
$('#winMax').addEventListener('click', () => B.win.max());
$('#winClose').addEventListener('click', () => B.win.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate(false);
});

// ---------------------------------------------------------------- 弹层

function openModal(html) {
  B.view.setVisible(false);
  $('#modal').innerHTML = html;
  $('#modalMask').classList.add('show');
  $('#modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeModal();
  });
}

function closeModal() {
  // 有关着的二级弹层时，先关它
  if ($('#modalMask2').classList.contains('show')) return closeSubModal();
  $('#modalMask').classList.remove('show');
  $('#modal').innerHTML = '';
  B.view.setVisible(true);
}

function openSubModal(html) {
  $('#modal2').innerHTML = html;
  $('#modalMask2').classList.add('show');
  $('#modalMask2').onclick = (e) => {
    if (e.target.id === 'modalMask2') closeSubModal();
  };
}

function closeSubModal() {
  $('#modalMask2').classList.remove('show');
  $('#modal2').innerHTML = '';
  setTimeout(() => $('#modal2') && $('#modal2').offsetParent && false, 0);
}

function openAddStore() {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">添加店铺</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div class="form-card">
        <div class="field"><label>店铺名称</label><input class="input" id="nsName" placeholder="例：磐叶种子店"></div>
        <div class="field"><label>客服页地址</label>
          <input class="input" id="nsUrl" value="https://mms.pinduoduo.com/chat-merchant/index.html#">
          <div style="font-size:11px;color:#8b95a5;margin-top:6px;line-height:1.6">
            每个店铺使用独立的浏览器会话，登录态互不干扰。<br>
            本地联调可用：http://127.0.0.1:8787/mock/chat.html
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn-line primary" id="nsOk">添加并打开</button>
          <button class="btn-line ghost" data-close>取消</button>
        </div>
      </div>
    </div>`);

  $('#modal').querySelector('[data-close]').addEventListener('click', closeModal);
  $('#nsOk').addEventListener('click', async () => {
    const name = $('#nsName').value.trim() || '新店铺';
    const url = $('#nsUrl').value.trim();
    const r = await B.stores.add({ name, url });
    if (!r.ok) return toast(r.error || '添加失败');
    state.stores = r.stores;
    state.activeId = r.activeId;
    renderStores();
    closeModal();
    toast('已添加，等待页面加载…');

    // 新店：先决定知识库从哪儿来，别让它继承到别的店的快递/发货口径
    const others = state.stores.filter((x) => x.id !== r.activeId);
    if (others.length) setTimeout(() => askCopyKnowledge(r.activeId, others), 400);
  });
}

// 一次性把最常问的四条模板填完：快递 / 截单 / 包邮 / 破损
function openFillAll() {
  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">一次填完，这四类问题就能答了</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div style="font-size:12.5px;color:#64748b;line-height:1.7;margin-bottom:12px">
        只填你店铺真实的情况，填完立即生效。空着的项保持「待填写」，不会发出去。
      </div>
      <div class="field"><label>发什么快递（主快递）</label><input class="input" id="faMain" placeholder="中通"></div>
      <div class="field"><label>偏远地区发什么（可不填）</label><input class="input" id="faBackup" placeholder="邮政"></div>
      <div class="field"><label>每天几点截单</label><input class="input" id="faCut" placeholder="16:00"></div>
      <div class="field"><label>包邮范围（可不填）</label><input class="input" id="faFree" placeholder="除新疆西藏内蒙古外全国"></div>
      <div class="field"><label>收到破损怎么处理（可不填）</label>
        <input class="input" id="faDamage" placeholder="拍照发我，核实后按售后规则处理"></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn-line primary" id="faSave">保存并启用</button>
        <button class="btn-line ghost" data-close>取消</button>
      </div>
    </div>`);

  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSubModal));
  $('#faSave').addEventListener('click', async () => {
    const main = $('#faMain').value.trim();
    const backup = $('#faBackup').value.trim();
    const cut = $('#faCut').value.trim();
    const free = $('#faFree').value.trim();
    const damage = $('#faDamage').value.trim();
    if (!main && !cut && !free && !damage) return toast('至少填一项');

    const all = (await api('/api/knowledge?storeId=' + encodeURIComponent(state.activeId || ''))).items || [];
    const byTpl = new Map(all.filter((k) => k.templateId).map((k) => [k.templateId, k]));
    const updates = [];

    if (main) {
      const k = byTpl.get('tpl-courier-default');
      if (k) updates.push({ ...k, answer: `默认发${main}${backup ? '，偏远地区发' + backup : ''}。如需指定快递请备注，能否满足以发货为准。`, enabled: true, needsConfirm: false });
    }
    if (cut) {
      const k = byTpl.get('tpl-ship-cutoff');
      if (k) updates.push({ ...k, answer: `当天${cut}前付款的订单当天发出，之后的顺延到第二天。`, enabled: true, needsConfirm: false });
    }
    if (free) {
      const k = byTpl.get('tpl-freight-free');
      if (k) updates.push({ ...k, answer: `${free}包邮，超出范围按实际运费补。`, enabled: true, needsConfirm: false });
    }
    if (damage) {
      const k = byTpl.get('tpl-after-damage');
      if (k) updates.push({ ...k, answer: damage, enabled: true, needsConfirm: false });
    }

    let ok = 0;
    for (const it of updates) {
      try {
        await api('/api/knowledge', 'POST', { item: it, storeId: state.activeId || '' });
        ok++;
      } catch (_) {}
    }
    closeSubModal();
    toast(`已启用 ${ok} 条，这些类型现在能答了`);
    renderWorkbench('kb');
  });
}

// 命中自测结果：告诉商家这条能不能被检索到，以及怎么改
function showProbeResult(probe, onSaveAnyway) {
  const rows = (probe.probes || []).map((p) => `
    <div class="probe-row">
      <span class="probe-q">${esc(p.q)}</span>
      <span class="probe-tag ${p.rank === 1 ? 'ok' : p.hit ? 'mid' : 'bad'}">${p.rank === 1 ? '命中第一' : p.hit ? '排第 ' + p.rank : '没命中'}</span>
      ${p.rival ? `<span class="probe-rival">被「${esc(p.rival)}」压住</span>` : ''}
    </div>`).join('');
  const advice = (probe.advice || []).map((a) => `<li>${esc(a)}</li>`).join('');
  const suggests = probe.suggestKeywords || [];
  const suggestHtml = suggests.length ? `
      <div class="probe-suggest">
        <div class="probe-suggest-h">这些是买家真实说过的、而且用了能命中的说法，点一下加进关键词：</div>
        <div class="probe-chips">
          ${suggests.map((x) => `<button class="probe-chip" data-kw="${esc(x.text)}">+ ${esc(x.text)}${x.count > 1 ? ' ×' + x.count : ''}</button>`).join('')}
        </div>
      </div>` : '';
  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">这条可能答不上来</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div style="font-size:12.5px;color:#64748b;line-height:1.7;margin-bottom:10px">
        用这条自己的标题和关键词问了一遍，结果如下。改完关键词再保存，命中率会高很多。
      </div>
      ${rows}
      ${advice ? `<div class="probe-advice"><b>建议</b><ul>${advice}</ul></div>` : ''}
      ${suggestHtml}
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn-line primary" id="probeBack">回去改关键词</button>
        <button class="btn-line ghost" id="probeSave">仍然保存</button>
      </div>
    </div>`);
  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSubModal));
  $('#modal2').querySelectorAll('[data-kw]').forEach((b) => {
    b.addEventListener('click', () => {
      const el = document.getElementById('kKw');
      if (!el) return;
      const cur = el.value.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
      const kw = b.dataset.kw;
      if (!cur.includes(kw)) cur.push(kw);
      el.value = cur.join('，');
      b.disabled = true;
      b.textContent = '已加入 ✓';
      toast('已加入关键词，关掉后点保存会再自测一次');
    });
  });

  $('#probeBack').addEventListener('click', closeSubModal);
  $('#probeSave').addEventListener('click', async () => {
    closeSubModal();
    await onSaveAnyway();
  });
}

// 模板库：20 条标准模板，点一下加入「待填写」，填好【】再启用
async function openTemplateLib() {
  const storeId = state.activeId || '';
  let tpls = [];
  try {
    tpls = (await api('/api/templates')).items || [];
  } catch (_) {
    return toast('模板库读取失败');
  }
  let kb = [];
  try {
    kb = (await api('/api/knowledge?storeId=' + encodeURIComponent(storeId))).items || [];
  } catch (_) {}
  // 已加入判定：模板 id 命中，或标题互相包含（两套模板目录 id 不同，但内容重叠）
  const have = new Set(kb.map((k) => k.templateId).filter(Boolean));
  const kbTitles = kb.map((k) => String(k.title || ''));
  const addedByTitle = (t) => kbTitles.some((x) => x.includes(t.title) || t.title.includes(x));
  const groups = {};
  for (const t of tpls) {
    const g = (t.tags && t.tags[0]) || '其他';
    (groups[g] = groups[g] || []).push(t);
  }
  // 用户从「回复日志 → 加入模板」创建的条目：不属于内置模板库，但也是可复用模板
  const mine = kb.filter((k) => !k.templateId);

  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">模板库 · ${tpls.length} 条</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div style="font-size:12.5px;color:#64748b;line-height:1.7;margin-bottom:12px">
        点「加入」会进入知识库的<b>待填写</b>，把【】改成你店铺的真实信息后启用。
      </div>
      ${mine.length ? `
      <div class="tpl-group">
        <div class="tpl-group-h">自定义 / 我加入的 · ${mine.length} 条</div>
        ${mine.map((k) => `
          <div class="tpl-row">
            <div class="tpl-main">
              <div class="tpl-t">${esc(k.title)}${k.enabled === false || /【[^】]+】/.test(String(k.answer||'')) ? '<span class="kb-tag">待填写</span>' : ''}</div>
              <div class="tpl-q">${esc(String(k.answer || '').replace(/\n/g, ' ').slice(0, 54))}</div>
            </div>
            <span class="tpl-done">已加入</span>
          </div>`).join('')}
      </div>` : ''}

      ${Object.keys(groups).map((g) => `
        <div class="tpl-group">
          <div class="tpl-group-h">${esc(g)}</div>
          ${groups[g].map((t) => `
            <div class="tpl-row">
              <div class="tpl-main">
                <div class="tpl-t">${esc(t.title)}</div>
                <div class="tpl-q">${esc(String(t.answer || '').slice(0, 54))}…</div>
              </div>
              ${have.has(t.id) || addedByTitle(t)
                ? '<span class="tpl-done">已加入</span>'
                : `<button class="btn-line primary tpl-add" data-tpl="${esc(t.id)}">加入</button>`}
            </div>`).join('')}
        </div>`).join('')}
    </div>`);

  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSubModal));
  $('#modal2').querySelectorAll('[data-tpl]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      let r = null;
      try { r = await api('/api/kb/import', 'POST', { ids: [b.dataset.tpl] }); } catch (e) { r = { ok: false, error: e.message }; }
      if (r && r.ok && r.added > 0) {
        toast('已加入待填写：把【】改成实际信息再启用');
        closeSubModal();
        renderWorkbench('kb');
      } else {
        b.disabled = false;
        toast('没加入成功' + (r && r.error ? '：' + r.error : '（可能已存在）'));
      }
    });
  });
}

// 新店知识库来源：复制某店 / 从空白开始。复制完可把「通用」老条目归档。
function askCopyKnowledge(newId, others) {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">新店铺的知识库</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div style="font-size:12.5px;color:#64748b;line-height:1.7;margin-bottom:12px">
        每个店铺的快递、发货时间、售后口径都可能不一样。<br>
        建议从最接近的一家复制一份，再改掉不同的地方。
      </div>
      ${others.map((x) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid #e6ebf2;border-radius:9px;margin-bottom:6px">
          <span style="flex:1;font-size:13px">${esc(x.name)}</span>
          <button class="btn-line primary" data-copy="${esc(x.id)}" style="height:26px;padding:0 10px;font-size:12px">复制过来</button>
        </div>`).join('')}
      <button class="btn-line ghost" id="skipCopy" style="width:100%;margin-top:6px;height:30px">从空白开始（以后也能复制）</button>
    </div>`);

  $('#modal').querySelector('[data-close]').addEventListener('click', closeModal);
  $('#skipCopy').addEventListener('click', closeModal);
  $('#modal').querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', async () => {
      const src = others.find((x) => x.id === b.dataset.copy);
      const r = await api('/api/knowledge/copy', 'POST', { from: b.dataset.copy, to: newId });
      closeModal();
      toast(r && r.added ? `已从「${src.name}」复制 ${r.added} 条` : '没有可复制的条目');
      setTimeout(() => {
        if (confirm('要不要把「通用」老知识归档？它们会出现在所有店铺里，容易串口径。')) {
          api('/api/knowledge/archive-generic', 'POST', { archive: true }).then(() => toast('通用知识已归档')).catch(() => {});
        }
      }, 500);
    });
  });
}

// ---------------------------------------------------------------- 店铺资料（商品 + 说明书）

function openStoreAssets() {
  const store = state.stores.find((s) => s.id === state.activeId) || {};
  openModal(`
    <div class="modal-head">
      <div class="modal-title">${esc(store.name || '当前店铺')} · 商品与说明书</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body" id="wbBody"></div>`);
  $('#modal').querySelector('[data-close]').addEventListener('click', closeModal);
  renderWorkbench('prod');
}

// ---------------------------------------------------------------- 说明书编辑

function parseManualText(text) {
  const blocks = String(text || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const sections = [];
  for (const b of blocks) {
    const lines = b.split('\n').map((x) => x.trim());
    const titleLine = lines[0] || '';
    const title = titleLine.replace(/^\[|\]$/g, '').trim();
    if (!title) continue;
    let keywords = [];
    let content = '';
    for (const line of lines.slice(1)) {
      const kw = line.match(/^关键词[:：]\s*(.*)$/);
      const ct = line.match(/^内容[:：]\s*(.*)$/);
      if (kw) keywords = kw[1].split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
      else if (ct) content = ct[1];
      else if (content) content += line;
    }
    if (content) sections.push({ title, keywords, content });
  }
  return sections;
}

function serializeManual(manual) {
  if (!manual || !manual.sections || !manual.sections.length) return '';
  return manual.sections
    .map((s) => `[${s.title}]\n关键词: ${(s.keywords || []).join(',')}\n内容: ${s.content}`)
    .join('\n\n');
}

async function openManualEditor(goodsId, title) {
  let manual = null;
  try {
    const r = await api('/api/manuals?goodsId=' + encodeURIComponent(goodsId));
    manual = (r.items || [])[0] || null;
  } catch (_) {}

  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">商品说明书 · ${esc(title)}</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div style="font-size:12px;color:#8b95a5;line-height:1.7;margin-bottom:10px">
        每个商品一份说明书，用空行分节。买家问到哪一节，就只发那一节。<br>
        <b>格式</b>：第一行 <code>[小标题]</code>，第二行 <code>关键词: 泡水,浸种</code>，第三行 <code>内容: 要泡水的…</code>
      </div>
      <textarea class="input" id="mText" style="min-height:280px;font-family:ui-monospace,Menlo,monospace;font-size:12.5px">${esc(serializeManual(manual))}</textarea>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn-line primary" id="mSave">保存说明书</button>
        <button class="btn-line ghost" id="mTpl">插入示例结构</button>
        <button class="btn-line ghost" data-close>取消</button>
        <span style="font-size:11px;color:#8b95a5;align-self:center">保存后立即可用，不需要重启</span>
      </div>
    </div>`);

  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSubModal));
  $('#mTpl').addEventListener('click', () => {
    const t = $('#mText');
    if (t.value.trim()) {
      if (!confirm('已有内容，确定要覆盖成示例结构吗？')) return;
    }
    t.value = [
      '[材质与规格]',
      '关键词: 材质,尺寸,多长,多重,规格',
      '内容: （写清楚材质、尺寸、重量，例如：天然花椒木，长约 18cm，直径 1.5~2cm）',
      '',
      '[适用对象]',
      '关键词: 适合,多大的鸟,鹦鹉,能用吗',
      '内容: （写清楚适合哪些鸟、不适合哪些）',
      '',
      '[怎么用]',
      '关键词: 怎么用,安装,固定,使用',
      '内容: （写清楚安装/固定方式）',
      '',
      '[清洁保养]',
      '关键词: 清洗,消毒,发霉,保养',
      '内容: （写清楚多久清洁一次、能不能水洗、怎么晾干）',
      '',
      '[注意事项]',
      '关键词: 注意,安全,啃咬,掉色',
      '内容: （写清楚安全提示，不承诺效果）',
    ].join('\n');
    t.focus();
  });

  $('#mSave').addEventListener('click', async () => {
    const sections = parseManualText($('#mText').value);
    if (!sections.length) return toast('至少要有一节，格式：[标题] / 关键词: … / 内容: …');
    const r = await api('/api/manuals', 'POST', { storeId: state.activeId || '', item: { goodsId, title, sections, storeId: state.activeId || '' } });
    if (r.ok) {
      toast('已保存 ' + sections.length + ' 节');
      closeSubModal();
      renderWorkbench('prod');
    } else {
      toast('保存失败：' + (r.error || ''));
    }
  });
}

// ---------------------------------------------------------------- 测试会话

const ts = { convId: '', turns: [], busy: false };

function newTestSession() {
  ts.convId = 'test-' + Date.now().toString(36);
  ts.turns = [];
  renderTest();
}

function openTestSession() {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">测试会话</div>
      <button class="btn-line ghost" id="tsNew" style="height:28px;padding:0 12px;font-size:12px;margin-left:14px">＋ 新会话</button>
      <button class="btn-line ghost" id="tsCopy" style="height:28px;padding:0 12px;font-size:12px">复制问题单</button>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="test-body" id="tsBody"></div>
    <div class="test-foot">
      <input id="tsInput" placeholder="以买家身份输入，回车发送（例：怎么还没发货）">
      <button id="tsSend">发送</button>
    </div>`);

  $('#modal').querySelector('[data-close]').addEventListener('click', closeModal);
  $('#tsNew').addEventListener('click', newTestSession);
  $('#tsCopy').addEventListener('click', copyTestReport);
  $('#tsSend').addEventListener('click', sendTestMessage);
  $('#tsInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) sendTestMessage();
  });

  if (!ts.convId) newTestSession();
  else renderTest();
  setTimeout(() => $('#tsInput') && $('#tsInput').focus(), 100);
}

function renderTest() {
  const body = document.getElementById('tsBody');
  if (!body) return;

  if (!ts.turns.length) {
    body.innerHTML = '<div class="test-empty">像一个买家一样发消息<br>工具会走真实链路（本地 → 商品 → 服务端 → 兜底）<br>每条回复下面标出决策、来源、置信度和成本</div>';
    return;
  }

  const srcText = { rule: '本地知识', product: '商品匹配', manual: '商品说明书', backend: '服务端模型', llm: '模型', none: '无' };
  let html = '';
  for (const t of ts.turns) {
    html += `<div class="turn buyer"><div class="t-bubble">${esc(t.buyer)}</div></div>`;
    if (t.error) {
      html += `<div class="turn ai fallback"><div class="t-bubble">请求失败：${esc(t.error)}</div></div>`;
      continue;
    }
    const r = t.result || {};
    const top = (r.suggestions && r.suggestions[0] && r.suggestions[0].text) || r.reason || '（无回复）';
    const isFallback = r.decision === 'fallback';
    html += `
      <div class="turn ai ${isFallback ? 'fallback' : ''}">
        <div class="t-bubble">${esc(top)}</div>
        <div class="t-meta">
          <span class="m ${r.decision === 'fallback' ? 'bad' : r.decision === 'auto_send' ? 'ok' : 'warn'}">${esc(decisionText(r.decision))}</span>
          <span class="m">${esc(srcText[r.source] || r.source || '-')}</span>
          ${r.tierName ? `<span class="m">${esc(r.tierName)}语气</span>` : ''}
          <span class="m">置信 ${r.confidence == null ? '-' : r.confidence}</span>
          <span class="m">${r.cost == null ? '-' : r.cost} 点</span>
          <span class="m">${r.latencyMs == null ? '-' : r.latencyMs}ms</span>
          ${r.backendMs ? `<span class="m">服务端 ${r.backendMs}ms</span>` : ''}
          ${r.backendError ? `<span class="m bad">服务端错误</span>` : ''}
        </div>
      </div>`;
  }
  body.innerHTML = html;
  body.scrollTop = body.scrollHeight;
}

async function sendTestMessage() {
  const input = document.getElementById('tsInput');
  const btn = document.getElementById('tsSend');
  if (!input || ts.busy) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = '';
  ts.busy = true;
  btn.disabled = true;
  btn.textContent = '思考中…';

  ts.turns.push({ buyer: text, result: null });
  renderTest();

  try {
    const messages = [];
    for (const t of ts.turns.slice(0, -1)) {
      messages.push({ role: 'buyer', text: t.buyer });
      if (t.result && t.result.suggestions && t.result.suggestions[0]) {
        messages.push({ role: 'seller', text: t.result.suggestions[0].text });
      }
    }
    messages.push({ role: 'buyer', text });

    const r = await api('/api/reply', 'POST', {
      storeId: 'test',
      storeName: '测试店铺',
      conversationId: ts.convId,
      buyerName: '测试买家',
      messages,
      mode: 'suggest',
      test: true,
      requestId: 'ts-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    });
    ts.turns[ts.turns.length - 1].result = r;
    if (r.quota) state.quota = { balance: r.quota.balance };
    refreshStatus();
  } catch (e) {
    ts.turns[ts.turns.length - 1].error = e.message;
  } finally {
    ts.busy = false;
    btn.disabled = false;
    btn.textContent = '发送';
    renderTest();
    if (input) input.focus();
  }
}

async function copyTestReport() {
  const payload = {
    sessionId: ts.convId,
    ts: new Date().toISOString(),
    turns: ts.turns.map((t) => ({
      buyer: t.buyer,
      decision: t.result && t.result.decision,
      source: t.result && t.result.source,
      tier: t.result && t.result.tier,
      confidence: t.result && t.result.confidence,
      cost: t.result && t.result.cost,
      reply: t.result && t.result.suggestions && t.result.suggestions[0] && t.result.suggestions[0].text,
      reason: t.result && t.result.reason,
      backendError: t.result && t.result.backendError,
    })),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    toast('问题单已复制，直接粘给我就行');
  } catch (_) {
    toast('复制失败，请手动截图');
  }
}

// ---------------------------------------------------------------- 工作台

// ---------------------------------------------------------------- 回复日志 → 模板

function logToTemplate(x, overrides = {}) {
  const q = String(x.buyerText || '').replace(/[。！？!?，,：:\s]+$/g, '').trim();
  const title = String(overrides.title || q || '未命名模板').slice(0, 24);
  const answer = String(overrides.answer != null ? overrides.answer : x.replyText || '').trim();
  const kwRaw = overrides.keywords != null ? overrides.keywords : q;
  const keywords = String(kwRaw)
    .split(/[,，、\s]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 6);
  const scope = overrides.scope || (state.logScope === 'global' ? 'global' : 'current');
  return {
    title,
    keywords: keywords.length ? keywords : [q.slice(0, 12)].filter(Boolean),
    answer,
    ask: x.ask || '',
    origin: 'log',
    type: 'faq',
    scope: scope === 'global' ? 'tool' : undefined,
    storeId: scope === 'global' ? '' : (state.activeId || ''),
    fromLogAt: x.ts || '',
  };
}

// 同名同范围视为同一条：更新答案，避免反复点出现重复模板
async function upsertTemplate(item) {
  let list = [];
  try {
    list = (await api('/api/knowledge?includeGlobal=1&storeId=' + encodeURIComponent(state.activeId || ''))).items || [];
  } catch (_) { /* 拉不到就按新增处理 */ }
  const sameScope = (k) => (item.scope === 'tool'
    ? k.scope === 'tool'
    : k.storeId === (state.activeId || '') && k.scope !== 'tool');
  const dup = list.find((k) => k.title === item.title && sameScope(k));
  if (dup) item.id = dup.id;
  await api('/api/knowledge', 'POST', { item });
  return Boolean(dup);
}

async function saveTemplateFromLog(x, scope) {
  if (!x) return;
  const item = logToTemplate(x, { scope });
  if (!item.answer) return toast('这条日志没有回复内容，用「编辑并加入」补一句');
  try {
    const updated = await upsertTemplate(item);
    toast(updated ? '同名模板已更新' : (scope === 'global' ? '已加入整个工具的模板' : '已加入当前店铺的模板'));
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}

function openLogTemplate(x) {
  if (!x) return;
  const t = logToTemplate(x);
  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">编辑并加入模板</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div class="form-card">
        <div class="field"><label>模板标题</label><input class="input" id="ltTitle" value="${esc(t.title)}"></div>
        <div class="field"><label>关键词（买家这么说就能命中，逗号分隔）</label><input class="input" id="ltKw" value="${esc(t.keywords.join('，'))}"></div>
        <div class="field"><label>回答（可以直接改，改完保存并加入）</label><textarea class="input" id="ltAns" rows="4">${esc(t.answer)}</textarea></div>
        <div class="field"><label>适用范围</label>
          <label class="radio"><input type="radio" name="ltScope" value="current" ${t.scope !== 'global' ? 'checked' : ''}> 当前店铺</label>
          <label class="radio"><input type="radio" name="ltScope" value="global" ${t.scope === 'global' ? 'checked' : ''}> 整个工具</label>
          <div class="hint">「整个工具」对所有店铺生效；快递、时效、退换这类各店可能不同的口径别选它。</div>
        </div>
        <div class="field"><label>原始记录</label><div class="hint">${esc((x.buyerText || '').slice(0, 80))}</div></div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn-line primary" id="ltSave">保存并加入模板</button>
          <button class="btn-line ghost" data-close>取消</button>
        </div>
      </div>
    </div>`);
  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  $('#ltSave').addEventListener('click', async () => {
    const scope = ($('#modal2').querySelector('input[name="ltScope"]:checked') || {}).value || 'current';
    const item = logToTemplate(x, {
      title: $('#ltTitle').value,
      keywords: $('#ltKw').value,
      answer: $('#ltAns').value,
      scope,
    });
    if (!item.answer) return toast('回答不能为空');
    try {
      const updated = await upsertTemplate(item);
      state.logScope = scope;
      closeSubModal();
      toast(updated ? '同名模板已更新' : '已加入模板');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  });
}

// ---------------------------------------------------------------- 路由注册表：让模型提议条目

async function analyzeRegistryText(text, gapKey) {
  toast('模型正在判断需要哪些事实块…');
  let r;
  try {
    r = await api('/api/facts/registry/analyze', 'POST', { buyerText: text });
  } catch (e) {
    return toast('分析失败：' + e.message);
  }
  if (!r || !r.ok) return toast((r && r.error) || '分析失败');
  const p = r.proposal || {};
  openSubModal(`
    <div class="modal-head">
      <div class="modal-title">注册表提议</div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="modal-body">
      <div class="form-card">
        <div class="field"><label>匹配短语（逗号分隔）</label><input class="input" id="rpMatch" value="${esc((p.match || []).join('，'))}"></div>
        <div class="field"><label>问法</label><input class="input" id="rpAsk" value="${esc(p.ask || 'other')}"></div>
        <div class="field"><label>需要的块（order/product/manual/policy）</label><input class="input" id="rpBlocks" value="${esc((p.blocks || []).join(','))}"></div>
        <div class="field"><label>必须有的块（没有就标缺失）</label><input class="input" id="rpNeeds" value="${esc((p.needs || []).join(','))}"></div>
        <div class="hint">${esc(p.note || '')}${p.confidence != null ? ' · 置信度 ' + p.confidence : ''}</div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button class="btn-line primary" id="rpSave">采纳并加入注册表</button>
          <button class="btn-line ghost" data-close>取消</button>
        </div>
      </div>
    </div>`);
  const split = (v) => String(v || '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
  $('#modal2').querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSubModal));
  $('#rpSave').addEventListener('click', async () => {
    const entry = {
      match: split($('#rpMatch').value),
      ask: $('#rpAsk').value.trim() || 'other',
      blocks: split($('#rpBlocks').value),
      needs: split($('#rpNeeds').value),
      note: p.note || '',
      source: 'learned',
    };
    if (!entry.match.length) return toast('匹配短语不能为空');
    try {
      await api('/api/facts/registry', 'POST', { entry });
      if (gapKey) await api('/api/facts/registry/gaps/dismiss', 'POST', { key: gapKey }).catch(() => {});
      closeSubModal();
      toast('已加入注册表');
      renderWorkbench('reg');
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  });
}

async function openWorkbench(tab) {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">工作台<span class="modal-store" id="wbStore"></span></div>
      <button class="modal-close" data-close>×</button>
    </div>
    <div class="tabs">
      <button class="tab ${tab === 'kb' ? 'on' : ''}" data-tab="kb">知识库</button>
      <button class="tab ${tab === 'review' ? 'on' : ''}" data-tab="review">待复核</button>
      <button class="tab ${tab === 'logs' ? 'on' : ''}" data-tab="logs">回复日志</button>
      ${state.devMode ? `<button class="tab ${tab === 'reg' ? 'on' : ''}" data-tab="reg">路由注册表</button>` : ''}
      <button class="tab ${tab === 'set' ? 'on' : ''}" data-tab="set">设置</button>
    </div>
    <div class="modal-body" id="wbBody"></div>`);

  $('#modal').querySelector('[data-close]').addEventListener('click', closeModal);
  $('#modal').querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      $('#modal').querySelectorAll('.tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      renderWorkbench(t.dataset.tab);
    });
  });

  renderWorkbench(tab);
}

async function renderWorkbench(tab) {
  const body = $('#wbBody');
  const wbStore = $('#wbStore');
  if (wbStore && tab !== 'kb') wbStore.textContent = '';
  if (tab === 'kb') {
    const storeId = state.activeId || '';
    const storeName = (state.stores.find((x) => x.id === storeId) || {}).name || '当前店铺';

    let all = [];
    try {
      all = (await api('/api/knowledge?includeGlobal=1&storeId=' + encodeURIComponent(storeId))).items || [];
    } catch (_) {
      body.innerHTML = `<div class="empty-row">本地服务未启动</div>`;
      return;
    }

    let sug = { items: [], missing: [] };
    try {
      sug = await api('/api/kb/suggestions');
    } catch (_) {}

    const hasPh = (k) => /【[^】]+】/.test(String(k.answer || ''));
    const enabled = all.filter((k) => k.enabled !== false && !hasPh(k));
    const blank = all.filter((k) => k.enabled !== false && hasPh(k)); // 模板没填，发不出去
    const disabled = all.filter((k) => k.enabled === false);
    const importedTpl = new Set(all.map((k) => k.templateId).filter(Boolean));

    // 待处理：日志里反复答不上的 + 必建但还没建的，按 templateId 去重
    const seen = new Set();
    const todos = [];
    for (const x of sug.items || []) {
      if (!x.templateId || seen.has(x.templateId) || importedTpl.has(x.templateId)) continue;
      seen.add(x.templateId);
      todos.push({ key: x.templateId, ask: x.ask, title: x.title, count: x.count, samples: x.samples || [], templateId: x.templateId });
    }
    for (const m of sug.missing || []) {
      if (!m.templateId || seen.has(m.templateId)) continue;
      seen.add(m.templateId);
      todos.push({ key: m.templateId, ask: m.category, title: m.title, count: 0, samples: [], templateId: m.templateId, important: true });
    }

    const usageTodo = (t) => t.ask === 'usage' || t.ask === 'spec';

    const storeEl = $('#wbStore');
    if (storeEl) storeEl.textContent = ' · ' + storeName;

    body.innerHTML = `
      <div class="kb-top">
        <div class="kb-stats">已启用 <b>${enabled.length}</b> · 待填写 <b>${blank.length}</b> · 已停用 <b>${disabled.length}</b> · 待处理 <b>${todos.length}</b></div>
        <div class="kb-top-r">
          <button class="btn-line ghost" id="kbLib">模板库</button>
          <button class="btn-line ghost" id="kbCopy">从其他店铺复制</button>
          <button class="btn-line primary" id="kbNew">+ 新增一条</button>
        </div>
      </div>

      ${all.some((k) => !k.storeId) ? `
      <div class="kb-warn">
        <span>还有 <b>${all.filter((k) => !k.storeId).length}</b> 条「通用」知识，会出现在所有店铺里，容易串口径。</span>
        <button class="btn-line ghost" id="kbArchive" style="height:24px;padding:0 10px;font-size:11.5px">归档</button>
      </div>` : ''}

      ${todos.length ? `
      <div class="kb-sec">
        <div class="kb-sec-h"><span>待处理</span><em>按买家问的次数排</em></div>
        ${todos.map((t) => `
          <div class="kb-todo">
            <div class="kb-todo-n">${t.count ? t.count + ' 次' : '必建'}</div>
            <div class="kb-todo-m">
              <div class="kb-todo-t">${esc(t.title)}</div>
              <div class="kb-todo-s">${esc((t.samples || []).join(' / ').slice(0, 46)) || '还没建，缺了会一直兜底'}</div>
            </div>
            ${usageTodo(t)
              ? `<button class="btn-line ghost kb-todo-btn" data-usage="1">去补说明书</button>`
              : `<button class="btn-line primary kb-todo-btn" data-sug="${esc(t.templateId)}">导入</button>`}
          </div>`).join('')}
      </div>` : ''}

      ${blank.length ? `
      <div class="kb-sec">
        <div class="kb-sec-h"><span>待填写 ${blank.length} 条</span><em>模板里的【】没填，买家问到时不会发</em>
          <button class="btn-line primary" id="kbFillAll" style="margin-left:auto;height:26px;padding:0 12px;font-size:12px">一键填写</button>
        </div>
        <table class="kb-table">
          <tbody>${blank.map((k) => kbRow(k)).join('')}</tbody>
        </table>
      </div>` : ''}

      <div class="kb-sec">
        <div class="kb-sec-h">
          <span>已启用 ${enabled.length} 条</span>
          <input class="input kb-search" id="kbSearch" placeholder="搜标题或关键词">
        </div>
        <table class="kb-table">
          <thead><tr><th style="width:130px">标题</th><th style="width:180px">关键词</th><th>回复</th><th style="width:132px"></th></tr></thead>
          <tbody id="kbRows">
            ${enabled.length ? enabled.map((k) => kbRow(k)).join('') : '<tr><td colspan="4" class="empty-row">还没有启用的知识</td></tr>'}
          </tbody>
        </table>
      </div>

      ${disabled.length ? `
      <div class="kb-sec">
        <div class="kb-sec-h"><span>已停用 ${disabled.length} 条</span><em>停用的不会参与回答</em></div>
        <table class="kb-table">
          <tbody>
            ${disabled.map((k) => kbRow(k)).join('')}
          </tbody>
        </table>
      </div>` : ''}

      <div class="kb-sec" id="kbFormWrap" style="display:none">
        <div class="kb-sec-h"><span>新增 / 编辑</span><button class="btn-line ghost" id="kbCancel" style="height:24px">收起</button></div>
        <input type="hidden" id="kId">
        <div class="field"><label>标题</label><input class="input" id="kTitle" placeholder="例：发货时间"></div>
        <div class="field"><label>关键词（逗号分隔）</label><input class="input" id="kKw" placeholder="什么时候发货,几天发货"></div>
        <div class="field"><label>回复正文（直接发给买家，写成能发出去的话）</label>
          <textarea class="input" id="kAns" placeholder="当天16点前付款的订单当天发出…"></textarea></div>
        <button class="btn-line primary" id="kAdd">保存</button>
      </div>`;

    function kbRow(k) {
      return `<tr data-row="${esc((k.title || '') + ' ' + (k.keywords || []).join(' '))}">
        <td class="kb-title">${esc(k.title)}${k.templateId ? '<span class="kb-tag">模板</span>' : ''}${k.storeId ? '' : '<span class="kb-tag">通用</span>'}</td>
        <td class="kb-kw">${esc((k.keywords || []).join('、'))}</td>
        <td>${esc(k.answer)}</td>
        <td style="white-space:nowrap">
          <button class="kb-del" data-edit="${esc(k.id)}">编辑</button>
          <button class="kb-del" data-toggle="${esc(k.id)}">${k.enabled === false ? '启用' : '停用'}</button>
          <button class="kb-del" data-del="${esc(k.id)}">删除</button>
        </td>
      </tr>`;
    }

    const openForm = (k) => {
      $('#kbFormWrap').style.display = '';
      $('#kId').value = k ? k.id : '';
      $('#kTitle').value = k ? k.title || '' : '';
      $('#kKw').value = k ? (k.keywords || []).join(',') : '';
      $('#kAns').value = k ? k.answer || '' : '';
      $('#kAdd').textContent = k ? '保存并启用' : '保存';
      $('#kTitle').focus();
    };

    const fillAll = $('#kbFillAll');
    if (fillAll) fillAll.addEventListener('click', openFillAll);

    $('#kbLib').addEventListener('click', openTemplateLib);

    const arch = $('#kbArchive');
    if (arch) {
      arch.addEventListener('click', async () => {
        if (!confirm('归档后这些通用知识不再参与回答（不删除，可恢复）。确定？')) return;
        await api('/api/knowledge/archive-generic', 'POST', { archive: true });
        toast('已归档通用知识');
        renderWorkbench('kb');
      });
    }

    $('#kbNew').addEventListener('click', () => openForm(null));
    $('#kbCancel').addEventListener('click', () => { $('#kbFormWrap').style.display = 'none'; });

    $('#kbSearch').addEventListener('input', (e) => {
      const q = e.target.value.trim();
      body.querySelectorAll('[data-row]').forEach((tr) => {
        tr.style.display = !q || tr.dataset.row.includes(q) ? '' : 'none';
      });
    });

    $('#kbCopy').addEventListener('click', async () => {
      let stores = [];
      try { stores = (await api('/api/stores')).items || []; } catch (_) { stores = state.stores; }
      const others = (stores || []).filter((x) => x.id !== storeId);
      if (!others.length) return toast('没有其他店铺可复制');
      const src = prompt('从哪个店铺复制？输入序号：\\n' + others.map((x, i) => (i + 1) + '. ' + x.name).join('\\n'));
      const idx = Number(src) - 1;
      if (!others[idx]) return;
      const r = await api('/api/knowledge/copy', 'POST', { from: others[idx].id, to: storeId });
      toast(r && r.added ? `已从「${others[idx].name}」复制 ${r.added} 条` : '没有新条目（同名已存在）');
      renderWorkbench('kb');
    });

    body.querySelectorAll('[data-sug]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        let r = null;
        try { r = await api('/api/kb/import', 'POST', { ids: [b.dataset.sug] }); } catch (e) { r = { ok: false, error: e.message }; }
        if (r && r.ok && r.added > 0) toast('已加入待确认：把【】改成实际信息再启用');
        else toast('没加入成功' + (r && r.error ? '：' + r.error : '，可能已存在'));
        renderWorkbench('kb');
      });
    });

    body.querySelectorAll('[data-usage]').forEach((b) => {
      b.addEventListener('click', () => {
        closeModal();
        setTimeout(openStoreAssets, 150);
      });
    });

    body.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = all.find((x) => x.id === b.dataset.edit);
        if (k) openForm(k);
      });
    });

    body.querySelectorAll('[data-toggle]').forEach((b) => {
      b.addEventListener('click', async () => {
        const k = all.find((x) => x.id === b.dataset.toggle);
        if (!k) return;
        if (k.enabled === false && /【[^】]+】/.test(String(k.answer || ''))) {
          openForm(k);
          return toast('先把【】改成实际信息');
        }
        await api('/api/knowledge', 'POST', { item: Object.assign({}, k, { enabled: k.enabled === false }) });
        renderWorkbench('kb');
      });
    });

    body.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('删除这条知识？')) return;
        await api('/api/knowledge/delete', 'POST', { id: b.dataset.del });
        renderWorkbench('kb');
      });
    });

    $('#kAdd').addEventListener('click', async () => {
      const title = $('#kTitle').value.trim();
      const answer = $('#kAns').value.trim();
      if (!title || !answer) return toast('标题和回复都要填');
      if (/【[^】]+】/.test(answer)) return toast('回复里还有【待填写】的内容');
      const keywords = $('#kKw').value.split(/[,，、\\s]+/).map((x) => x.trim()).filter(Boolean);
      const editId = $('#kId').value;
      const editing = editId ? all.find((x) => x.id === editId) : null;
      const item = { title, answer, keywords, type: 'faq', enabled: true, storeId };
      // 编辑「整个工具」的模板时保留 scope，别一编辑就被改成当前店铺
      if (editing && editing.scope === 'tool') { item.scope = 'tool'; item.storeId = ''; }
      if (editId) item.id = editId;

      // 保存前先自测：加进去但检索不到，等于白加
      let probe = null;
      try {
        probe = await api('/api/knowledge/probe', 'POST', { item, storeId });
      } catch (_) {}
      if (probe && probe.ok && !probe.pass) {
        return showProbeResult(probe, async () => {
          await api('/api/knowledge', 'POST', { item, storeId });
          toast(editId ? '已保存并启用' : '已保存（自测未完全通过）');
          renderWorkbench('kb');
        });
      }

      try {
        await api('/api/knowledge', 'POST', { item, storeId });
        toast(editId ? '已保存并启用' : '已保存');
        renderWorkbench('kb');
      } catch (e) {
        toast(e.message || '保存失败');
      }
    });
  } else if (tab === 'review') {
    let items = [];
    try {
      const d = await api('/api/review');
      items = (d.items || []).filter((x) => !x.resolved);
    } catch (_) {
      body.innerHTML = `<div class="empty-row">本地服务未启动</div>`;
      return;
    }
    body.innerHTML = items.length
      ? `<table class="kb-table"><thead><tr><th style="width:110px">时间</th><th style="width:100px">买家</th><th>原因</th><th>最后一句</th><th style="width:70px"></th></tr></thead><tbody>
          ${items.map((x) => `<tr>
            <td class="kb-kw">${esc(String(x.ts || '').replace('T', ' ').slice(5, 16))}</td>
            <td>${esc(x.buyerName || '-')}</td>
            <td>${esc(x.reason || '')}</td>
            <td class="kb-kw">${esc((x.buyerText || '').slice(0, 50))}</td>
            <td><button class="kb-del" data-rv="${esc(x.id)}">已处理</button></td>
          </tr>`).join('')}</tbody></table>`
      : `<div class="empty-row">没有待复核的会话</div>`;
    body.querySelectorAll('[data-rv]').forEach((b) => {
      b.addEventListener('click', async () => {
        await api('/api/review/resolve', 'POST', { id: b.dataset.rv });
        refreshStatus();
        renderWorkbench('review');
      });
    });
  } else if (tab === 'logs') {
    let items = [];
    try {
      items = ((await api('/api/logs')).items || []).filter((x) => x.buyerText || x.replyText);
    } catch (_) {
      body.innerHTML = '<div class="empty-row">本地服务未启动</div>';
      return;
    }
    const cur = state.activeId || '';
    const storeName = (id) => (state.stores.find((s) => s.id === id) || {}).name || (id || '未标记店铺');
    const view = state.logView === 'all' ? 'all' : 'current';
    const saveScope = state.logScope === 'global' ? 'global' : 'current';
    const list = items
      .filter((x) => (view === 'current' ? !x.storeId || x.storeId === cur : true))
      .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
      .slice(0, 100);
    const srcName = { rule: '本地知识', product: '商品', manual: '说明书', backend: '模型', policy: '策略' };
    const decName = { auto_send: '自动', suggest: '需确认', fallback: '兜底', handoff: '转人工' };

    body.innerHTML = `
      <div class="log-bar">
        <span class="log-seg">
          <button class="seg ${view === 'current' ? 'on' : ''}" data-logview="current">当前店铺</button>
          <button class="seg ${view === 'all' ? 'on' : ''}" data-logview="all">全部店铺</button>
        </span>
        <span class="log-note">最近 ${list.length} 条</span>
        <span class="spacer"></span>
        <span class="log-note">加入模板的范围</span>
        <select class="input log-scope" id="logScope">
          <option value="current" ${saveScope === 'current' ? 'selected' : ''}>当前店铺</option>
          <option value="global" ${saveScope === 'global' ? 'selected' : ''}>整个工具（所有店铺）</option>
        </select>
      </div>
      ${list.length ? list.map((x, i) => `
        <div class="log-item">
          <div class="log-top">
            <span class="log-time">${esc(String(x.ts || '').replace('T', ' ').slice(5, 16))}</span>
            <span class="chip">${esc(storeName(x.storeId))}</span>
            <span class="chip blue">${esc(srcName[x.source] || x.source || '-')}</span>
            <span class="chip">${esc(fmtPts(x.cost))} 点</span>
            <span class="chip">${esc(decName[x.decision] || x.decision || '-')}</span>
          </div>
          <div class="log-q">买家：${esc((x.buyerText || '').slice(0, 120))}</div>
          <div class="log-a">回复：${esc(x.replyText || '（无）')}</div>
          <div class="log-acts">
            <button class="btn-line ghost log-add" data-i="${i}">加入模板</button>
            <button class="btn-line ghost log-edit" data-i="${i}">编辑并加入</button>
          </div>
        </div>`).join('') : '<div class="empty-row">还没有回复记录</div>'}`;

    body.querySelectorAll('[data-logview]').forEach((b) => {
      b.addEventListener('click', () => {
        state.logView = b.dataset.logview;
        renderWorkbench('logs');
      });
    });
    const scopeEl = body.querySelector('#logScope');
    if (scopeEl) {
      scopeEl.addEventListener('change', () => {
        state.logScope = scopeEl.value;
        toast(scopeEl.value === 'global' ? '加入模板会作用于所有店铺' : '加入模板只作用于当前店铺');
      });
    }
    body.querySelectorAll('.log-add').forEach((b) => {
      b.addEventListener('click', () => saveTemplateFromLog(list[Number(b.dataset.i)], state.logScope));
    });
    body.querySelectorAll('.log-edit').forEach((b) => {
      b.addEventListener('click', () => openLogTemplate(list[Number(b.dataset.i)]));
    });
  } else if (tab === 'reg') {
    let data = { entries: [], gaps: [] };
    try {
      data = await api('/api/facts/registry');
    } catch (_) {
      body.innerHTML = '<div class="empty-row">本地服务未启动</div>';
      return;
    }
    const entries = data.entries || [];
    const gaps = data.gaps || [];
    const blockText = (e) => ((e.blocks || []).join('+') || '-') + (e.needs && e.needs.length ? ' / 必须 ' + e.needs.join('+') : '');
    body.innerHTML = `
      <div class="log-bar">
        <input class="input" id="regInput" placeholder="输入一句买家话，让模型判断需要哪些事实块" style="flex:1">
        <button class="btn-line primary" id="regAnalyze">分析</button>
        <span class="log-note">${entries.length} 条 · 缺口 ${gaps.length}</span>
      </div>
      ${gaps.length ? `<div class="kb-sec">
        <div class="kb-sec-h"><span>测试缺口 ${gaps.length}</span><em>没命中注册表；可以让模型提议</em></div>
        ${gaps.map((g) => `<div class="log-item">
          <div class="log-top"><span class="chip warn">缺口</span><span class="log-time">×${g.count || 1}</span><span class="chip blue">${esc(g.mode || '-')}</span></div>
          <div class="log-q">买家：${esc(g.buyerText)}</div>
          <div class="log-a">当前路由：${esc((g.asks || []).join('、') || '无')}${g.trigger ? ' · ' + esc(g.trigger) : ''}</div>
          <div class="log-acts">
            <button class="btn-line primary" data-analyze="${esc(g.key)}">让模型提议</button>
            <button class="btn-line ghost" data-ignore="${esc(g.key)}">忽略</button>
          </div>
        </div>`).join('')}
      </div>` : ''}
      <div class="kb-sec">
        <div class="kb-sec-h"><span>已注册 ${entries.length} 条</span><em>注册表优先于静态路由</em></div>
        <table class="kb-table">
          <thead><tr><th>匹配短语</th><th style="width:120px">问法</th><th style="width:150px">块 / 必须</th><th style="width:70px">来源</th><th style="width:70px"></th></tr></thead>
          <tbody>${entries.length ? entries.map((e) => `<tr>
            <td class="kb-kw">${esc((e.match || []).join('、'))}</td>
            <td>${esc(e.ask)}</td>
            <td>${esc(blockText(e))}</td>
            <td>${esc(e.source === 'learned' ? '学习' : e.source === 'seed' ? '内置' : '手动')}</td>
            <td><button class="kb-del" data-reg-disable="${esc(e.id)}">停用</button></td>
          </tr>`).join('') : '<tr><td colspan="5" class="empty-row">还没有注册条目</td></tr>'}</tbody>
        </table>
      </div>`;

    $('#regAnalyze').addEventListener('click', () => {
      const t = $('#regInput').value.trim();
      if (!t) return toast('先输入一句买家话');
      analyzeRegistryText(t);
    });
    body.querySelectorAll('[data-analyze]').forEach((b) => {
      b.addEventListener('click', () => {
        const g = gaps.find((x) => x.key === b.dataset.analyze);
        if (g) analyzeRegistryText(g.buyerText, g.key);
      });
    });
    body.querySelectorAll('[data-ignore]').forEach((b) => {
      b.addEventListener('click', async () => {
        await api('/api/facts/registry/gaps/dismiss', 'POST', { key: b.dataset.ignore }).catch(() => {});
        renderWorkbench('reg');
      });
    });
    body.querySelectorAll('[data-reg-disable]').forEach((b) => {
      b.addEventListener('click', async () => {
        await api('/api/facts/registry/disable', 'POST', { id: b.dataset.regDisable }).catch(() => {});
        renderWorkbench('reg');
      });
    });
  } else if (tab === 'prod') {
    const storeId = state.activeId || '';
    const storeName = (state.stores.find((s) => s.id === storeId) || {}).name || '当前店铺';
    const belongs = (p) => p.storeId === storeId;

    let items = [];
    try {
      const all = (await api('/api/products?storeId=' + encodeURIComponent(storeId))).items || [];
      items = all.filter(belongs);
    } catch (_) {
      body.innerHTML = `<div class="empty-row">本地服务未启动</div>`;
      return;
    }
    let manuals = [];
    try {
      manuals = ((await api('/api/manuals?storeId=' + encodeURIComponent(storeId))).items || []).filter((m) => items.some((p) => String(p.goodsId) === String(m.goodsId)));
    } catch (_) {}
    const manualMap = new Map(manuals.map((m) => [String(m.goodsId), m]));
    const pending = items.filter((x) => x.status === 'pending');
    const done = items.filter((x) => x.status !== 'pending');
    const covered = done.filter((p) => manualMap.has(String(p.goodsId))).length;

    body.innerHTML = `
      <div class="form-card">
        <div class="field"><label>批量导入商品（CSV：商品ID,标题,价格,库存,规格,品类,别名,链接）</label>
          <textarea class="input" id="csvBox" placeholder="商品ID,标题,价格,库存,规格,品类,别名&#10;1001,白萝卜种子 四季播,9.9,320,20g/袋,萝卜|白萝卜"></textarea>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn-line primary" id="csvImport">导入</button>
          <button class="btn-line ghost" id="csvSample">填入示例</button>
          <span style="font-size:11px;color:#8b95a5">品类留空时自动归类，判不准的进下面的待归类队列</span>
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;margin:10px 0 12px">
        <button class="btn-line primary" id="prodSync">立即同步商品</button>
        <span style="font-size:11px;color:#8b95a5">登录后会自动同步，30 分钟内不重复</span>
        <span style="font-size:11px;color:${covered === done.length && done.length ? '#0b7a55' : '#b45309'};margin-left:auto">
          ${storeName} · 说明书 ${covered}/${done.length}${done.length - covered > 0 ? `，还有 ${done.length - covered} 个没补` : ''}
        </span>
      </div>

      <div class="pending-box">
        <div class="pending-head">
          <span>待归类 <b>${pending.length}</b> 个</span>
          <span class="pending-tip">这些商品暂时不会参与回答，避免推错货</span>
        </div>
        ${pending.length ? pending.map((p) => `
          <div class="pending-row">
            <div class="pr-main">
              <div class="pr-title">${esc(p.title)}</div>
              <div class="pr-why">${esc(p.classifyReason || '')}${p.suggestion ? ' · 建议品类：<b>' + esc(p.suggestion) + '</b>' : ''}</div>
            </div>
            <input class="input pr-input" data-gid="${esc(p.goodsId)}" placeholder="填品类，如 辣椒" value="${esc(p.suggestion || '')}">
            <button class="btn-line primary pr-ok" data-gid="${esc(p.goodsId)}" data-sug="${esc(p.suggestion || '')}">确认</button>
          </div>`).join('') : '<div class="empty-row">没有待归类的商品</div>'}
      </div>

      <table class="kb-table" style="margin-top:16px">
        <thead><tr><th style="width:80px">商品ID</th><th>标题</th><th style="width:70px">品类</th><th style="width:62px">价格</th><th style="width:60px">库存</th><th style="width:80px">说明书</th></tr></thead>
        <tbody>
          ${done.length ? done.map((p) => `
            <tr>
              <td class="muted">${esc(p.goodsId)}</td>
              <td>${esc(p.title)}</td>
              <td>${p.category
                ? `<b>${esc(p.category)}</b>`
                : `<input class="cat-input" data-cat="${esc(p.goodsId)}" placeholder="填品类" style="width:64px;height:24px;font-size:11.5px;border:1px solid #e3e8f0;border-radius:6px;padding:0 6px">`}</td>
              <td>¥${esc(p.price)}</td>
              <td>${esc(p.stock)}</td>
              <td>
                <button class="kb-del" style="color:${manualMap.has(String(p.goodsId)) ? '#0b7a55' : 'var(--accent)'};background:${manualMap.has(String(p.goodsId)) ? '#e9f9f1' : '#eef3ff'}" data-manual="${esc(p.goodsId)}" data-title="${esc(p.title)}">
                  ${manualMap.has(String(p.goodsId)) ? '已配置' : '去填写'}
                </button>
                ${manualMap.has(String(p.goodsId)) ? '' : '<div style="font-size:10.5px;color:#b45309;margin-top:3px;line-height:1.4">补说明书，回复更准</div>'}
              </td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty-row">还没有商品</td></tr>'}
        </tbody>
      </table>`;

    $('#prodSync').addEventListener('click', async () => {
      const btn = $('#prodSync');
      btn.disabled = true;
      btn.textContent = '同步中…';
      const r = await B.sync.run().catch((e) => ({ ok: false, error: e.message }));
      btn.disabled = false;
      btn.textContent = '立即同步商品';
      if (r && r.ok) {
        toast('已同步 ' + (r.count || 0) + ' 个商品');
        renderWorkbench('prod');
      } else {
        toast('同步失败：' + ((r && r.error) || '未知'));
      }
    });

    $('#csvSample').addEventListener('click', async () => {
      const r = await fetch('/api/templates').catch(() => null);
      $('#csvBox').value = `商品ID,标题,价格,库存,品类,别名
2001,白萝卜种子 四季播 耐寒 蔬菜种子 籽,9.9,320,,
2002,番茄种子 大果 沙瓤 四季播,6.9,480,,
2003,螺丝椒种子 特辣 中早熟,6.5,210,,
2004,紫叶生菜种子 四季播 盆栽,5.5,300,,
2005,水果玉米种子 甜糯 抗倒伏,8.2,120,,
2006,香葱种子 小葱 四季播,4.5,560,,
2007,大叶菠菜种子 耐寒 秋播,5.8,430,,
2008,特辣朝天椒种子 干椒 小辣椒,7.2,90,,`;
    });

    $('#csvImport').addEventListener('click', async () => {
      const csv = $('#csvBox').value.trim();
      if (!csv) return toast('先粘贴 CSV');
      const r = await api('/api/products/import', 'POST', { csv });
      toast(`导入完成：新增 ${r.added}，待归类 ${r.pending}`);
      renderWorkbench('prod');
    });

    body.querySelectorAll('[data-manual]').forEach((b) => {
      b.addEventListener('click', () => openManualEditor(b.dataset.manual, b.dataset.title));
    });

    body.querySelectorAll('.pr-ok').forEach((b) => {
      b.addEventListener('click', async () => {
        const gid = b.dataset.gid;
        const input = body.querySelector(`.pr-input[data-gid="${gid}"]`);
        const category = (input && input.value || '').trim();
        if (!category) return toast('先填一个品类');
        const sug = b.dataset.sug;
        const aliases = sug && sug !== category ? [sug] : [];
        await api('/api/products/classify', 'POST', { goodsId: gid, category, aliases });
        toast('已归类到「' + category + '」');
        renderWorkbench('prod');
      });
    });
  } else {
    let cfg;
    try {
      cfg = await api('/api/config');
    } catch (_) {
      body.innerHTML = `<div class="empty-row">本地服务未启动</div>`;
      return;
    }
    body.innerHTML = `
      <div class="grid2">
        <div class="field"><label>回复模式</label>
          <select class="input" id="cMode">
            <option value="suggest" ${cfg.mode === 'suggest' ? 'selected' : ''}>建议模式（人工确认）</option>
            <option value="auto" ${cfg.mode === 'auto' ? 'selected' : ''}>自动模式（满足条件自动发）</option>
          </select></div>
        <div class="field"><label>自动发送最低置信度</label><input class="input" id="cConf" type="number" step="0.01" min="0" max="1" value="${cfg.autoMinConfidence}"></div>
        <div class="field"><label>自动发送意图白名单</label><input class="input" id="cWhite" value="${esc((cfg.autoIntentWhitelist || []).join(','))}"></div>
        <div class="field"><label>工作时段（留空=全天）</label><input class="input" id="cHours" value="${cfg.businessHours && cfg.businessHours.enabled ? cfg.businessHours.start + '-' + cfg.businessHours.end : ''}"></div>
        <div class="field"><label>称呼（只在本次会话第一次回复时带）</label>
          <div style="display:flex;gap:8px">
            <select class="input" id="cSalOn" style="width:110px">
              <option value="1" ${cfg.salutation && cfg.salutation.enabled ? 'selected' : ''}>启用</option>
              <option value="0" ${cfg.salutation && cfg.salutation.enabled ? '' : 'selected'}>不启用</option>
            </select>
            <input class="input" id="cSalText" value="${esc((cfg.salutation && cfg.salutation.text) || '亲')}" placeholder="亲 / 亲亲 / 您好">
          </div>
        </div>
        <div class="field"><label>LLM Base URL</label><input class="input" id="cBase" value="${esc(cfg.llm.baseUrl || '')}" placeholder="https://api.deepseek.com/v1"></div>
        <div class="field"><label>LLM 模型</label><input class="input" id="cModel" value="${esc(cfg.llm.model || '')}" placeholder="deepseek-chat"></div>
        <div class="field"><label>LLM API Key</label><input class="input" id="cKey" type="password" placeholder="${cfg.llm.apiKey ? '已保存，留空不修改' : 'sk-...'}"></div>
        <div class="field"><label>同会话最小间隔（毫秒）</label><input class="input" id="cGap" type="number" step="1000" value="${cfg.rateLimit.perConversationMs}"></div>
      </div>
      <div style="margin:18px 0 10px;padding-top:16px;border-top:1px dashed var(--line);font-size:12.5px;font-weight:600">服务端模型</div>
      <div class="grid2">
        <div class="field"><label>服务端地址</label>
          <input class="input" id="bUrl" value="${esc((cfg.backend && cfg.backend.url) || '')}" placeholder="http://127.0.0.1:8788"></div>
        <div class="field"><label>访问令牌</label>
          <input class="input" id="bToken" type="password" value="${esc((cfg.backend && cfg.backend.token) || '')}" placeholder=".env 里的 API_TOKEN"></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <button class="btn-line ghost" id="bTest">测试连接</button>
        <span style="font-size:11px;color:#8b95a5">只有本地答不上来时才走服务端，密钥不会下发到这台电脑</span>
      </div>

      <div style="margin:18px 0 10px;padding-top:16px;border-top:1px dashed var(--line);font-size:12.5px;font-weight:600">语气档位</div>
      <div class="field"><label>启用的档位（取消勾选则该场景回落到标准档）</label>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${[['standard','标准'],['apology','歉意'],['warm','热情'],['pro','专业']].map(([k,n]) => `
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#3f4756">
              <input type="checkbox" class="tierChk" value="${k}" ${((cfg.tone && cfg.tone.disabled) || []).includes(k) ? '' : 'checked'}> ${n}
            </label>`).join('')}
        </div>
      </div>

      <div style="margin:18px 0 10px;padding-top:16px;border-top:1px dashed var(--line);font-size:12.5px;font-weight:600">话术风格</div>
      <div class="grid2">
        <div class="field"><label>称呼档位</label>
          <select class="input" id="sTone">
            <option value="formal" ${((cfg.style && cfg.style.tone) || 'formal') === 'formal' ? 'selected' : ''}>正式（一律用「您」）</option>
            <option value="friendly" ${((cfg.style && cfg.style.tone) || 'formal') === 'friendly' ? 'selected' : ''}>亲切（可以用「你」）</option>
          </select></div>
        <div class="field"><label>需要改写的说法（逗号分隔，命中后自动改写，不会丢弃回复）</label>
          <input class="input" id="sForbid" value="${esc(((cfg.style && cfg.style.rewriteWords) || []).join(','))}" placeholder="例：这个价还嫌贵"></div>
      </div>
      <div style="font-size:11px;color:#8b95a5;margin-bottom:16px;line-height:1.7">
        先改写再发送：内置词表直接改（不出本机），表里没有的交给模型润色；改写后数字/能否对不上就作废，最后才用兜底。
      </div>

      <div style="margin:18px 0 10px;padding-top:16px;border-top:1px dashed var(--line);font-size:12.5px;font-weight:600">预警推送</div>
      <div class="grid2">
        <div class="field"><label>启用</label>
          <select class="input" id="aOn">
            <option value="1" ${cfg.alerts && cfg.alerts.enabled ? 'selected' : ''}>开启</option>
            <option value="0" ${cfg.alerts && cfg.alerts.enabled ? '' : 'selected'}>关闭</option>
          </select></div>
        <div class="field"><label>通道类型</label>
          <select class="input" id="aType">
            ${['wecom','feishu','serverchan','webhook'].map((t) => `<option value="${t}" ${((cfg.alerts && cfg.alerts.channels && cfg.alerts.channels[0] && cfg.alerts.channels[0].type) || 'wecom') === t ? 'selected' : ''}>${({wecom:'企业微信机器人',feishu:'飞书机器人',serverchan:'Server酱（推到微信）',webhook:'通用 Webhook（OpenClaw 等）'})[t]}</option>`).join('')}
          </select></div>
        <div class="field" style="grid-column:span 2"><label>通道地址</label>
          <input class="input" id="aUrl" value="${esc(((cfg.alerts && cfg.alerts.channels && cfg.alerts.channels[0]) || {}).url || '')}" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."></div>
        <div class="field"><label>连续无法回答几次触发</label><input class="input" id="aStreak" type="number" min="1" value="${(cfg.alerts && cfg.alerts.rules && cfg.alerts.rules.consecutiveFallback) || 3}"></div>
        <div class="field"><label>点数低于多少触发</label><input class="input" id="aPoints" type="number" min="1" value="${(cfg.alerts && cfg.alerts.rules && cfg.alerts.rules.lowPoints) || 50}"></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
        <button class="btn-line ghost" id="aTest">发送测试消息</button>
        <span style="font-size:11px;color:#8b95a5">投诉/索赔默认每次都触发（有 10 分钟冷却）</span>
      </div>

      <button class="btn-line primary" id="cSave" style="margin-top:6px">保存设置</button>
      <div style="font-size:11px;color:#8b95a5;margin-top:12px;line-height:1.7">
        不配 Key 也能用：用本地知识库回答。<br>
        配了 Key：知识库没覆盖的问题自动调模型。<br>
        两种方式都是每条可发送的回复扣 1 点。
      </div>`;

    $('#cSave').addEventListener('click', async () => {
      const hours = $('#cHours').value.trim();
      const [start, end] = hours.includes('-') ? hours.split('-') : ['00:00', '23:59'];
      const patch = {
        mode: $('#cMode').value,
        autoMinConfidence: Number($('#cConf').value) || 0.82,
        autoIntentWhitelist: $('#cWhite').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
        businessHours: { enabled: Boolean(hours), start: start.trim(), end: end.trim() },
        llm: { baseUrl: $('#cBase').value.trim(), model: $('#cModel').value.trim() || 'deepseek-chat' },
        rateLimit: { perConversationMs: Number($('#cGap').value) || 8000 },
        salutation: { enabled: $('#cSalOn').value === '1', text: $('#cSalText').value.trim() || '亲', onlyFirst: true },
        backend: {
          url: document.getElementById('bUrl').value.trim(),
          token: document.getElementById('bToken').value.trim(),
          deviceId: (cfg.backend && cfg.backend.deviceId) || 'local-dev',
          minConfidence: 0.82,
          timeoutMs: 30000,
        },
        tone: {
          enabled: true,
          disabled: [...document.querySelectorAll('.tierChk')].filter((x) => !x.checked).map((x) => x.value),
        },
        style: {
          tone: $('#sTone').value,
          rewriteWords: $('#sForbid').value.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
          maxExclaim: 1,
        },
        alerts: {
          enabled: document.getElementById('aOn').value === '1',
          channels: (() => {
            const url = document.getElementById('aUrl').value.trim();
            return url ? [{ type: document.getElementById('aType').value, url }] : [];
          })(),
          cooldownMs: 600000,
          rules: {
            consecutiveFallback: Number(document.getElementById('aStreak').value) || 3,
            lowPoints: Number(document.getElementById('aPoints').value) || 50,
            complaint: true,
          },
        },
      };
      const key = $('#cKey').value.trim();
      if (key) patch.llm.apiKey = key;
      await api('/api/config', 'POST', patch);
      toast('设置已保存');
    });

    document.getElementById('bTest').addEventListener('click', async () => {
      const btn = document.getElementById('bTest');
      btn.disabled = true;
      btn.textContent = '连接中…';
      const r = await api('/api/backend/test').catch((e) => ({ ok: false, error: e.message }));
      btn.disabled = false;
      btn.textContent = '测试连接';
      if (r.ok) toast('服务端在线：' + ((r.health && r.health.model) || '已连接'));
      else toast('连接失败：' + (r.error || '未知'));
    });

    document.getElementById('aTest').addEventListener('click', async () => {
      const url = document.getElementById('aUrl').value.trim();
      if (!url) return toast('先填通道地址');
      const btn = document.getElementById('aTest');
      btn.disabled = true;
      btn.textContent = '发送中…';
      const r = await api('/api/alerts/test', 'POST', { channels: [{ type: document.getElementById('aType').value, url }] });
      btn.disabled = false;
      btn.textContent = '发送测试消息';
      const first = (r.results || [])[0] || {};
      toast(first.ok ? '测试消息已发送，去微信看一下' : '发送失败：' + (first.error || first.body || first.status || '未知'));
    });
  }
}

// ---------------------------------------------------------------- 状态

async function refreshStatus() {
  try {
    const h = await api('/api/health');
    state.health = true;
    const pill = $('#pillService');
    pill.classList.add('ok');
    pill.classList.remove('bad');
    $('#stService').innerHTML = '<span class="st-dot ok"></span>本地服务在线';
  } catch (_) {
    state.health = false;
    $('#pillService').classList.add('bad');
    $('#stService').innerHTML = '<span class="st-dot bad"></span>本地服务未启动';
  }

  try {
    const q = await api('/api/quota');
    state.quota = q;
    $('#quotaVal').textContent = fmtPts(q.balance);
  } catch (_) {}

  try {
    const s = await api('/api/stats');
    state.stats = s;
    $('#stToday').textContent = '今日回复 ' + s.today.total;
    $('#stReview').textContent = '待复核 ' + s.pendingReview;
  } catch (_) {}
}

// ---------------------------------------------------------------- 启动

(async function boot() {
  await loadStores();
  await loadEngine();
  renderAssistant();
  syncStageBounds();
  refreshStatus();
  refreshOnboard();
  setInterval(refreshStatus, 15000);
  setTimeout(syncStageBounds, 300);
  setTimeout(syncStageBounds, 1200);
})();
