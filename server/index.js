'use strict';

/**
 * index.js —— 本地回复服务（零依赖 Node HTTP）
 *
 * 只监听 127.0.0.1，不对外网开放；桌面客户端通过 http://127.0.0.1:8787 访问。
 * 数据全部落在 ./data 下，方便备份与审计。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const quotaStore = require('./quota');
const productStore = require('./products');
const catalog = require('./catalog');
const alerts = require('./alerts');
const backend = require('./backend');
const manuals = require('./manuals');
const { rewrite, warm, professionalTone } = require('./style');
const engine = require('./engine');
const judge = require('./judge');
const sensitive = require('./sensitive');
const kbTemplates = require('./kb-templates');
const kbSuggest = require('./kb-suggest');
const understand = require('./understand');
const knowledge = require('./knowledge');
const persona = require('./persona');
const natural = require('./natural');
const focus = require('./focus');
const session = require('./session');
const policy = require('./policy');
const context = require('./context');
const actionRouter = require('./action-router');
const actionTemplates = require('./action-templates');
const { refundPlan } = require('./actions');
const blockRegistry = require('./block-registry');
const answerGuard = require('./answer-guard');
const answerContract = require('./answer-contract');
const factRegistry = require('./fact-registry');
const metrics = require('./metrics');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---- 会话级商品记忆：问过"有萝卜吗"，下一轮问"多少钱"要能报出萝卜的价 ----
const lastProductByConv = new Map();

// ---- 兜底计数（内存）：同一会话兜底几次，决定用哪句兜底话术 ----
const fallbackState = new Map();

function getAttempt(conversationId) {
  const r = fallbackState.get(conversationId);
  if (!r) return 0;
  if (Date.now() - r.ts > 30 * 60 * 1000) {
    fallbackState.delete(conversationId);
    return 0;
  }
  return r.count;
}

function bumpAttempt(conversationId) {
  const cur = getAttempt(conversationId);
  fallbackState.set(conversationId, { count: cur + 1, ts: Date.now() });
}

function resetAttempt(conversationId) {
  fallbackState.delete(conversationId);
}

// ---- 限流状态（内存）----
const lastByConversation = new Map();
let minuteWindow = { start: 0, count: 0 };

function rateOk(cfg, conversationId) {
  const now = Date.now();
  const gap = (cfg.rateLimit && cfg.rateLimit.perConversationMs) || 8000;
  const perMinute = (cfg.rateLimit && cfg.rateLimit.perMinute) || 20;

  const last = lastByConversation.get(conversationId) || 0;
  if (now - last < gap) return false;

  if (now - minuteWindow.start > 60000) minuteWindow = { start: now, count: 0 };
  if (minuteWindow.count >= perMinute) return false;

  lastByConversation.set(conversationId, now);
  minuteWindow.count++;
  return true;
}

function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, urlPath) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(ROOT, safe);
  if (!file.startsWith(ROOT)) return send(res, 403, 'forbidden');
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return send(res, 404, 'not found');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  try {
    if (p === '/api/health') {
      // 给没有 ask 标签的老知识补分类：否则它会和模板条目一起参与“打平惩罚”，把置信度压下去
(function tagKnowledge() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    const askOfTitle = (t) => {
      const s = String(t || '');
      if (/发货/.test(s)) return 'shipping_time';
      if (/到货|时效/.test(s)) return 'arrival_time';
      if (/包邮|运费/.test(s)) return 'freight';
      if (/退换|退货/.test(s)) return 'return_policy';
      if (/不发芽|售后/.test(s)) return 'after_sale';
      if (/发票/.test(s)) return 'invoice';
      if (/支付|货到付款/.test(s)) return 'payment';
      if (/发芽率|种植|催芽|播种|温度/.test(s)) return 'usage';
      if (/规格/.test(s)) return 'spec';
      if (/议价/.test(s)) return 'nego';
      if (/有货|库存/.test(s)) return 'stock';
      return null;
    };
    for (const e of kb) {
      if (e.templateId) continue; // 模板条目用导入时带的 ask
      const a = askOfTitle(e.title) || understand.detectAsk(String(e.title || '') + ' ' + (e.keywords || []).join(' '));
      if (a && a !== 'other' && e.ask !== a) { e.ask = a; changed = true; }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) {}
})();

// 模板升级：还没被商家确认过的模板条目，跟着模板文件走（避免旧【填写】文案残留）
(function migrateTemplates() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    for (const e of kb) {
      if (!e.templateId || !e.needsConfirm) continue;
      const t = kbTemplates.list().find((x) => x.id === e.templateId);
      if (!t) continue;
      if (e.answer !== t.answer || e.ask !== t.ask || e.priority !== t.priority) {
        e.answer = t.answer;
        e.keywords = t.keywords.slice();
        e.ask = t.ask;
        e.priority = t.priority;
        changed = true;
      }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) { /* 启动迁移失败不影响服务 */ }
})();

const cfg = store.getConfig();
      return send(res, 200, {
        ok: true,
        version: '0.1.0',
        llm: cfg.llm && cfg.llm.baseUrl ? 'configured' : 'not-configured',
        mode: cfg.mode,
        time: new Date().toISOString(),
      });
    }

    if (p === '/api/config' && req.method === 'GET') {
      // 给没有 ask 标签的老知识补分类：否则它会和模板条目一起参与“打平惩罚”，把置信度压下去
(function tagKnowledge() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    const askOfTitle = (t) => {
      const s = String(t || '');
      if (/发货/.test(s)) return 'shipping_time';
      if (/到货|时效/.test(s)) return 'arrival_time';
      if (/包邮|运费/.test(s)) return 'freight';
      if (/退换|退货/.test(s)) return 'return_policy';
      if (/不发芽|售后/.test(s)) return 'after_sale';
      if (/发票/.test(s)) return 'invoice';
      if (/支付|货到付款/.test(s)) return 'payment';
      if (/发芽率|种植|催芽|播种|温度/.test(s)) return 'usage';
      if (/规格/.test(s)) return 'spec';
      if (/议价/.test(s)) return 'nego';
      if (/有货|库存/.test(s)) return 'stock';
      return null;
    };
    for (const e of kb) {
      if (e.templateId) continue; // 模板条目用导入时带的 ask
      const a = askOfTitle(e.title) || understand.detectAsk(String(e.title || '') + ' ' + (e.keywords || []).join(' '));
      if (a && a !== 'other' && e.ask !== a) { e.ask = a; changed = true; }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) {}
})();

// 模板升级：还没被商家确认过的模板条目，跟着模板文件走（避免旧【填写】文案残留）
(function migrateTemplates() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    for (const e of kb) {
      if (!e.templateId || !e.needsConfirm) continue;
      const t = kbTemplates.list().find((x) => x.id === e.templateId);
      if (!t) continue;
      if (e.answer !== t.answer || e.ask !== t.ask || e.priority !== t.priority) {
        e.answer = t.answer;
        e.keywords = t.keywords.slice();
        e.ask = t.ask;
        e.priority = t.priority;
        changed = true;
      }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) { /* 启动迁移失败不影响服务 */ }
})();

