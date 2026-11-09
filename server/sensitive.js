'use strict';

/**
 * sensitive.js —— 敏感词分层校验（本地最后一道闸）
 *
 * 为什么分两层：
 *   block —— 发出去就可能违规/赔钱（导流、赔付承诺、绝对化、医疗功效），整条候选丢弃；
 *   warn  —— 不违规但容易踩线（促销词、比较词），保留但记下来，给商家看。
 *
 * 词表放在 data/sensitive.json，可热更新；代码里只保留兜底默认值。
 * 判决依据分级：平台明令 / 广告法 / 店铺自定义——写清来源，方便复核时解释“为什么被拦”。
 *
 * 注意：不能拦裸词「微信」。知识库的支付方式回答里就有「支持微信、支付宝」，
 * 要拦的是「加微信」这类导流说法，不是平台名。
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'sensitive.json');

const DEFAULTS = [
  // 站外导流（平台处罚最重的一类）
  { word: '加微信', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '加我微信', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '微信号', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '加个微信', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '私聊', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '加我QQ', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '二维码', level: 'block', reason: '站外导流', source: '平台规则' },
  { word: '手机号', level: 'block', reason: '泄露联系方式', source: '平台规则' },
  { word: 'http://', level: 'block', reason: '站外链接', source: '平台规则' },
  { word: 'https://', level: 'block', reason: '站外链接', source: '平台规则' },
  // 赔付/绝对化（广告法 + 平台虚假宣传）
  { word: '赔你', level: 'block', reason: '赔付承诺', source: '广告法' },
  { word: '退你钱', level: 'block', reason: '赔付承诺', source: '广告法' },
  { word: '假一赔十', level: 'block', reason: '赔付承诺', source: '广告法' },
  { word: '包退包换', level: 'block', reason: '绝对化承诺', source: '广告法' },
  { word: '全网最低', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '最低价', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '100%', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '绝对', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '保证', level: 'block', reason: '承诺性用语', source: '广告法' },
  { word: '唯一', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '独家', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '顶级', level: 'block', reason: '绝对化用语', source: '广告法' },
  { word: '国家级', level: 'block', reason: '绝对化用语', source: '广告法' },
  // 功效类（农资/食品都不能说）
  { word: '根治', level: 'block', reason: '功效承诺', source: '广告法' },
  { word: '治疗', level: 'block', reason: '功效承诺', source: '广告法' },
  { word: '提高免疫', level: 'block', reason: '功效承诺', source: '广告法' },
  // 促销/比较（不违规，但容易被判夸大）
  { word: '秒杀', level: 'warn', reason: '促销夸大', source: '平台规则' },
  { word: '抢购', level: 'warn', reason: '促销夸大', source: '平台规则' },
  { word: '全网', level: 'warn', reason: '比较性表述', source: '广告法' },
  { word: '第一', level: 'warn', reason: '绝对化风险', source: '广告法' },
  { word: '最好', level: 'warn', reason: '绝对化风险', source: '广告法' },
];

let cache = { mtime: 0, words: null };

function loadWords() {
  try {
    const st = fs.statSync(FILE);
    if (cache.words && cache.mtime === st.mtimeMs) return cache.words;
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const words = (data.words || []).filter((w) => w && w.word);
    cache = { mtime: st.mtimeMs, words };
    return words;
  } catch (_) {
    return DEFAULTS;
  }
}

/**
 * @param {string} text 候选回复
 * @param {string[]} [extra] 店铺自定义禁用词（config.forbiddenOutput）
 * @returns {{ok:boolean, hits:Array, warned:Array}}
 */
function check(text, extra) {
  const t = String(text || '');
  const words = loadWords();
  const hits = [];
  const warned = [];

  for (const w of words) {
    if (!w.word || !t.includes(w.word)) continue;
    const item = { word: w.word, level: w.level, reason: w.reason, source: w.source };
    (w.level === 'warn' ? warned : hits).push(item);
  }
  for (const w of extra || []) {
    if (!w || !t.includes(w)) continue;
    if (hits.some((h) => h.word === w)) continue;
    hits.push({ word: w, level: 'block', reason: '店铺自定义', source: 'config' });
  }
  return { ok: hits.length === 0, hits, warned };
}

module.exports = { check, loadWords, DEFAULTS, FILE };
