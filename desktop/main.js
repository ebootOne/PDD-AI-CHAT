'use strict';

/**
 * main.js —— 拼多多客服工作台（桌面客户端主进程）
 *
 * 结构：
 *   BrowserWindow（自绘标题栏 + 左侧店铺栏 + 右侧 AI 助手）
 *     └─ WebContentsView × N（每个店铺一个，独立 session 分区，常驻）
 *
 * 关键点：
 *   1. 每个店铺一个 persist:shop-<id> 分区，登录态互不干扰、重启还在；
 *   2. 视图常驻，切换只改可见性，不重新加载；
 *   3. 页面里的 preload-cs.js 负责读 DOM / 填输入框 / 点发送，通过 IPC 与主进程通信。
 */

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const API_BASE = process.env.PDD_CS_API || 'http://127.0.0.1:8787';

// 电源管理：防挂起（默认）与防息屏（商家可选）
let powerBlockerId = null;
let displayBlockerId = null;

const DEMO_URL = pathToFileURL(path.join(__dirname, 'renderer', 'demo.html')).href;

const DEFAULT_STORES = [
  { id: 'demo', name: '磐叶（演示店）', url: DEMO_URL },
  { id: 'real', name: '真实店铺', url: 'https://mms.pinduoduo.com/chat-merchant/index.html#' },
];

let win = null;
let state = { stores: [], activeId: null };
const views = new Map(); // id -> WebContentsView
const pending = new Map(); // requestId -> {resolve, timer}
let stageBounds = { x: 208, y: 52, width: 720, height: 740 };

// ---------------------------------------------------------------- 商品自动同步

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
let syncing = false;
let saveTimer = null;

// 拼多多登录态由服务端管，长时间无请求会失效。每 10 分钟发一次轻量请求保活。
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = setInterval(async () => {
    for (const s of state.stores) {
      if (!/^https?:/.test(s.url || '')) continue;
      try {
        const sess = partOf(s.id);
        await sess.fetch('https://mms.pinduoduo.com/', { method: 'GET' });
      } catch (_) {}
    }
  }, 10 * 60 * 1000);
}

// 商品数据新鲜度：超过 30 分钟视为过期，自动补同步（失败不重试，等下一轮）
const PRODUCT_TTL_MS = 30 * 60 * 1000;
function startFreshnessWatch() {
  setInterval(async () => {
    const store = state.stores.find((s) => s.id === state.activeId);
    if (!store || !/^https?:/.test(store.url || '')) return;
    const meta = store.syncMeta || {};
    const age = meta.lastSuccessAt ? Date.now() - Date.parse(meta.lastSuccessAt) : Infinity;
    if (age > PRODUCT_TTL_MS) {
      if (win && !win.isDestroyed()) win.webContents.send('sync:stale', { age });
      autoSyncProducts(store, true).catch(() => {});
    }
  }, 10 * 60 * 1000);
}

const SCRAPE_GOODS = `(() => {
  const out = [];
  document.querySelectorAll('tr').forEach((tr) => {
    const nameEl = tr.querySelector('span.goods-name');
    if (!nameEl) return;
    const rowText = (tr.innerText || '').replace(/\s+/g, ' ');
    const idMatch = rowText.match(/ID:\s*([0-9]+)/);
    let price = '', stock = '';
    tr.querySelectorAll('td').forEach((td) => {
      const t = (td.innerText || '').replace(/\s+/g, ' ').trim();
      if (!price && /修改价格/.test(t)) price = (t.match(/[0-9]+(?:\.[0-9]+)?(?:～[0-9]+(?:\.[0-9]+)?)?/) || [''])[0];
      if (!stock && /修改库存/.test(t)) { const m = t.match(/([0-9]+)/); if (m) stock = m[1]; }
    });
    out.push({ goodsId: idMatch ? idMatch[1] : '', title: nameEl.innerText.trim(), price, stock, status: /已下架/.test(rowText) ? 'off_shelf' : 'on_sale' });
  });
  return out;
})()`;

function applyKeepAwake(on) {
  try {
    if (on && displayBlockerId == null) {
      displayBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!on && displayBlockerId != null) {
      powerSaveBlocker.stop(displayBlockerId);
      displayBlockerId = null;
    }
  } catch (_) {}
  return { on: displayBlockerId != null };
}

function pushSyncStatus(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('sync:status', payload);
}

