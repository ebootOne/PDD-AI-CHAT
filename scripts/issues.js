'use strict';

/**
 * issues.js —— 测试会话与修复会话之间的问题单
 *
 * 测试会话只写单，修复会话只改代码并关单。两边靠这个文件交接，不靠聊天记录。
 *
 * 用法：
 *   node scripts/issues.js list [open|fixed|all]
 *   node scripts/issues.js show <id>
 *   node scripts/issues.js add --title "..." --severity P1 --type 答非所问 \
 *        --buyer "买家原话" --actual "实际回复" --expected "期望" --repro "复现步骤"
 *   node scripts/issues.js add --json '{"title":"..."}'      # 或从标准输入读
 *   node scripts/issues.js close <id> --note "改了什么 + 回归用例"
 *   node scripts/issues.js stats
 */

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'issues.json');

const SEV = { P0: 0, P1: 1, P2: 2, P3: 3 };

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(d.issues) ? d : { issues: [] };
  } catch (_) {
    return { issues: [] };
  }
}

function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2), 'utf8');
}

function nextId(d) {
  const n = d.issues.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, '')) || 0), 0);
  return 'ISS-' + String(n + 1).padStart(3, '0');
}

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function addFromJson(obj) {
  const d = load();
  const it = {
    id: nextId(d),
    title: String(obj.title || '').trim(),
    severity: SEV[obj.severity] != null ? obj.severity : 'P2',
    type: obj.type || '待归因',
    engine: obj.engine || 'both', // standard | pro | both
    buyerText: obj.buyerText || '',
    actual: obj.actual || '',
    expected: obj.expected || '',
    source: obj.source || '',
    repro: obj.repro || '',
    status: 'open',
    createdAt: new Date().toISOString(),
    note: '',
  };
  if (!it.title) throw new Error('必须给 title');
  d.issues.push(it);
  save(d);
  console.log('已记录 ' + it.id + '  ' + it.severity + '  ' + it.title);
  return it;
}

const cmd = process.argv[2] || 'list';

if (cmd === 'add') {
  const json = arg('json');
  let obj = null;
  if (json) obj = JSON.parse(json);
  else if (!process.stdin.isTTY) {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (raw) obj = JSON.parse(raw);
  }
  if (!obj) {
    obj = {
      title: arg('title'),
      severity: arg('severity'),
      type: arg('type'),
      engine: arg('engine'),
      buyerText: arg('buyer'),
      actual: arg('actual'),
      expected: arg('expected'),
      repro: arg('repro'),
      source: arg('source'),
    };
  }
  addFromJson(obj);
  process.exit(0);
}

if (cmd === 'list') {
  const want = process.argv[3] || 'open';
  const d = load();
  const list = d.issues
    .filter((x) => (want === 'all' ? true : x.status === want))
    .sort((a, b) => (SEV[a.severity] - SEV[b.severity]) || a.id.localeCompare(b.id));
  if (!list.length) {
    console.log('没有问题单（' + want + '）');
    process.exit(0);
  }
  for (const x of list) {
    console.log(`${x.id}  ${x.severity}  [${x.status}]  (${x.engine || 'both'})  ${x.title}`);
  }
  console.log(`\n共 ${list.length} 条`);
  process.exit(0);
}

if (cmd === 'show') {
  const d = load();
  const it = d.issues.find((x) => x.id === process.argv[3]);
  if (!it) {
    console.error('没有这条');
    process.exit(1);
  }
  for (const [k, v] of Object.entries(it)) console.log(k.padEnd(10) + ' ' + v);
  process.exit(0);
}

if (cmd === 'close') {
  const id = process.argv[3];
  const d = load();
  const it = d.issues.find((x) => x.id === id);
  if (!it) {
    console.error('没有这条');
    process.exit(1);
  }
  it.status = 'fixed';
  it.note = arg('note') || '';
  it.fixedAt = new Date().toISOString();
  save(d);
  console.log('已关闭 ' + id);
  process.exit(0);
}

if (cmd === 'stats') {
  const d = load();
  const open = d.issues.filter((x) => x.status === 'open');
  const fixed = d.issues.filter((x) => x.status === 'fixed');
  console.log(`未处理 ${open.length} · 已修复 ${fixed.length} · 合计 ${d.issues.length}`);
  for (const s of ['P0', 'P1', 'P2', 'P3']) {
    const n = open.filter((x) => x.severity === s).length;
    if (n) console.log(`  ${s}: ${n}`);
  }
  process.exit(0);
}

console.log('用法: node scripts/issues.js [list|show|add|close|stats]');
process.exit(1);