const cfg = store.getConfig();
      // 不回传 API Key 明文
      const safe = JSON.parse(JSON.stringify(cfg));
      if (safe.llm) safe.llm.apiKey = safe.llm.apiKey ? '******' : '';
      return send(res, 200, safe);
    }

    if (p === '/api/config' && req.method === 'POST') {
      const patch = await readBody(req);
      if (patch.llm && patch.llm.apiKey === '******') delete patch.llm.apiKey;
      const saved = await store.saveConfig(patch);
      return send(res, 200, { ok: true, config: { ...saved, llm: { ...saved.llm, apiKey: saved.llm.apiKey ? '******' : '' } } });
    }

    if (p === '/api/knowledge' && req.method === 'GET') {
      const storeId = url.searchParams.get('storeId');
      const includeGlobal = url.searchParams.get('includeGlobal') === '1';
      let list = store.getKnowledge().filter((x) => !x.archived);
      if (storeId) {
        // 本店条目；includeGlobal=1 时带上商家显式标记「整个工具」的模板（scope=tool）。
        // 默认不带：通用知识不参与店铺回答（ISS-001，logic-check K18 按默认口径断言）
        list = list.filter((x) => x.storeId === storeId || (includeGlobal && x.scope === 'tool'));
      }
      return send(res, 200, { ok: true, items: list });
    }

    if (p === '/api/knowledge' && req.method === 'POST') {
      const body = await readBody(req);
      let list = store.getKnowledge();
      if (Array.isArray(body.items)) {
        list = body.items;
      } else if (body.item) {
        const item = body.item;
        // 「整个工具」= scope:tool + storeId 空；只有显式标记才会跨店
        if (item.scope === 'tool') item.storeId = '';
        else if (!item.storeId && body.storeId) item.storeId = body.storeId;
        if (item.enabled === undefined) item.enabled = true;
        if (!Array.isArray(item.keywords)) item.keywords = String(item.keywords || '').split(/[,，、\s]+/).filter(Boolean);
        item.updatedAt = new Date().toISOString();
        item.id = item.id || 'kb_' + Date.now().toString(36);
        const idx = list.findIndex((x) => x.id === item.id);
        if (idx === -1) list.unshift(item);
        else list[idx] = item;
      }
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, count: list.length });
    }

    if (p === '/api/kb/templates') {
      const kb = store.getKnowledge();
      const byTpl = new Map(kb.filter((k) => k.templateId).map((k) => [k.templateId, k]));
      return send(res, 200, {
        ok: true,
        categories: kbTemplates.CATEGORIES,
        items: kbTemplates.list().map((t) => Object.assign({}, t, {
          imported: byTpl.has(t.id),
          enabled: byTpl.has(t.id) ? byTpl.get(t.id).enabled !== false : false,
        })),
      });
    }

    // 知识缺口：如果库里已经有对应 ask 的条目（模板已导入/已启用），这条待办就算完成
    const gapCovered = (ask) => {
      const kb = store.getKnowledge();
      return kb.some((k) => {
        if (k.ask === ask) return true;
        if (!k.templateId) return false;
        const t = kbTemplates.list().find((x) => x.id === k.templateId);
        return Boolean(t && t.ask === ask);
      });
    };

    if (p === '/api/kb/top-asks') {
      const u = new URL(req.url, 'http://localhost');
      const storeId = u.searchParams.get('storeId') || '';
      return send(res, 200, { ok: true, items: kbSuggest.topAsks(storeId, 6) });
    }

    if (p === '/api/kb/gaps') {
      const g = store.getGaps();
      const items = [];
      for (const [ask, v] of Object.entries(g)) {
        if (gapCovered(ask)) { await store.clearGap(ask); continue; }
        items.push({ ask, count: v.count, samples: v.samples || [], lastSeen: v.lastSeen });
      }
      items.sort((a, b) => b.count - a.count);
      return send(res, 200, { ok: true, items });
    }

    if (p === '/api/kb/gaps/clear' && req.method === 'POST') {
      const { ask } = await readBody(req);
      await store.clearGap(ask);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/kb/suggestions') {
      return send(res, 200, { ok: true, items: kbSuggest.suggest({ limit: 10, minCount: 2 }), missing: kbSuggest.missing(), important: kbSuggest.importantCoverage() });
    }

    if (p === '/api/kb/import' && req.method === 'POST') {
      const { ids } = await readBody(req);
      const kb = store.getKnowledge();
      const have = new Set(kb.map((k) => k.templateId).filter(Boolean));
      const titles = new Set(kb.map((k) => String(k.title || '').trim()).filter(Boolean));
      const conflicts = [];
      let added = 0;
      for (const id of ids || []) {
        const t = kbTemplates.decorate ? kbTemplates.find(id) : kbTemplates.find(id);
        if (!t || have.has(id) || titles.has(String(t.title).trim())) continue;
        // 同 ask 下触发词重叠 → 两个模板会打架，先不导入并告诉商家
        const meta = kbTemplates.list().find((x) => x.id === id) || {};
        const sameAsk = kb.filter((k) => (k.ask || 'other') === (meta.ask || 'other'));
        const clash = sameAsk.find((k) =>
          (k.keywords || []).some((ek) =>
            (t.keywords || []).some((tk) => ek === tk || (ek.length >= 3 && tk.includes(ek)) || (tk.length >= 3 && ek.includes(tk)))
          )
        );
        if (clash) {
          conflicts.push({ templateId: id, title: t.title, with: clash.title });
          continue;
        }
        kb.unshift({
          id: 'kb_' + Date.now().toString(36) + '_' + added,
          templateId: t.id,
          title: t.title,
          question: t.question,
          keywords: t.keywords.slice(),
          answer: t.answer,
          type: t.category === 'statement' ? 'statement' : t.category === 'general' ? 'general' : 'faq',
          ask: meta.ask || 'other',
          priority: meta.priority || 2,
          enabled: false,
          needsConfirm: true,
          source: 'template',
          updatedAt: new Date().toISOString(),
        });
        added++;
      }
      if (added) await store.saveKnowledge(kb);
      return send(res, 200, { ok: true, added, conflicts, total: kb.length, note: '已导入为停用，核对【】内容后启用' });
    }

    // 归档/恢复「通用知识」：没有 storeId 的老条目会串到所有店铺
    if (p === '/api/knowledge/archive-generic' && req.method === 'POST') {
      const { archive } = await readBody(req);
      const list = store.getKnowledge();
      let n = 0;
      for (const k of list) {
        // 只归档「无归属的通用知识」，不能连「整个工具」的模板一起归档
        if (k.storeId || k.scope === 'tool') continue;
        k.archived = !!archive;
        if (archive) k.enabled = false;
        n++;
      }
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, count: n });
    }

    // 跨店铺移植：把 A 店的知识复制到 B 店（同名跳过）
    if (p === '/api/knowledge/copy' && req.method === 'POST') {
      const { from, to } = await readBody(req);
      if (!from || !to || from === to) return send(res, 400, { ok: false, error: '店铺参数不对' });
      const list = store.getKnowledge();
      const src = list.filter((x) => x.storeId === from);
      const dstTitles = new Set(list.filter((x) => x.storeId === to).map((x) => x.title));
      let added = 0;
      for (const k of src) {
        if (dstTitles.has(k.title)) continue;
        list.push({ ...k, id: 'kb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), storeId: to, updatedAt: new Date().toISOString() });
        added++;
      }
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, added, total: src.length });
    }

    if (p === '/api/knowledge/delete' && req.method === 'POST') {
      const { id } = await readBody(req);
      const list = store.getKnowledge().filter((x) => x.id !== id);
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, count: list.length });
    }

    if (p === '/api/reply' && req.method === 'POST') {
      const reqStart = Date.now();
      const ctx = await readBody(req);
      // 给没有 ask 标签的老知识补分类：否则它会和模板条目一起参与“打平惩罚”，把置信度压下去
(function tagKnowledge() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    const askOfTitle = (t) => {
      const s = String(t || '');
      if (/发货/.test(s)) return 'shipping_time';
      if (/到货|时效/.test(s)) return 'arrival_time';
      if (/包邮|运费/.test(s)) return 'freight';
      if (/退换|退货/.test(s)) return 'return_policy';
      if (/不发芽|售后/.test(s)) return 'after_sale';
      if (/发票/.test(s)) return 'invoice';
      if (/支付|货到付款/.test(s)) return 'payment';
      if (/发芽率|种植|催芽|播种|温度/.test(s)) return 'usage';
      if (/规格/.test(s)) return 'spec';
      if (/议价/.test(s)) return 'nego';
      if (/有货|库存/.test(s)) return 'stock';
      return null;
    };
    for (const e of kb) {
      if (e.templateId) continue; // 模板条目用导入时带的 ask
      const a = askOfTitle(e.title) || understand.detectAsk(String(e.title || '') + ' ' + (e.keywords || []).join(' '));
      if (a && a !== 'other' && e.ask !== a) { e.ask = a; changed = true; }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) {}
})();

// 模板升级：还没被商家确认过的模板条目，跟着模板文件走（避免旧【填写】文案残留）
(function migrateTemplates() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    for (const e of kb) {
      if (!e.templateId || !e.needsConfirm) continue;
      const t = kbTemplates.list().find((x) => x.id === e.templateId);
      if (!t) continue;
      if (e.answer !== t.answer || e.ask !== t.ask || e.priority !== t.priority) {
        e.answer = t.answer;
        e.keywords = t.keywords.slice();
        e.ask = t.ask;
        e.priority = t.priority;
        changed = true;
      }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) { /* 启动迁移失败不影响服务 */ }
})();