async function autoSyncProducts(store, force) {
  if (syncing || !store) return { ok: false, error: 'busy' };
  const meta = store.syncMeta || {};
  if (!force && meta.lastSuccessAt && Date.now() - new Date(meta.lastSuccessAt).getTime() < SYNC_INTERVAL_MS) {
    return { ok: true, skipped: 'fresh' };
  }

  syncing = true;
  pushSyncStatus({ status: 'running' });

  // 用隐藏窗口 + 同一个登录分区抓，不打扰商家正在看的页面
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session: partOf(store.id), nodeIntegration: false, contextIsolation: true },
  });

  try {
    await w.loadURL('https://mms.pinduoduo.com/goods/goods_list');

    // 顺手把店铺名读回来（后台顶部 .user-name-text 就是店铺名）
    try {
      const shopName = await w.webContents.executeJavaScript(
        "(document.querySelector('.user-name-text') || {}).innerText || ''",
        true
      );
      const clean = String(shopName || '').trim().split('\n')[0].slice(0, 20);
      if (clean && /^(真实店铺|新店铺)$/.test(store.name)) {
        store.name = clean;
        saveState();
        if (win && !win.isDestroyed()) win.webContents.send('stores:changed');
      }
    } catch (_) {}

    let rows = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      rows = await w.webContents.executeJavaScript(SCRAPE_GOODS, true);
      if (rows && rows.length) break;
    }

    if (!rows || !rows.length) {
      pushSyncStatus({ status: 'empty' });
      return { ok: false, error: '没有抓到商品' };
    }

    const res = await fetch(API_BASE + '/api/products/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: store.id, items: rows }),
    });
    const data = await res.json();

    // 写后校验：回读一次，确认数据真的落库了（曾经出现过"报成功但没写进去"）
    let verified = false;
    try {
      const back = await fetch(API_BASE + '/api/products?storeId=' + encodeURIComponent(store.id)).then((r) => r.json());
      const items = (back.items || []).filter((x) => x.storeId === store.id);
      verified = items.length > 0 && items.every((x) => x.syncedAt && Date.parse(x.syncedAt) > Date.now() - 5 * 60 * 1000);
    } catch (_) {}

    if (!verified) {
      pushSyncStatus({ status: 'unverified', count: data.count || 0 });
      return { ok: false, error: '同步完成但校验未通过' };
    }

    store.syncMeta = { lastSuccessAt: new Date().toISOString(), count: data.count || rows.length };
    saveState();
    pushSyncStatus({ status: data.skipped ? 'anomaly' : 'ok', count: data.count || rows.length, skipped: data.skipped });
    return { ok: true, ...data };
  } catch (e) {
    pushSyncStatus({ status: 'failed', error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  } finally {
    try {
      w.destroy();
    } catch (_) {}
    syncing = false;
  }
}

// ---------------------------------------------------------------- 数据

function storeFile() {
  return path.join(app.getPath('userData'), 'stores.json');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (Array.isArray(raw.stores) && raw.stores.length) {
      state = raw;
      // 旧的演示店指向已删除的 mock 页面，迁移到客户端内置页面
      for (const st of state.stores) {
        if (st.id === 'demo' && String(st.url).includes('/mock/chat.html')) st.url = DEMO_URL;
      }
      return;
    }
  } catch (_) {
    /* 首次运行 */
  }
  state = { stores: DEFAULT_STORES.slice(), activeId: DEFAULT_STORES[0].id };
  saveState();
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
    fs.writeFileSync(storeFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 视图

function partOf(id) {
  return session.fromPartition(`persist:shop-${id}`);
}

function createView(store) {
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload-cs.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: partOf(store.id),
    },
  });
  view.setBackgroundColor('#ffffff');
  view.setBounds(stageBounds);
  view.setVisible(false);
  win.contentView.addChildView(view);

  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 恢复上次停留的页面（比如某个会话），没有就从客服页开始
  view.webContents.loadURL(store.lastUrl || store.url).catch(() => {});
  views.set(store.id, view);

  // 登录成功后平台会落到 /home，这里自动把人送进「多多客服」，不让商家自己找入口
  let lastAutoNav = 0;
  view.webContents.on('did-navigate', (_e, url) => {
    if (!/^https:\/\/mms\.pinduoduo\.com\//.test(url)) return;

    // 掉登录了：告诉界面，让商家点一下就能扫码回去，而不是自己找入口
    if (/\/login\//.test(url)) {
      if (win && !win.isDestroyed()) win.webContents.send('auth:expired', { storeId: store.id });
      return;
    }

    const isHome = /mms\.pinduoduo\.com\/(home)?\/?(\?|#|$)/.test(url) && !/chat-merchant/.test(url);
    if (isHome && Date.now() - lastAutoNav > 8000) {
      lastAutoNav = Date.now();
      setTimeout(() => view.webContents.loadURL(store.url).catch(() => {}), 800);
      return;
    }

    // 进入客服页 = 已登录，顺手把商品同步一次（30 分钟内不重复）
    if (/chat-merchant/.test(url)) {
      setTimeout(() => autoSyncProducts(store).catch(() => {}), 3000);
    }

    // 记住最后停留的会话，下次打开直接回来
    if (/chat-merchant/.test(url)) {
      store.lastUrl = url;
      // 定时器不能挂到 store 上：它会被 JSON.stringify 序列化进 stores.json
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveState, 2000);
    }
  });

  return view;
}

