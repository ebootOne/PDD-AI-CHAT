'use strict';

/**
 * llm.js —— OpenAI 兼容接口客户端（DeepSeek / 通义 / 智谱 / Ollama 均可）
 * 零依赖，使用 Node 内置 fetch。
 */

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/**
 * @param {object} cfg { baseUrl, apiKey, model, timeoutMs, temperature }
 * @param {Array<{role:string,content:string}>} messages
 * @returns {Promise<{ok:boolean, text?:string, error?:string, usage?:object, ms:number}>}
 */
async function chat(cfg, messages) {
  const started = Date.now();
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置 LLM baseUrl', ms: 0 };

  const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
  const timer = withTimeout(cfg.timeoutMs || 25000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: cfg.temperature == null ? 0.3 : cfg.temperature,
        max_tokens: 600,
        response_format: { type: 'json_object' },
      }),
      signal: timer.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms: Date.now() - started };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '响应不是 JSON: ' + text.slice(0, 200), ms: Date.now() - started };
    }
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return { ok: false, error: 'LLM 返回为空', ms: Date.now() - started };
    return { ok: true, text: content, usage: data.usage, ms: Date.now() - started };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'LLM 请求超时' : String((err && err.message) || err);
    return { ok: false, error: msg, ms: Date.now() - started };
  } finally {
    timer.done();
  }
}

/** 从可能带 ```json 包裹的文本里提取 JSON 对象 */
function extractJson(text) {
  if (!text) return null;
  const s = String(text).trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

module.exports = { chat, extractJson };