const cfg = store.getConfig();
      const conversationId = ctx.conversationId || ctx.buyerName || 'unknown';
      const replyCache = global.__replyCache || (global.__replyCache = new Map());
      const lastBuyerText = (() => {
        const ms = (ctx.messages || []).filter((m) => m.role === 'buyer');
        return ms.length ? String(ms[ms.length - 1].text || '') : '';
      })();
      const cacheKey = [conversationId, lastBuyerText, (ctx.messages || []).length].join('|');
      const ok = ctx.mode === 'auto' || cfg.mode === 'auto' ? rateOk(cfg, conversationId) : true;

      // 去重：客户端监控/双击可能在 15 秒内重复请求同一句，直接返回上次结果，
      // 不再调模型、不再扣点，也不写日志（否则日志会被同一句刷屏）。
      const cachedReply = replyCache.get(cacheKey);
      if (cachedReply && Date.now() - cachedReply.ts < 15000) {
        const q = quotaStore.getQuota();
        const replay = { ...cachedReply.result, deduped: true, cost: 0, reason: '重复请求，已去重', quota: { balance: q.balance, cost: 0 } };
        // 重复请求绝不能再自动发一次
        if (replay.decision === 'auto_send') replay.decision = 'suggest';
        return send(res, 200, replay);
      }

      // 点卡制：余额扣不起任何一条就直接拒绝，不产出回复（也就没有价值可交付）。
      // 计费改成小数后，门槛不能再写死 1 点；0.001 是计费的最小粒度。
      const quota = quotaStore.getQuota();
      if (!(Number(quota.balance) >= 0.001)) {
        await store.addLog({ type: 'reply', conversationId, buyerName: ctx.buyerName, decision: 'handoff', reason: '点数不足', cost: 0 });
        return send(res, 200, {
          intent: '-',
          buyerText: '',
          risks: [],
          knowledge: [],
          decision: 'handoff',
          reason: '点数不足，请充值后再使用',
          confidence: 0,
          source: 'none',
          cost: 0,
          marginCost: 0,
          suggestions: [],
          latencyMs: 0,
          quota: { balance: quota.balance, cost: 0 },
        });
      }

      // 会话里记住的商品，作为"当前商品"传给引擎（说明书要用）
      const remembered = lastProductByConv.get(conversationId);
      if (remembered && (!ctx.goods || !ctx.goods.goodsId)) {
        ctx.goods = { ...(ctx.goods || {}), goodsId: remembered.goodsId, title: (ctx.goods && ctx.goods.title) || remembered.title };
      }

      // 超过窗口的早期对话压成一行，避免长会话“失忆”
      session.compact(ctx.storeId || 'default', conversationId, ctx.messages, understand.detectAsk);

      const attempt = getAttempt(conversationId);
      const kbForStore = (() => {
        const all = store.getKnowledge().filter((x) => !x.archived);
        if (!ctx.storeId) return all.filter((x) => !x.storeId); // 无店铺上下文（测试/接口）用通用
        // 本店条目 + 商家显式标记为「整个工具」的模板（scope=tool）
        // ISS-001 仍然成立：只有带 scope=tool 的条目才跨店；种子条目用的是 scope=global（历史命名），不参与跨店
        return all.filter((x) => x.storeId === ctx.storeId || x.scope === 'tool');
      })();
      const result = await engine.generate(ctx, cfg, kbForStore, { rateOk: ok, attempt });

      // 本地优先：只有在"没答案 / 不确定"时才走服务端模型
      const bcfg = cfg.backend || {};
      const engineMode = ctx.engine || cfg.engine || 'standard';

      // 计费口径（docs/07）：本地模板 0.5 点/条；模型回复按服务端返回的点数。
      // 文案里不出现成本与利润率——那两个数只存在服务端。
      const billingCfg = cfg.billing || {};
      const localPoints = Number.isFinite(Number(billingCfg.localPoints))
        ? Math.max(0, Number(billingCfg.localPoints))
        : 1;

      // Pro：先把「这一单知道什么」取成事实包，模型只拿事实，不拿一堆无关资料。
      // 取数只在配了服务端时做，本地能直接答的不会花这份算力。
      const factPack = engineMode === 'pro' && bcfg.url
        ? context.build({
            storeId: ctx.storeId,
            buyerText: result.buyerText || '',
            goods: ctx.goods,
            orders: ctx.orders || [],
            manual: (() => {
              const gid = (result.products && result.products[0] && result.products[0].goodsId) || (ctx.goods && ctx.goods.goodsId);
              if (gid) { const m = manuals.find(gid); if (m) return m; }
              const title = String((ctx.goods && ctx.goods.title) || '');
              if (!title) return null;
              return manuals.load().find((m) => m && m.title && (title.includes(m.title) || m.title.includes(title))) || null;
            })(),
            order: ctx.order || null,
            sessionGapMinutes: Number(ctx.sessionGapMinutes) || 0,
            products: productStore.forStore(ctx.storeId || ''),
            kb: kbForStore,
            messages: ctx.messages || [],
            profile: (cfg.businessHours && cfg.businessHours.start && cfg.businessHours.end)
              ? { hours: { start: natural.speakTime(cfg.businessHours.start), end: natural.speakTime(cfg.businessHours.end) } }
              : null,
          })
        : null;
      let factUsed = factPack
        ? { items: factPack.items, used: [], invalid: [], asks: factPack.route.asks, blocks: factPack.route.blocks }
        : null;
      if (factPack) {
        result.facts = {
          index: factPack.index || [],
          mode: factPack.route.mode,
          route: factPack.route,
          items: factPack.items,
          missing: factPack.missing,
          reference: factPack.reference || null,
          budget: factPack.budget,
          tokens: factPack.budget.tokens,
          registry: factPack.route.registry,
        };
        if (ctx.test && !factPack.route.registry
          && (factPack.route.mode !== 'normal' || factPack.missing.length)) {
          factRegistry.recordGap({
            buyerText: result.buyerText,
            asks: factPack.route.asks,
            mode: factPack.route.mode,
            trigger: factPack.route.widen && factPack.route.widen.trigger,
          });
        }
      }

      // 一句话问了多件事：单条模板只覆盖一件，Pro 一律交给模型逐条答（ISS-008）
      const multiIntent = Boolean(factPack && (factPack.route.multi || factPack.route.asks.length > 1));
      // 注册表说「必须有订单/说明书」，但事实包里没有 → 本地模板（发货时效）会答偏，必须交模型
      const regNeeds = factPack && factPack.route.registry ? factPack.route.registry.needs || [] : [];
      const regMissing = regNeeds.length > 0
        && regNeeds.some((b) => (factPack.missing || []).some((m) => m.block === b));
      // 注册表说这句话问的是「发没发」，引擎却理解成「什么时候发」——本地模板会答偏，交模型
      const regAsk = factPack && factPack.route.registry ? factPack.route.registry.ask : null;
      const regAskMismatch = Boolean(regAsk && result.understanding
        && result.understanding.ask && regAsk !== result.understanding.ask);
      const regForce = regMissing || regAskMismatch;
      // 事实包里有结构化规格，本地却拿「规格以商品页为准」糊弄 → 交模型用事实答
      const specFact = factPack && factPack.route.asks.includes('spec')
        && factPack.items.some((i) => i.block === 'product' && i.label === '规格');
      const factsOverride = Boolean(specFact);

      // 买家问了具体数值，本地候选没给出 → 不算本地命中，交模型用事实答
      const localDimsMissing = judge.missingDims(
        (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
        (result.understanding || {}).dims || [],
      );
      const lowLocal =
        localDimsMissing.length > 0 ||
        result.decision === 'fallback' ||
        (result.confidence || 0) < (bcfg.minConfidence || 0.82) ||
        result.ambiguous ||
        multiIntent ||
        regForce ||
        factsOverride;

      // 风险判定在前：投诉/索赔等高风险会话不走模型润色，保留安抚话术并转人工。
      // 否则模型给的候选会把 decision 改回 suggest，绕过复核队列。
      const highRisk = result.alert === 'high';
      // 商品目录/说明书是权威数据：本地已经从目录里答出来了，就不该再让模型覆盖成「以页面为准」
      // 多意图例外：单条模板只能答一件事，必须交给模型逐条覆盖（ISS-008）
      const authoritative = !multiIntent && !regForce && !factsOverride && (result.source === 'product' || result.source === 'manual' || result.orderClarify);
      // 一点依据都没有的事实类问题，模型只会编或只会说“查不到”，白白多等 1~2 秒
      // 事实包里的结构化事实（商品/说明书/订单/政策）也算依据：
      // 商品卡标题绑定出的规格、说明书分节，引擎的 knowledge/products 里是看不到的
      if (result.orderClarify && factPack && !factPack.items.some((i) => i.block === 'order')
          && Array.isArray(ctx.order && ctx.order.items) && ctx.order.items.length) {
        factPack.items.push({
          id: 'F' + (factPack.items.length + 1),
          block: 'order',
          label: '订单商品',
          text: '商品：' + ctx.order.items.map((x) => String(x.title || '')).filter(Boolean).join('、'),
          source: 'order',
        });
      }
      const factGround = Boolean(factPack && factPack.items.some((i) => ['order', 'product', 'manual', 'policy', 'general', 'profile'].includes(i.block)));
      const noGround = !(result.knowledge || []).length && !(result.products || []).length && !factGround;
      const askKey0 = (result.understanding || {}).ask;
      if (factPack && cfg.businessHours && cfg.businessHours.start && cfg.businessHours.end
          && !factPack.items.some((i) => i.block === 'profile')) {
        factPack.items.push({
          id: 'F' + (factPack.items.length + 1),
          block: 'profile',
          label: '客服在线时间',
          text: natural.hoursText(cfg.businessHours),
        });
      }
      const factualAsk = policy.SHOP_ASK.has(askKey0) || askKey0 === 'privacy';

      const willReplace = Boolean((result.understanding || {}).threat);
      // 上下文选择架构：Pro 默认把候选池交给模型，本地不再决定事实取舍
      const refundBuffer = !!(result.buffer && result.buffer.kind === 'refund');
      const contextFirst = engineMode === 'pro' && bcfg.url
        && factPack
        && ((factPack.stats && factPack.stats.orders > 0) || ((ctx.messages || []).length > 1))
        && (!result.buffer || (engineMode === 'pro' && refundBuffer)) && !highRisk && !willReplace
        && result.decision !== 'handoff'
        && askKey0 !== 'greeting' && askKey0 !== 'privacy';
      const localMatch0 = actionTemplates.matchLocal(result.buyerText);
      let callModel = contextFirst || (lowLocal && !result.orderClarify && !result.buffer && !highRisk && !authoritative && !willReplace && !(noGround && askKey0 === 'privacy') && result.decision !== 'handoff');
      if (localMatch0) callModel = false;
      if (bcfg.url && callModel) {
        const kbAll = store.getKnowledge();
        const hits = (result.knowledge || [])
          .map((k) => kbAll.find((x) => x.id === k.id))
          .filter(Boolean)
          .map((x) => ({ title: x.title, answer: x.answer }));

        const basePayload = {
          session: session.summary(ctx.storeId || 'default', conversationId),
          messages: ctx.messages,
          knowledge: hits,
          goods: ctx.goods,
          storeName: ctx.storeName,
          tone: result.tier,
          style: cfg.style,
          facts: factPack || undefined,
          persona: persona.system(),
          capabilities: actionTemplates.manifest(),
          profile: (cfg.businessHours && cfg.businessHours.start && cfg.businessHours.end)
            ? { hours: { start: natural.speakTime(cfg.businessHours.start), end: natural.speakTime(cfg.businessHours.end) } }
            : undefined,
        };
        let r = await backend.reply(cfg, basePayload);
        if (r && r.action) result.modelAction = r.action;
        let needInfo = null;
        if (r && r.ok && !(r.ask && r.ask.needed) && factPack && Array.isArray(r.need) && r.need.length) {
          const resolved = blockRegistry.resolve(factPack, r.need);
          if (resolved.items.length) {
            const ids = new Set([...(r.used || []), ...resolved.items.map((x) => x.id)]);
            const merged = [];
            const seen = new Set();
            (factPack.allItems || factPack.items).filter((x) => ids.has(x.id)).forEach((x) => { if (!seen.has(x.id)) { seen.add(x.id); merged.push(x); } });
            const secondPack = Object.assign({}, factPack, { items: merged.slice(0, 8), blocks: factPack.blocks });
            const r2 = await backend.reply(cfg, Object.assign({}, basePayload, { facts: secondPack, phase: 'answer' }));
            if (r2 && r2.ok) {
              const p1 = r.billing && Number(r.billing.points) || 0;
              const p2 = r2.billing && Number(r2.billing.points) || 0;
              r2.billing = Object.assign({}, r2.billing, { points: p1 + p2 });
              r2.ms = Number(r.ms || 0) + Number(r2.ms || 0);
              needInfo = { requested: r.need, resolved: resolved.items.map((x) => x.id), answerFacts: merged.map((x) => x.id), errors: resolved.errors };
              r = r2;
            }
          } else {
            needInfo = { requested: r.need, resolved: [], errors: resolved.errors };
          }
        }
        if (needInfo) result.needInfo = needInfo;
        if (r && r.target) result.target = r.target;
        if (r && r.action) result.modelAction = r.action;
        if (r && Array.isArray(r.claims)) result.claims = r.claims;

        // 兼容模型把块名当 ID：POLICY/PRODUCT/ORDER 映射到该块第一条，不当作假引用
        if (factPack && r && r.ok && Array.isArray(r.used)) {
          r.used = r.used.map((id) => {
            const key = String(id || '').toUpperCase();
            const block = key === 'POLICY' ? 'policy' : key === 'PRODUCT' ? 'product' : key === 'ORDER' ? 'order' : '';
            if (!block) return id;
            const hit = (factPack.allItems || factPack.items).find((x) => x.block === block);
            return hit ? hit.id : id;
          });
        }

        // 引用校验第一步：模型说它用了哪条，必须真的存在（假引用按无依据处理）
        if (factPack && r && r.ok) {
          const v = context.validateUsed({ ...factPack, items: factPack.allItems || factPack.items }, r.used || []);
          factUsed = {
            items: factPack.allItems || factPack.items,
            used: v.valid,
            invalid: v.invalid,
            asks: factPack.route.asks,
            blocks: factPack.route.blocks,
          };
          result.facts.used = v.valid;
          result.facts.invalidUsed = v.invalid;
          result.contract = answerContract.check({
            ask: (result.understanding || {}).ask,
            target: r.target || null,
            used: v.valid,
            facts: factPack,
            text: (r.candidates && r.candidates[0] && r.candidates[0].text) || '',
            orders: ctx.orders || [],
            buyerText: result.buyerText,
            claims: r.claims || [],

            reference: factPack.reference || null,
          });

          // 契约错配：带“问题属性对应的事实”重答一次；不是再加场景 guard
          if (!result.contract.ok && Array.isArray(r.candidates) && r.candidates.length
              && !(r.ask && r.ask.needed) && result.contract.expected.length) {
            const expected = new Set(result.contract.expected);
            const repairItems = (factPack.allItems || factPack.items)
              .filter((x) => (x.attrs || []).some((a) => expected.has(a)))
              .slice(0, 8);
            // 库存/规格题：把订单里的商品名/规格作为线索带上，避免模型说“店铺没这款”
            if (expected.has('product_stock') || expected.has('product_spec')) {
              let ci = 1;
              for (const o of (ctx.orders || [])) {
                for (const it of (o.items || [])) {
                  if (!it || !it.title) continue;
                  repairItems.push({ id: 'CI' + ci++, block: 'product', label: '订单商品线索', text: '买家买过：' + String(it.title).slice(0, 40) + (it.spec ? '；规格' + String(it.spec).slice(0, 30) : ''), entity: 'order:' + (o.orderNo || ''), attrs: [] });
                }
              }
            }
            const hasExpected = repairItems.some((x) => (x.attrs || []).some((a) => expected.has(a)));
            if (hasExpected) {
              const r2 = await backend.reply(cfg, Object.assign({}, basePayload, {
                facts: Object.assign({}, factPack, { items: repairItems, blocks: factPack.blocks }),
                phase: 'answer',
                repair: '上一版没有使用与当前问题属性匹配的事实。只回答以下属性对应内容：' + [...expected].join('/') + '；不要用其他属性替代，缺数据就请买家确认或给页面口径。',
              }));
              if (r2 && r2.ok && Array.isArray(r2.candidates) && r2.candidates.length) {
                const p1 = r.billing && Number(r.billing.points) || 0;
                const p2 = r2.billing && Number(r2.billing.points) || 0;
                r2.billing = Object.assign({}, r2.billing, { points: p1 + p2 });
                r2.ms = Number(r.ms || 0) + Number(r2.ms || 0);
                r = r2;
                if (r.target) result.target = r.target;
                const v2 = context.validateUsed({ ...factPack, items: factPack.allItems || factPack.items }, r.used || []);
                factUsed = {
                  items: factPack.allItems || factPack.items,
                  used: v2.valid,
                  invalid: v2.invalid,
                  asks: factPack.route.asks,
                  blocks: factPack.route.blocks,
                };
                result.facts.used = v2.valid;
                result.facts.invalidUsed = v2.invalid;
                result.contract = answerContract.check({
                  ask: (result.understanding || {}).ask,
                  target: r.target || null,
                  used: v2.valid,
                  facts: factPack,
                  text: (r.candidates && r.candidates[0] && r.candidates[0].text) || '',
                  orders: ctx.orders || [],
                  buyerText: result.buyerText,
                  claims: r.claims || [],

                  reference: factPack.reference || null,
                });
                result.factRepair = { issue: '属性错配', expected: [...expected], facts: repairItems.map((x) => x.id) };
              }
            }
          }
        }

        let backendAsk = null;
        if (r && r.ok && r.ask && r.ask.needed && r.ask.text && factPack) {
          const ids = new Set(factPack.items.map((i) => String(i.id)));
          const valid = (r.ask.ids || []).length > 0 && (r.ask.ids || []).every((id) => ids.has(String(id)));
          if (valid) {
            backendAsk = r.ask;
            result.suggestions = [{ tone: '标准', text: r.ask.text }];
            result.source = 'backend';
            result.reason = '模型选择先澄清';
            result.decision = 'suggest';
            result.clarify = true;
            result.ask = r.ask;
            result.confidence = r.confidence;
            const billPts = r.billing ? Number(r.billing.points) : NaN;
            result.cost = Number.isFinite(billPts) && billPts > 0 ? billPts : localPoints;
            result.costReason = 'model';
            result.billing = { points: result.cost, peak: Boolean(r.billing && r.billing.peak) };
            result.backendMs = r.ms;
          }
        }

        if (!backendAsk && r && r.ok && Array.isArray(r.candidates) && r.candidates.length) {
          const styled = [];
          for (const c of r.candidates) {
            const rw = await rewrite(c.text, cfg.style);
            if (rw.remaining.some((i) => i.severity === 'high')) continue;
            // 模型的事实短句同样补温度（不改变数字/否定）
            styled.push({ tone: c.tone || '标准', text: natural.speakTime(warm(rw.text, { ask: (result.understanding || {}).ask, tier: result.tier, serious: /退款|退货|售后|投诉|赔付|质检|报告/.test(rw.text) || ['after_sale', 'return_policy'].includes((result.understanding || {}).ask) })) });
          }
          // 服务端返回的候选同样要过本地敏感词闸——服务端不可信，闸门必须在自己手里
          const screened = styled.filter((c) => sensitive.check(c.text, cfg.forbiddenOutput).ok);
          if (screened.length !== styled.length) {
            result.backendBlocked = styled.filter((c) => !sensitive.check(c.text, cfg.forbiddenOutput).ok).map((c) => c.text);
          }
          if (screened.length && !highRisk) {
            result.suggestions = screened;
            result.confidence = r.confidence;
            result.source = 'backend';
            result.reason = '本地不确定，已调用服务端模型';
            result.decision = 'suggest';
            // 模型回复按服务端算出的点数扣（成本×利润率÷点单价），客户端拿不到成本
            const billPts = r.billing ? Number(r.billing.points) : NaN;
            result.cost = Number.isFinite(billPts) && billPts > 0 ? billPts : localPoints;
            result.costReason = 'model';
            result.marginCost = 0;
            result.billing = { points: result.cost, peak: Boolean(r.billing && r.billing.peak) };
            result.backendMs = r.ms;
          }
        } else if (r && r.error) {
          result.backendError = r.error;
        }
      }

      // 会话级商品：记住上一轮匹配到的商品；问价格时直接报价，而不是答"以商品页为准"
      const lastProduct = lastProductByConv.get(conversationId);
      if (result.products && result.products.length) {
        lastProductByConv.set(conversationId, result.products[0]);
      } else if (result.intent === 'price' && lastProduct) {
        const hasPrice = (result.suggestions || []).some((x) => x.text.includes(String(lastProduct.price)));
        if (!hasPrice) {
          result.suggestions = [
            { tone: '标准', text: `${lastProduct.title}，${lastProduct.price} 元一袋，直接拍就行。` },
            { tone: '简短', text: `${lastProduct.price} 元一袋。` },
          ];
          result.source = 'product';
          result.reason = '沿用本会话上一轮匹配到的商品报价';
          result.confidence = 0.9;
          result.decision = 'suggest';
          result.cost = 1;
          result.costReason = 'answer';
          result.marginCost = 0;
        }
      }

      // 出厂质检：对题吗？站得住商家立场吗？到底有没有结论？
      // 放在计费之前——没答上就不该扣点，也不该作为高置信度候选发出去。
      let judgeAction = '';
      if (result.decision !== 'handoff' && result.alert !== 'high' && (result.suggestions || []).length) {
        // 本地/模型都没给出候选（例如无服务端、或本地只允许四个模板）：先给兜底，别让空候选进质检
        if (!(result.suggestions || []).length) {
          const ask0 = (result.understanding || {}).ask;
          const fb0 = policy.pickFallback({ risks: result.risks, intent: result.intent, attempt, ask: ask0, capabilities: cfg.capabilities || {} });
          const offtopicText = ask0 === 'other' && !(result.knowledge || []).length && !(result.products || []).length
            ? '这个信息以页面显示为准哈，商品和订单的问题您随时问我。'
            : '';
          result.suggestions = [{ tone: '兜底', text: engine.applySalutation(offtopicText || fb0.text, cfg, !(ctx.messages || []).some((m) => m.role === 'seller')) }];
          result.decision = 'fallback';
          result.source = 'policy';
          result.confidence = 0.3;
          result.cost = 1;
          result.costReason = 'fallback';
          result.reason = '没有可用候选，给兜底话术';
        }

        const guardHit = answerGuard.guard({
          ask: (result.understanding || {}).ask,
          buyerText: result.buyerText,
          text: (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
          orders: ctx.orders || [],
          facts: factUsed,
        });
        if (guardHit) {
          result.suggestions = [{ tone: '标准', text: guardHit.text }];
          result.source = 'guard';
          result.reason = guardHit.reason;
          result.guard = guardHit.reason;
          result.decision = 'suggest';
          result.clarify = /[？?]/.test(guardHit.text);
        }

        const verdict = judge.review({
          buyerText: result.buyerText,
          understanding: result.understanding,
          intent: result.intent,
          suggestions: result.suggestions,
          risks: result.risks || [],
          knowledge: result.knowledge || [],
          products: result.products || [],
          buffer: result.buffer || null,
          capabilities: cfg.capabilities || {},
          facts: factUsed,
          clarify: Boolean(result.clarify || result.orderClarify),
        });
        judgeAction = verdict.action;
        const firstReply = !(ctx.messages || []).some((m) => m.role === 'seller');
        // 本地答案被质检拒绝，也是路由/事实缺口：记下来，别只统计 wide/empty
        if (ctx.test && verdict.action !== 'keep' && result.source !== 'backend') {
          factRegistry.recordGap({
            buyerText: result.buyerText,
            asks: (factPack && factPack.route.asks) || [(result.understanding || {}).ask].filter(Boolean),
            mode: (factPack && factPack.route.mode) || 'local',
            trigger: 'judge:' + (verdict.issues || []).join(','),
          });
        }
        if (verdict.action === 'replace') {
          // 只剔句子（cleaned）时保留原来源，别把本地知识说成 policy；
          // 整段换模板才算 policy。
          const kept = (verdict.cleanedList || []).filter(Boolean);
          const partial = kept.length > 0;
          // 关切类问题（安全/凭证/地域）被整段换掉时，用贴题的关切口径，别用通用道歉
          const concernText2 =
            !partial && !(result.risks || []).length && ['safety', 'evidence', 'region'].includes((require('./concerns').detect(result.buyerText || '') || {}).key)
              ? require('./concerns').fallbackText(result.buyerText || '')
              : '';
          const text = partial ? null : concernText2 || policy.merchantReply(verdict.replyKind, { capabilities: cfg.capabilities || {} });
          const seen = new Set();
          result.suggestions = partial
            ? kept
                .map((t) => engine.applySalutation(t, cfg, firstReply))
                .filter((t) => {
                  const key = t.replace(/[。！？!?\s]+$/, '');
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .map((t) => ({ tone: '兜底', text: t }))
            : [{ tone: '兜底', text: engine.applySalutation(text, cfg, firstReply) }];
          result.decision = 'suggest';
          result.confidence = partial ? Math.min(result.confidence == null ? 0.85 : result.confidence, 0.9) : 0.6;
          result.cost = 1;
          result.costReason = 'rewrite';
          result.marginCost = 0;
          result.source = partial ? result.source || 'rule' : 'policy';
          result.reason = verdict.reason;
          result.judge = verdict.issues;
        } else if (verdict.action === 'fallback') {
          const ask = (result.understanding || {}).ask;
          const issueSet = verdict.issues || [];
          const isGap = (issueSet.includes('无依据') || issueSet.includes('数字无依据') || issueSet.includes('单位不一致')) && policy.SHOP_ASK.has(ask);
          const fb = policy.pickFallback({ risks: result.risks, intent: result.intent, attempt, ask: (result.understanding || {}).ask, noContext: true, offtopic: ((result.understanding || {}).ask === 'other' && !(result.knowledge || []).length && !(result.products || []).length && !(ctx.goods && ctx.goods.title)), capabilities: cfg.capabilities || {} });
          const concernText = require('./concerns').fallbackText(result.buyerText || '');
          const neg = issueSet.includes('替商家否定');
          const negText = neg && policy.SHOP_ASK.has(ask) ? policy.publicFallback(ask, result.buyerText || '') : '';
          const unitIssue = issueSet.includes('单位不一致') || issueSet.includes('数字无依据');
          const unitText = unitIssue
            ? policy.publicFallback(policy.SHOP_ASK.has(ask) ? ask : 'spec', result.buyerText || '')
            : '';
          const askGap = policy.SHOP_ASK.has(ask) && !result.buffer;
          const fbText = concernText || negText || unitText || (askGap || isGap ? policy.publicFallback(ask, result.buyerText || '') : fb.text);
          result.suggestions = [{ tone: '兜底', text: engine.applySalutation(fbText, cfg, firstReply) }];
          result.decision = 'fallback';
          result.confidence = 0.3;
          result.cost = 1;
          result.costReason = 'rewrite';
          result.marginCost = 0;
          result.source = 'policy';
          result.reason = verdict.reason;
          result.fallback = { level: fb.level, attempt: fb.attempt };
          result.judge = verdict.issues;
          result.cost = 1; // 已产出一条可发送的兜底回复，照常计费
          result.costReason = 'fallback';
        } else if (verdict.action === 'hold') {
          result.confidence = Math.min(result.confidence == null ? 0.6 : result.confidence, verdict.confidenceCap || 0.45);
          result.cost = 1;
          result.costReason = 'hold';
          result.marginCost = 0;
          result.reason = verdict.reason;
          result.judge = verdict.issues;
        }
      }

      // 店铺事实且库里没有：模型答了也不能用（会编），统一换成公开口径
      if (!result.orderClarify && noGround && policy.SHOP_ASK.has(askKey0) && !result.buffer) {
        const firstReply = !(ctx.messages || []).some((m) => m.role === 'seller');
        result.suggestions = [{ tone: '兜底', text: engine.applySalutation(policy.publicFallback(askKey0, result.buyerText || ''), cfg, firstReply) }];
        result.decision = 'fallback';
        result.reason = '知识缺口：按公开口径回答，并提示商家补录';
        result.confidence = 0.3;
        result.source = 'policy';
        result.cost = 1; // 已产出一条可发送的兜底回复，照常计费
        result.costReason = 'fallback';
      }

      // 港澳台/海外：没有配送口径，就让买家自己在下单页确认，不编"能发/不能发"，也不转人工
      const cRegion = require('./concerns').detect(result.buyerText || '');
      if (cRegion && cRegion.key === 'region' && !(result.knowledge || []).length && result.decision !== 'auto_send') {
        result.decision = 'suggest';
        result.confidence = 0.7;
        result.reason = '港澳台/海外配送：引导买家在下单页确认地址';
        result.source = 'policy';
        result.cost = 1;
        result.suggestions = [{
          tone: '兜底',
          text: engine.applySalutation('能不能送到，您先把收货地址填到下单页，看能不能选到哈。', cfg, !(ctx.messages || []).some((m) => m.role === 'seller')),
        }];
      }

      // 模型回复也服务用户：过质检 + 白名单 + 非风险，才允许自动发
      const autoMode = ctx.mode === 'auto' || cfg.mode === 'auto';
      if (autoMode && cfg.autoModel === true
          && result.source === 'backend' && result.decision === 'suggest'
          && judgeAction === 'keep' && !(result.judge || []).length
          && !result.buffer && !highRisk && !result.threat && !(result.risks || []).length
          && ok && engine.inBusinessHours(cfg)
          && (result.suggestions || []).length) {
        result.decision = 'auto_send';
        result.reason = '模型回复通过质检，自动发送';
        result.autoModel = true;
      }

      // 知识缺口：买家问过、库里没有的店铺事实，记成商家待办
      const gapAsk = (result.understanding || {}).ask;
      const gapHit = (result.knowledge || []).length > 0 || (result.products || []).length > 0;
      const isGap = policy.SHOP_ASK.has(gapAsk) && (!gapHit || (result.judge || []).includes('无依据'));
      if (isGap) {
        store.addGap(gapAsk, result.buyerText).catch(() => {});
        result.knowledgeGap = gapAsk;
      }

      // 商品域边界：非种子商品不得输出种子/种植口径
      const gtitle = String((ctx.goods && ctx.goods.title) || '');
      const nonSeedGoods = gtitle && !/种子|籽|种苗|育苗|菜种|花种|萝卜|番茄|生菜|辣椒|黄瓜|南瓜|玉米/.test(gtitle);
      const hasDomainFact = !!(factPack && (factPack.allItems || factPack.items || []).some((x) => x.id === 'D1'));
      if (result.suggestions && result.suggestions[0] && (nonSeedGoods || hasDomainFact)
          && /浸种|催芽|露白|播种|土壤|育苗|泡种/.test(result.suggestions[0].text || '')) {
        result.suggestions = [{ tone: '标准', text: '这款是用品，不是种子，催芽/种植方法不适用；具体使用方式以商品页说明为准。' }];
        result.source = 'domain';
        result.reason = '非种子商品不使用种子口径';
        result.decision = 'suggest';
      }

      // 最终契约复核：judge/guard 之后文本可能被替换，必须按最终文本再验一次
      if (factPack && result.suggestions && result.suggestions[0]) {
        const finalContract = answerContract.check({
          ask: (result.understanding || {}).ask,
          target: result.target || null,
          claims: result.claims || [],
          reference: factPack.reference || null,
          used: (result.facts && result.facts.used) || [],
          facts: factPack,
          text: result.suggestions[0].text || '',
          orders: ctx.orders || [],
          buyerText: result.buyerText,
        });
        result.contract = finalContract;
        if (finalContract.ok && finalContract.expected.length) {
          const cleaned = answerContract.sanitize(result.suggestions[0].text || '', finalContract);
          if (cleaned && cleaned !== result.suggestions[0].text) {
            result.suggestions[0].text = cleaned;
            result.contract = answerContract.check({
              ask: (result.understanding || {}).ask, target: null,
              used: (result.facts && result.facts.used) || [], facts: factPack,
              text: cleaned, orders: ctx.orders || [], buyerText: result.buyerText,
            });
          }
        }
        if (!result.contract.ok && result.contract.expected && result.contract.expected.length) {
          result.suggestions = [{ tone: '标准', text: answerContract.safeText(finalContract, factPack && factPack.reference) }];
          result.source = 'contract';
          result.reason = '最终文本属性不匹配：' + (finalContract.issues || []).join('、');
          result.contractFallback = true;
          result.decision = 'suggest';
          result.clarify = /[？?]/.test(result.suggestions[0].text);
        }
      }

      // 契约兜底：重答后仍属性错配，不发错误属性
      if (result.contract && !result.contract.ok && result.contract.expected && result.contract.expected.length) {
        const safe = answerContract.safeText(result.contract, factPack && factPack.reference);
        result.suggestions = [{ tone: '标准', text: safe }];
        result.source = 'contract';
        result.reason = '属性不匹配：' + (result.contract.issues || []).join('、');
        result.contractFallback = true;
        result.decision = 'suggest';
        result.clarify = /[？?]/.test(safe);
      }

      // 最终守卫：judge fallback 也不能把已退款单改成通用页面
      const finalGuard = answerGuard.guard({
        ask: (result.understanding || {}).ask,
        buyerText: result.buyerText,
        text: (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
        orders: ctx.orders || [],
        facts: factUsed,
      });
      if (finalGuard) {
        result.suggestions = [{ tone: '标准', text: finalGuard.text }];
        result.source = 'guard';
        result.reason = finalGuard.reason;
        result.guard = finalGuard.reason;
        result.decision = 'suggest';
        result.clarify = /[？?]/.test(finalGuard.text);
      }

      // 专业人感：严肃场景去掉轻快句末语气词，不改事实
      if (Array.isArray(result.suggestions)) {
        result.suggestions = result.suggestions.map((x) => ({ ...x, text: professionalTone(x.text) }));
      }

      // 模型决定下一步动作；本地只校验/补计划。正则仅在后端不可用时兜底
      try {
        const ma = result.modelAction;
        const refundInfo = /退款|退货|售后|退钱/.test(result.buyerText) && /怎么|如何|能退吗|可以退吗|退款流程|退款多久|退货规则|怎么申请/.test(result.buyerText);
        const localMatch = actionTemplates.matchLocal(result.buyerText);
        let plan = null;
        if (refundInfo) {
          result.suggestions = [{ tone: '标准', text: '在订单页找到这笔订单，点「申请退款」，按提示选择退款类型和原因提交即可。' }];
          result.source = 'policy';
          result.reason = '退款咨询，不触发退款动作';
          result.decision = 'suggest';
        } else if (localMatch && localMatch.template === 'invite') {
          const p = actionTemplates.invite.fromModel({}, { product: (result.products && result.products[0]) || null });
          plan = { kind: 'invite', product: p.product, spec: p.spec, needs: p.needs, canAuto: false, reason: '本地邀请模板命中' };
        } else if (localMatch && localMatch.template === 'refund') {
          const p = actionTemplates.refund.fromModel({}, { orders: ctx.orders || [], order: ctx.order, buyerText: result.buyerText });
          plan = { kind: 'refund', plan: p, needs: p.needs, canAuto: p.canAuto, reason: '本地退款模板命中' };
        } else if (ma && ma.kind === 'refund') {
          const p = actionTemplates.refund.fromModel(ma, {
            orders: ctx.orders || [], order: ctx.order, buyerText: result.buyerText,
          });
          plan = { kind: 'refund', plan: p, needs: p.needs, canAuto: p.canAuto, reason: '模型选择退款模板' };
        } else if (ma && ma.kind === 'invite') {
          const product = (result.products && result.products[0]) || (ctx.goods && ctx.goods.title ? { title: ctx.goods.title, goodsId: ctx.goods.goodsId } : null);
          const p = actionTemplates.invite.fromModel({ ...ma, product }, { product, spec: ma.spec });
          plan = { kind: 'invite', product: p.product, spec: p.spec, needs: p.needs, canAuto: p.canAuto, reason: '模型选择邀请模板' };
        } else if (ma && ma.kind === 'ask' && ma.ask) {
          result.suggestions = [{ tone: '标准', text: ma.ask }];
          result.source = 'action';
          result.reason = '模型先追问动作所需信息';
          result.decision = 'suggest';
        } else if (!ma && result.source !== 'backend') {
          plan = actionRouter.plan({
            buyerText: result.buyerText, messages: ctx.messages || [], order: ctx.order || (ctx.orders && ctx.orders[0]) || null,
            orders: ctx.orders || [], product: (result.products && result.products[0]) || null,
            spec: (ctx.order && ctx.order.items && ctx.order.items[0] && ctx.order.items[0].spec) || '',
          });
        }
        if (plan) {
          result.action = plan;
          if (plan.kind === 'invite') {
            const needs = plan.needs || [];
            if (needs.length) {
              result.suggestions = [{ tone: '标准', text: '您要哪款商品、什么规格呢？我帮您加到邀请清单。' }];
              result.source = 'action';
              result.reason = '邀请前补齐商品/规格';
              result.decision = 'suggest';
            }
          }
          if (plan.kind === 'refund' && result.suggestions && result.suggestions[0]) {
            if (plan.canAuto) {
              result.suggestions = [{ tone: '标准', text: '这边帮您申请' + (plan.plan.typeName || '退款') + '，请在下方卡片里确认一下。' }];
              result.reason = '买家明确退款，已生成申请';
            } else if ((plan.plan.missing || []).includes('order') && (ctx.orders || []).length > 1) {
              result.suggestions = [{ tone: '标准', text: '您问的是哪一单呀？我帮您核对订单后申请退款。' }];
              result.reason = '退款前确认订单';
            } else if ((plan.plan.missing || []).includes('reason')) {
              result.suggestions = [{ tone: '标准', text: '您是遇到什么问题了吗？我帮您申请退款。' }];
              result.reason = '退款前确认原因';
            } else if ((plan.plan.missing || []).includes('received')) {
              result.suggestions = [{ tone: '标准', text: '您收到货了吗？确认后我帮您申请退款。' }];
              result.reason = '退款前确认收货状态';
            }
            result.source = 'action';
            result.decision = 'suggest';
          }
        }
      } catch (_) {}

      // 未支付订单：不能退款，直接告知取消订单，不生成退款动作
      const orderForUnpaid = ctx.order || (ctx.orders && ctx.orders[0]) || null;
      if (orderForUnpaid && /待支付/.test(String(orderForUnpaid.status || ''))
          && /退款|退下款|退个款|不想要|买错/.test(result.buyerText || '')) {
        result.suggestions = [{ tone: '标准', text: '这单还未支付，不需要退款，您可以直接取消订单。' }];
        result.source = 'policy';
        result.reason = '未支付订单无需退款';
        result.decision = 'suggest';
        result.action = null;
      }

      // 会话状态：记下这一轮聊了什么、答了什么，供下一轮与模型参考
      result.sessionSummary = session.summary(ctx.storeId || 'default', conversationId);
      session.update(ctx.storeId || 'default', conversationId, {
        topic: (result.understanding || {}).ask || '',
        goods: (result.products && result.products[0] && result.products[0].title) || '',
        reply: (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
      });

      // 多轮焦点：短追问优先简短候选；复读换候选或加引导语
      const f = focus.adjust(result.suggestions, ctx.messages, result.buyerText);
      result.suggestions = f.suggestions;
      if (f.note) result.focusNote = f.note;

      // 本地模板/兜底：统一按配置的点数（默认 0.5）。
      // 例外：模型已调用但被质检换成兜底时，成本已经发生——按「本地价与模型价取高」扣，
      // 保证既不会为兜底收模型的钱，也不会出现长回答亏本。
      if (result.cost > 0 && result.source !== 'backend') {
        const billPts = result.billing ? Number(result.billing.points) : NaN;
        result.cost = Number.isFinite(billPts) && billPts > localPoints ? billPts : localPoints;
        result.costReason = result.costReason || 'local';
      }

      let billed = null;
      if (result.cost > 0) {
        billed = quotaStore.consume(result.cost, 'reply:' + (ctx.buyerName || 'anony'), ctx.requestId);
        if (!billed.ok) {
          // 扣不起就不交付：不能既不给点数、又把可发送回复给出去
          result.suggestions = [];
          result.decision = 'handoff';
          result.reason = '点数不足：本条未扣点，也不产出回复';
          result.cost = 0;
        }
      }
      result.quota = { balance: billed ? billed.balance : quota.balance, cost: result.cost };

      const lowPoints = (cfg.alerts && cfg.alerts.rules && cfg.alerts.rules.lowPoints) || 50;
      if (result.quota.balance < lowPoints) {
        alerts.notify({
          rule: 'low_points',
          level: 'normal',
          storeId: ctx.storeId,
          storeName: ctx.storeName,
          title: '点数不足（剩余 ' + result.quota.balance + '）',
          detail: '请及时充值，否则会停止服务',
        }).catch(() => {});
      }

      if (result.decision === 'fallback' && !ctx.test) {
        bumpAttempt(conversationId);

        // 预警：商家不在电脑前时，面板红点等于没有
        const rules = (cfg.alerts && cfg.alerts.rules) || {};
        const streak = attempt + 1;
        const baseEvent = {
          storeId: ctx.storeId,
          storeName: ctx.storeName,
          conversationId,
          buyerText: result.buyerText,
          level: 'high',
        };
        if (!ctx.test && rules.complaint !== false && result.alert === 'high') {
          alerts.notify({ ...baseEvent, rule: 'complaint', title: '投诉/索赔会话，需人工接手' }).catch(() => {});
        }
        if (!ctx.test && streak >= (rules.consecutiveFallback || 3)) {
          alerts.notify({
            ...baseEvent,
            rule: 'consecutive_fallback',
            title: '连续 ' + streak + ' 次无法回答',
            detail: '建议补充知识库，否则会一直兜底',
          }).catch(() => {});
        }
        await store.pushReview({
          conversationId,
          buyerName: ctx.buyerName,
          reason: result.reason,
          buyerText: result.buyerText,
          intent: result.intent,
          type: 'fallback',
          alert: result.alert || 'normal',
          fallbackLevel: result.fallback && result.fallback.level,
        });
      } else if (result.decision === 'handoff') {
        await store.pushReview({ conversationId, buyerName: ctx.buyerName, reason: result.reason, buyerText: result.buyerText, intent: result.intent });
      } else {
        resetAttempt(conversationId);
      }
      if (ctx.log !== false) {
        await store.addLog({
          type: 'reply',
          conversationId,
          buyerName: ctx.buyerName,
          storeId: ctx.storeId || '',
          buyerText: result.buyerText,
          decision: result.decision,
          source: result.source,
          confidence: result.confidence,
          intent: result.intent,
          cost: result.cost,
          costReason: result.costReason || '',
          ask: (result.understanding || {}).ask || '',
          test: Boolean(ctx.test),
          marginCost: result.marginCost || 0,
          replyText: (result.suggestions && result.suggestions[0] && result.suggestions[0].text) || '',
          latencyMs: result.latencyMs,
          // Pro 指标分开记：事实包大小、命中块、引用合法率（docs/34 五）
          factTokens: result.facts ? result.facts.tokens : undefined,
          factBlocks: result.facts ? (result.facts.route.blocks || []).join('+') : undefined,
          factUsed: result.facts && result.facts.used ? result.facts.used.length : undefined,
          factInvalid: result.facts && result.facts.invalidUsed ? result.facts.invalidUsed.length : undefined,
          factMode: result.facts ? result.facts.mode : undefined,
          factItems: result.facts && result.facts.items ? result.facts.items.length : undefined,
          factMissing: result.facts && result.facts.missing ? result.facts.missing.map((m) => m.block).join('+') : undefined,
          factRegistry: result.facts ? (result.facts.registry ? result.facts.registry.id : '') : undefined,
          factWiden: result.facts && result.facts.route && result.facts.route.widen
            ? result.facts.route.widen.trigger
            : undefined,
          engine: engineMode,
          totalMs: Date.now() - reqStart,
        });
      }
      replyCache.set(cacheKey, { ts: Date.now(), result });
      if (replyCache.size > 200) {
        for (const k of [...replyCache.keys()].slice(0, replyCache.size - 200)) replyCache.delete(k);
      }
      return send(res, 200, result);
    }

    // 事实包预览：这句话本地会取哪几块、有没有扩召回（不调模型、不扣点）
    if (p === '/api/facts/preview' && req.method === 'POST') {
      const body = await readBody(req);
      const storeId = body.storeId || '';
      const kb = store.getKnowledge().filter((x) => !x.archived
        && (!storeId || x.storeId === storeId || x.scope === 'tool'));
      const pack = context.build({
        goods: body.goods || {},
        products: Array.isArray(body.products) ? body.products : [],
        kb,
        storeId,
        orders: Array.isArray(body.orders) ? body.orders : (body.order ? [body.order] : []),
        messages: Array.isArray(body.messages) ? body.messages : [],
        manual: body.manual || null,
        profile: (cfg.businessHours && cfg.businessHours.start && cfg.businessHours.end)
          ? { hours: { start: cfg.businessHours.start, end: cfg.businessHours.end } }
          : null,
      });
      return send(res, 200, { ok: true, pack });
    }

    // 路由注册表：可增长、可停用；测试时记录缺口
    if (p === '/api/facts/registry' && req.method === 'GET') {
      const data = factRegistry.load();
      return send(res, 200, {
        ok: true,
        entries: data.entries,
        gaps: factRegistry.loadGaps().filter((g) => g.status === 'open'),
      });
    }

    if (p === '/api/facts/registry' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const entry = factRegistry.upsert(body.entry || body);
        return send(res, 200, { ok: true, entry });
      } catch (e) {
        return send(res, 400, { ok: false, error: String(e.message || e) });
      }
    }

    if (p === '/api/facts/registry/disable' && req.method === 'POST') {
      const { id } = await readBody(req);
      const done = factRegistry.disable(String(id || ''));
      return send(res, done ? 200 : 404, { ok: done });
    }

    if (p === '/api/facts/registry/gaps/dismiss' && req.method === 'POST') {
      const { key } = await readBody(req);
      const done = factRegistry.dismissGap(String(key || ''));
      return send(res, done ? 200 : 404, { ok: done });
    }

    // 让模型提议一条注册表条目（一次调用，不扣商家点数；只用于测试/维护）
    if (p === '/api/facts/registry/analyze' && req.method === 'POST') {
      const { buyerText } = await readBody(req);
      if (!buyerText) return send(res, 400, { ok: false, error: '缺少 buyerText' });
      const allCfg = store.getConfig();
      if (!allCfg.backend || !allCfg.backend.url) return send(res, 200, { ok: false, error: '未配置服务端模型' });
      const r = await backend.registryAnalyze(allCfg, buyerText);
      if (!r || !r.ok) return send(res, 200, { ok: false, error: (r && r.error) || '分析失败' });
      return send(res, 200, { ok: true, proposal: r.proposal, ms: r.ms });
    }

    if (p === '/api/backend/test') {
      const b = store.getConfig().backend || {};
      if (!b.url) return send(res, 200, { ok: false, error: '未配置服务端地址' });
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(String(b.url).replace(/\/+$/, '') + '/health', { signal: ctrl.signal });
        clearTimeout(timer);
        const d = await r.json().catch(() => ({}));
        return send(res, 200, { ok: r.ok, health: d });
      } catch (e) {
        return send(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (p === '/api/alerts/test' && req.method === 'POST') {
      const { channels } = await readBody(req);
      const list = Array.isArray(channels) && channels.length ? channels : (store.getConfig().alerts || {}).channels || [];
      if (!list.length) return send(res, 400, { ok: false, error: '没有配置通道' });
      const results = await alerts.test(list);
      return send(res, 200, { ok: results.some((r) => r.ok), results });
    }

    if (p === '/api/alerts/log') {
      const items = store.getLogs(200).filter((x) => x.type === 'alert');
      return send(res, 200, { ok: true, items });
    }

    if (p === '/api/templates' && req.method === 'GET') {
      try {
        const raw = fs.readFileSync(path.join(ROOT, 'data', 'seed', 'templates.json'), 'utf8');
        return send(res, 200, { ok: true, items: JSON.parse(raw) });
      } catch (e) {
        return send(res, 200, { ok: true, items: [] });
      }
    }

    if (p === '/api/templates/apply' && req.method === 'POST') {
      const { ids } = await readBody(req);
      const wanted = new Set(Array.isArray(ids) ? ids : []);
      let tpl = [];
      try {
        tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed', 'templates.json'), 'utf8'));
      } catch (_) {}
      const list = store.getKnowledge();
      let added = 0;
      for (const t of tpl) {
        if (!wanted.has(t.id)) continue;
        if (list.some((k) => k.id === t.id)) continue;
        list.push({
          id: t.id,
          title: t.title,
          question: t.question,
          keywords: t.keywords,
          answer: t.answer,
          tags: t.tags,
          type: t.category === 'statement' ? 'statement' : t.category === 'general' ? 'general' : 'faq',
          ask: meta.ask || 'other',
          priority: meta.priority || 2,
          source: 'template',
          enabled: true,
        });
        added++;
      }
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, added, count: list.length });
    }

    if (p === '/api/manuals' && req.method === 'GET') {
      let items = manuals.load();
      const goodsId = url.searchParams.get('goodsId');
      const storeId = url.searchParams.get('storeId');
      if (goodsId) items = items.filter((x) => String(x.goodsId) === goodsId);
      if (storeId) items = items.filter((x) => !x.storeId || x.storeId === storeId);
      return send(res, 200, { ok: true, items });
    }

    if (p === '/api/manuals' && req.method === 'POST') {
      const body = await readBody(req);
      const list = manuals.load();
      if (body.item && body.item.goodsId) {
        const it = body.item;
        if (!it.storeId) it.storeId = body.storeId || '';
        it.updatedAt = new Date().toISOString();
        const idx = list.findIndex((x) => String(x.goodsId) === String(it.goodsId));
        if (idx === -1) list.push(it);
        else list[idx] = it;
        manuals.save(list);
        return send(res, 200, { ok: true, count: list.length });
      }
      if (Array.isArray(body.items)) {
        manuals.save(body.items);
        return send(res, 200, { ok: true, count: body.items.length });
      }
      return send(res, 400, { ok: false, error: '缺少 item 或 items' });
    }

    if (p === '/api/products' && req.method === 'GET') {
      const storeId = url.searchParams.get('storeId') || '';
      const all = url.searchParams.get('all') === '1';
      return send(res, 200, {
        ok: true,
        items: all ? productStore.load() : (storeId ? productStore.forStore(storeId) : []),
      });
    }

    // 客户端自动同步商品（来自商家后台商品列表页）
    if (p === '/api/products/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const storeId = String(body.storeId || 'real');
      const rows = Array.isArray(body.items) ? body.items : [];
      if (!rows.length) {
        if (body.confirmEmpty === true) {
          const all = productStore.load();
          const kept = all.filter((x) => x.storeId !== storeId);
          productStore.save(kept);
          return send(res, 200, { ok: true, cleared: true, storeId, removed: all.length - kept.length, syncedAt: new Date().toISOString() });
        }
        return send(res, 200, { ok: true, skipped: 'empty', count: 0 });
      }

      const all = productStore.load();
      const mine = all.filter((x) => x.storeId === storeId);
      // 异常不覆盖：只和本店上次同步条数比
      if (mine.length > 3 && rows.length < mine.length * 0.5) {
        return send(res, 200, { ok: true, skipped: 'anomaly', prev: mine.length, got: rows.length });
      }

      const keep = all.filter((x) => x.storeId !== storeId);
      const byId = new Map(mine.map((x) => [String(x.goodsId), x]));
      for (const r of rows) {
        if (!r || !r.goodsId) continue;
        const prev = byId.get(String(r.goodsId)) || {};
        const [min, max] = String(r.price || '').split('～');
        byId.set(String(r.goodsId), {
          ...prev,
          storeId,
          goodsId: String(r.goodsId),
          title: String(r.title || prev.title || ''),
          price: Number(min) || prev.price || 0,
          priceMax: max ? Number(max) : undefined,
          stock: Number(r.stock) || 0,
          status: r.status || 'on_sale',
          enabled: (r.status || 'on_sale') === 'on_sale',
          syncedAt: new Date().toISOString(),
          source: 'mms-sync',
        });
      }
      const merged = keep.concat([...byId.values()]);
      productStore.save(merged);
      return send(res, 200, { ok: true, count: byId.size, total: merged.length, syncedAt: new Date().toISOString() });
    }

    if (p === '/api/knowledge/pending' && req.method === 'GET') {
      const items = store.getKnowledge().filter((k) => k.enabled === false);
      return send(res, 200, { ok: true, items });
    }

    // 命中自测：用条目自己的标题/关键词反问一遍，判断它到底能不能被检索到
    if (p === '/api/knowledge/probe' && req.method === 'POST') {
      const body = await readBody(req);
      const item = body.item || {};
      const storeId = body.storeId || item.storeId || '';
      const title = String(item.title || '').trim();
      const keywords = (item.keywords || []).map((x) => String(x || '').trim()).filter(Boolean);
      if (!title && !keywords.length) return send(res, 400, { ok: false, error: '先填标题或关键词' });

      const all = store.getKnowledge().filter((k) => !k.archived && k.enabled !== false);
      const mine = all.filter((k) => (storeId ? k.storeId === storeId : !k.storeId));
      const others = mine.filter((k) => String(k.title || '') !== title);
      const probeItem = {
        ...item,
        id: item.id || '__probe__',
        title: title || keywords[0],
        keywords,
        enabled: true,
        storeId,
      };
      const kb = others.concat([probeItem]);

      const probes = [];
      const seen = new Set();
      const queries = [title, ...keywords.slice(0, 3)].filter(Boolean);
      for (const q of queries) {
        const key = q.replace(/\s+/g, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const ask = understand.detectAsk(q);
        const hits = knowledge.retrieve(q, kb, { storeId });
        const rank = hits.findIndex((h) => String(h.entry.id) === '__probe__');
        const rival = hits[0] && String(hits[0].entry.id) !== '__probe__' ? hits[0].entry.title : '';
        probes.push({
          q,
          ask,
          hit: rank >= 0,
          rank: rank >= 0 ? rank + 1 : 0,
          score: rank >= 0 ? Number(hits[rank].score.toFixed(2)) : 0,
          rival,
          askMatch: !item.ask || ask === item.ask,
        });
      }

      const hitTop = probes.some((x) => x.rank === 1);
      const hitAny = probes.some((x) => x.hit);
      const askOk = probes.every((x) => x.askMatch);
      const advice = [];
      if (!hitAny) advice.push('一条都没命中：换成买家真的会说的说法当关键词（比如「几点上班」「营业时间」）');
      else if (!hitTop) advice.push('能检索到但排不到第一：被「' + (probes.find((x) => x.rival) || {}).rival + '」压住了，把关键词写长一点或更具体');
      if (!askOk) {
        const bad = probes.find((x) => !x.askMatch);
        if (bad) advice.push('问法被识别成「' + bad.ask + '」，但条目标的是「' + (item.ask || '-') + '」，两者要对齐');
      }
      if (keywords.length < 2) advice.push('关键词太少：至少写 2~3 个买家可能的说法');
      const shortKw = keywords.filter((k) => k.replace(/\s+/g, '').length < 2);
      if (shortKw.length) advice.push('关键词太短（' + shortKw.join('、') + '），容易跟别的问题撞，写长一点更准');

      // 覆盖率检查：去掉疑问/虚词后的 2 字片段，必须能在条目里找到
      const Q_STOP = /请问|想问|麻烦|一下|什么样|什么|怎么|怎样|多少|几天|几个|哪儿|哪里|哪个|是不是|能不能|可不可以|有没有|你们|我们|咱们|这边|那边|可以|需要|这个|那个|的话|吗|呢|吧|啊|呀|哦|哈|的|了|是|有|能|会|要|在|和|与|就|都|我|你/g;
      function coversQuestion(q, entry) {
        const corpus = [entry.title, ...(entry.keywords || []), entry.answer].join('').replace(/\s+/g, '');
        const clean = String(q || '').replace(Q_STOP, '').replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
        if (clean.length < 2) return true;
        // 贪心最长匹配：问句必须能被条目里的片段「切分干净」，切不掉的部分就是它答不了的
        let i = 0;
        while (i < clean.length) {
          let matched = 0;
          for (let len = Math.min(6, clean.length - i); len >= 2; len--) {
            if (corpus.includes(clean.slice(i, i + len))) { matched = len; break; }
          }
          if (!matched) return false;
          i += matched;
        }
        return true;
      }

      // 推荐关键词：从真实买家话术里挑「用了就一定能命中」的说法
      const suggestKeywords = (() => {
        if (hitTop && askOk && shortKw.length === 0 && keywords.length >= 2) return [];
        const words = [title, ...keywords].map((x) => String(x || '').replace(/\s+/g, '')).filter((x) => x.length >= 2);
        const logs = store.getLogs(1200).filter((l) => l && l.buyerText);
        const freq = new Map();
        for (const l of logs) {
          if (storeId && l.storeId && l.storeId !== storeId) continue;
          const t = String(l.buyerText).replace(/[。！？!?，,：:\s]+$/g, '').trim();
          if (t.length < 2 || t.length > 20) continue;
          if (keywords.includes(t)) continue;
          const related = words.some((w) => t.includes(w) || w.includes(t.slice(0, 3)));
          if (!related) continue;
          freq.set(t, (freq.get(t) || 0) + 1);
        }
        const out = [];
        const seenQ = new Set();
        for (const [text, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
          if (out.length >= 3) break;
          if (seenQ.has(text)) continue;
          seenQ.add(text);
          // 必须真的能排第一，否则推了也没用
          const h = knowledge.retrieve(text, kb, { storeId });
          const rank = h.findIndex((x) => String(x.entry.id) === '__probe__');
          if (rank !== 0) continue;

          // 光命中不算：问法里有条目答不了的实义片段，推了就会制造错答。
          // 判据是「覆盖率」而不是「地区词典」：
          //   去掉疑问/虚词后，问句里每个 2 字片段都必须在这条的标题/关键词/答案里出现过
          //   —— 不需要知道「乌鲁木齐」是地名，照样能拦住
          if (!coversQuestion(text, probeItem)) continue;
          out.push({ text, count, rank: 1 });
        }
        return out;
      })();

      // 通过标准：能排第一 + ask 对得上 + 关键词够多够长（太短会跟别的问题撞）
      const pass = hitTop && askOk && shortKw.length === 0 && keywords.length >= 2;
      return send(res, 200, {
        ok: true,
        pass,
        weak: hitAny && !pass,
        probes,
        advice,
        suggestKeywords,
      });
    }

    if (p === '/api/knowledge/enable' && req.method === 'POST') {
      const { id } = await readBody(req);
      const list = store.getKnowledge();
      const it = list.find((k) => k.id === id);
      if (!it) return send(res, 404, { ok: false, error: '条目不存在' });
      // 模板里的【…】是待填写占位符，没填就启用等于把占位符发给买家
      if (/【[^】]+】/.test(String(it.answer || ''))) {
        return send(res, 400, { ok: false, error: '模板里还有【待填写】的内容，请先改成实际信息', placeholder: true });
      }
      it.enabled = true;
      it.needsConfirm = false;
      delete it.updatedAt;
      it.updatedAt = new Date().toISOString();
      await store.saveKnowledge(list);
      return send(res, 200, { ok: true, item: it });
    }

    // 商品单个字段更新（品类这类列表页拿不到的，让商家补一次）
    if (p === '/api/products/update' && req.method === 'POST') {
      const body = await readBody(req);
      const list = productStore.load();
      const it = list.find((x) => String(x.goodsId) === String(body.goodsId));
      if (!it) return send(res, 404, { ok: false, error: '商品不存在' });
      if (typeof body.category === 'string') it.category = body.category.trim().slice(0, 20);
      if (typeof body.spec === 'string') it.spec = body.spec.trim().slice(0, 80);
      it.updatedAt = new Date().toISOString();
      productStore.save(list);
      return send(res, 200, { ok: true, item: it });
    }

    if (p === '/api/products/import' && req.method === 'POST') {
      const { csv } = await readBody(req);
      if (!csv || !String(csv).trim()) return send(res, 400, { ok: false, error: 'CSV 内容为空' });
      const existing = productStore.load();
      const r = catalog.importCsv(String(csv), existing);
      productStore.save(r.items);
      return send(res, 200, { ok: true, added: r.added, updated: r.updated, pending: r.pending, total: r.items.length });
    }

    if (p === '/api/products/pending' && req.method === 'GET') {
      const items = productStore.load().filter((x) => x.status === 'pending');
      return send(res, 200, { ok: true, items });
    }

    if (p === '/api/products/classify' && req.method === 'POST') {
      const { goodsId, category, aliases } = await readBody(req);
      const list = productStore.load();
      const r = catalog.applyClassification(list, goodsId, category, aliases);
      if (!r.ok) return send(res, 400, { ok: false, error: r.error });
      productStore.save(list);
      return send(res, 200, { ok: true, item: r.item });
    }

    if (p === '/api/products' && req.method === 'POST') {
      const body = await readBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      if (!items.length) return send(res, 400, { ok: false, error: '商品列表为空' });
      const count = productStore.save(items);
      return send(res, 200, { ok: true, count });
    }

    if (p === '/api/quota' && req.method === 'GET') {
      return send(res, 200, { ok: true, ...quotaStore.getQuota() });
    }

    if (p === '/api/quota/recharge' && req.method === 'POST') {
      const { points, note } = await readBody(req);
      const n = Math.max(0, Math.min(100000, Number(points) || 0));
      if (!n) return send(res, 400, { ok: false, error: '点数必须大于 0' });
      return send(res, 200, { ok: true, ...quotaStore.recharge(n, note) });
    }

    if (p === '/api/log' && req.method === 'POST') {
      const entry = await readBody(req);
      await store.addLog(entry);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/logs') {
      return send(res, 200, { ok: true, items: store.getLogs(300) });
    }

    if (p === '/api/review' && req.method === 'GET') {
      return send(res, 200, { ok: true, items: store.getReviewQueue() });
    }

    if (p === '/api/review/resolve' && req.method === 'POST') {
      const { id, resolution } = await readBody(req);
      const item = await store.resolveReview(id, resolution);
      return send(res, 200, { ok: Boolean(item), item });
    }

    // 运行指标：仅内部（模型调用率、成本不外露给商家）
    if (p === '/api/metrics' && req.method === 'GET') {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 1));
      const includeTest = url.searchParams.get('includeTest') === '1';
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const logs = store.getLogs(5000).filter((x) => includeTest || !x.test);
      const m = metrics.summarize(logs, { since });
      const gaps = factRegistry.loadGaps().filter((g) => g.status === 'open').length;
      return send(res, 200, { ok: true, days, includeTest, gaps, ...m, internal: true });
    }

    if (p === '/api/stats') {
      const logs = store.getLogs(2000);
      const review = store.getReviewQueue();
      const today = new Date().toISOString().slice(0, 10);
      const todayLogs = logs.filter((l) => String(l.ts || '').slice(0, 10) === today);
      const replyLogs = todayLogs.filter((l) => l.decision);
      const byDecision = replyLogs.reduce((acc, l) => {
        acc[l.decision] = (acc[l.decision] || 0) + 1;
        return acc;
      }, {});
      const ruleHits = replyLogs.filter((l) => l.source === 'rule').length;
      const llmCalls = replyLogs.filter((l) => l.source === 'llm').length;
      const pointsUsed = replyLogs.reduce((n, l) => n + (l.cost || 0), 0);
      return send(res, 200, {
        ok: true,
        today: {
          total: replyLogs.length,
          sends: todayLogs.filter((l) => l.type === 'send').length,
          byDecision,
          pointsUsed,
          modelCalls: llmCalls,
          // 本地命中率 = 毛利率的先行指标
          localHitRate: replyLogs.length ? Number((ruleHits / replyLogs.length).toFixed(3)) : 0,
        },
        pendingReview: review.filter((r) => !r.resolved).length,
        knowledgeCount: store.getKnowledge().length,
      });
    }

    if (p === '/api/diag' && req.method === 'POST') {
      const snap = await readBody(req);
      await store.addLog({ type: 'diag', url: snap.url, summary: snap.summary });
      if (snap.html) {
        const file = path.join(store.DATA_DIR, 'diag-' + Date.now() + '.html');
        fs.mkdirSync(store.DATA_DIR, { recursive: true });
        fs.writeFileSync(file, String(snap.html).slice(0, 800000), 'utf8');
      }
      return send(res, 200, { ok: true });
    }

    if (p === '/' || p === '/index.html') return send(res, 404, { ok: false, error: '控制台已移除，请在桌面客户端「工作台」中管理' });

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    return send(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

// 给没有 ask 标签的老知识补分类：否则它会和模板条目一起参与“打平惩罚”，把置信度压下去
(function tagKnowledge() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    const askOfTitle = (t) => {
      const s = String(t || '');
      if (/发货/.test(s)) return 'shipping_time';
      if (/到货|时效/.test(s)) return 'arrival_time';
      if (/包邮|运费/.test(s)) return 'freight';
      if (/退换|退货/.test(s)) return 'return_policy';
      if (/不发芽|售后/.test(s)) return 'after_sale';
      if (/发票/.test(s)) return 'invoice';
      if (/支付|货到付款/.test(s)) return 'payment';
      if (/发芽率|种植|催芽|播种|温度/.test(s)) return 'usage';
      if (/规格/.test(s)) return 'spec';
      if (/议价/.test(s)) return 'nego';
      if (/有货|库存/.test(s)) return 'stock';
      return null;
    };
    for (const e of kb) {
      if (e.templateId) continue; // 模板条目用导入时带的 ask
      const a = askOfTitle(e.title) || understand.detectAsk(String(e.title || '') + ' ' + (e.keywords || []).join(' '));
      if (a && a !== 'other' && e.ask !== a) { e.ask = a; changed = true; }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) {}
})();

// 模板升级：还没被商家确认过的模板条目，跟着模板文件走（避免旧【填写】文案残留）
(function migrateTemplates() {
  try {
    const kb = store.getKnowledge();
    let changed = false;
    for (const e of kb) {
      if (!e.templateId || !e.needsConfirm) continue;
      const t = kbTemplates.list().find((x) => x.id === e.templateId);
      if (!t) continue;
      if (e.answer !== t.answer || e.ask !== t.ask || e.priority !== t.priority) {
        e.answer = t.answer;
        e.keywords = t.keywords.slice();
        e.ask = t.ask;
        e.priority = t.priority;
        changed = true;
      }
    }
    if (changed) store.saveKnowledge(kb);
  } catch (_) { /* 启动迁移失败不影响服务 */ }
})();

const cfg = store.getConfig();
const port = Number(process.env.PDD_CS_PORT || cfg.port || 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`[pdd-cs] 本地服务已启动: http://127.0.0.1:${port}`);
  console.log(`[pdd-cs] 数据目录: ${store.DATA_DIR}`);
  console.log(`[pdd-cs] 仅提供 API，界面在桌面客户端`);
});

module.exports = server;