function applyBounds() {
  for (const [, v] of views) v.setBounds(stageBounds);
}

function showStore(id) {
  const store = state.stores.find((s) => s.id === id);
  if (!store) return;
  state.activeId = id;
  saveState();

  const view = views.get(id) || createView(store);
  for (const [vid, v] of views) v.setVisible(vid === id);
  view.setBounds(stageBounds);
  view.setVisible(true);

  if (win && !win.isDestroyed()) {
    win.webContents.send('store:active', { id, name: store.name, url: store.url });
  }
}

// ---------------------------------------------------------------- 与页面通信

function callPage(action, payload, timeoutMs = 8000) {
  const view = views.get(state.activeId);
  if (!view || view.webContents.isDestroyed()) return Promise.reject(new Error('没有打开的店铺页面'));

  const rid = 'r' + Date.now() + Math.random().toString(36).slice(2, 7);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(rid);
      reject(new Error('页面响应超时'));
    }, timeoutMs);
    pending.set(rid, { resolve, reject, timer });
    view.webContents.send('cs:do', { rid, action, payload });
  });
}

ipcMain.on('cs:trusted-enter', (e, msg = {}) => {
  try {
    const wc = e.sender;
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    e.sender.send('cs:trusted-result', { rid: msg.rid, ok: true });
  } catch (err) {
    e.sender.send('cs:trusted-result', { rid: msg.rid, ok: false, error: String((err && err.message) || err) });
  }
});

ipcMain.handle('cs:trusted-type', async (e, text) => {
  try {
    const wc = e.sender;
    wc.focus();
    await wc.insertText(String(text || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.on('cs:trusted-click', (e, msg = {}) => {
  try {
    const wc = e.sender;
    const x = Math.round(Number(msg.x) || 0);
    const y = Math.round(Number(msg.y) || 0);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    e.sender.send('cs:trusted-result', { rid: msg.rid, ok: true });
  } catch (err) {
    e.sender.send('cs:trusted-result', { rid: msg.rid, ok: false, error: String((err && err.message) || err) });
  }
});

ipcMain.on('cs:result', (_e, msg) => {
  const p = pending.get(msg && msg.rid);
  if (!p) return;
  pending.delete(msg.rid);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.data);
});

// 页面轮询到新消息 → 转发给渲染进程
ipcMain.on('cs:changed', (_e, data) => {
  if (process.env.CS_DEBUG) console.log('[cs:changed]', JSON.stringify(data).slice(0, 400));
  if (win && !win.isDestroyed()) win.webContents.send('cs:changed', data);
});

ipcMain.on('cs:log', (_e, data) => {
  if (win && !win.isDestroyed()) win.webContents.send('cs:log', data);
});

// ---------------------------------------------------------------- IPC

ipcMain.handle('stores:list', () => ({ stores: state.stores, activeId: state.activeId }));

ipcMain.handle('stores:switch', (_e, id) => {
  showStore(id);
  return { ok: true };
});

ipcMain.handle('stores:add', (_e, { name, url }) => {
  const clean = String(url || '').trim();
  if (!/^https?:\/\//.test(clean)) return { ok: false, error: '地址必须以 http(s):// 开头' };
  const id = 's' + Date.now().toString(36);
  state.stores.push({ id, name: String(name || '新店铺').trim() || '新店铺', url: clean });
  saveState();
  showStore(id);
  return { ok: true, stores: state.stores, activeId: id };
});

ipcMain.handle('stores:remove', (_e, id) => {
  const idx = state.stores.findIndex((s) => s.id === id);
  if (idx === -1) return { ok: false, error: '店铺不存在' };
  const v = views.get(id);
  if (v) {
    try {
      win.contentView.removeChildView(v);
      v.webContents.close();
    } catch (_) {}
    views.delete(id);
  }
  state.stores.splice(idx, 1);
  if (!state.stores.length) state.stores = DEFAULT_STORES.slice(0, 1);
  if (state.activeId === id) state.activeId = state.stores[0].id;
  saveState();
  showStore(state.activeId);
  return { ok: true, stores: state.stores, activeId: state.activeId };
});

ipcMain.handle('view:bounds', (_e, rect) => {
  if (!rect) return { ok: false };
  stageBounds = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(200, Math.round(rect.width)),
    height: Math.max(200, Math.round(rect.height)),
  };
  applyBounds();
  return { ok: true };
});

// WebContentsView 是原生层，永远盖在网页上面；
// 打开弹层时必须把它隐藏，否则弹层会被内嵌页面挡住。
ipcMain.handle('power:keepAwake', (_e, on) => {
  state.settings = state.settings || {};
  state.settings.keepAwake = Boolean(on);
  saveState();
  return applyKeepAwake(Boolean(on));
});

ipcMain.handle('power:state', () => ({
  keepAwake: Boolean(state.settings && state.settings.keepAwake),
  active: displayBlockerId != null,
}));

ipcMain.handle('auth:relogin', async () => {
  const store = state.stores.find((s) => s.id === state.activeId);
  if (!store) return { ok: false };
  const view = views.get(store.id);
  if (!view) return { ok: false };
  await view.webContents.loadURL(store.url).catch(() => {});
  return { ok: true };
});

ipcMain.handle('sync:run', async () => {
  const store = state.stores.find((s) => s.id === state.activeId);
  return autoSyncProducts(store, true);
});

ipcMain.handle('sync:status', () => {
  const store = state.stores.find((s) => s.id === state.activeId) || {};
  return { syncing, meta: store.syncMeta || null };
});

ipcMain.handle('view:visible', (_e, visible) => {
  const view = views.get(state.activeId);
  if (view) view.setVisible(Boolean(visible));
  return { ok: true };
});

ipcMain.handle('cs:capture', () => callPage('capture'));
ipcMain.handle('cs:fill', (_e, text) => callPage('fill', { text }));
ipcMain.handle('cs:send', () => callPage('send'));
ipcMain.handle('cs:clear', () => callPage('clear'));
ipcMain.handle('cs:sendProduct', (_e, goodsId) => callPage('sendProduct', { goodsId }, 12000));

ipcMain.handle('api:request', async (_e, { path: p, method = 'GET', body }) => {
  try {
    const res = await fetch(API_BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { ok: false, error: text.slice(0, 300) };
    }
    return { ok: res.ok, data };
  } catch (err) {
    return { ok: false, error: '本地服务未启动：' + String(err.message || err) };
  }
});

ipcMain.handle('win:min', () => win && win.minimize());
ipcMain.handle('win:max', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.handle('win:close', () => win && win.close());

// ---------------------------------------------------------------- 窗口

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    frame: false,
    backgroundColor: '#f4f6f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-app.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('resize', () => applyBounds());
  win.on('closed', () => {
    win = null;
  });

  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

  // 仅用于开发期截图：SHOT_PATH=/tmp/x.png 启动，5 秒后截窗口
  if (process.env.SHOT_PATH) {
    setTimeout(() => {
      const b = win.getBounds();
      require('child_process').execFile(
        '/usr/sbin/screencapture',
        ['-x', '-R', `${b.x},${b.y},${b.width},${b.height}`, process.env.SHOT_PATH],
        (err) => err && console.error('shot failed', err.message)
      );
    }, 5000);
  }
}

app.whenReady().then(() => {
  loadState();

  try {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } catch (_) {}
  if (state.settings && state.settings.keepAwake) applyKeepAwake(true);

  createWindow();
  startKeepAlive();
  startFreshnessWatch();

  // 等渲染进程量好布局再挂第一个视图
  setTimeout(() => showStore(state.activeId), 900);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
