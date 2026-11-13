'use strict';
const assert = require('assert');
const { createScheduler } = require('../server/reply-scheduler');

const s = createScheduler({ softMs: 1000, hardMs: 2000 });
const t0 = 100000;
s.enqueue({ storeId: 'A', conversationId: 'c1', messageId: 'm1', at: t0 });
s.enqueue({ storeId: 'A', conversationId: 'c2', messageId: 'm2', at: t0 + 100 });
assert.strictEqual(s.enqueue({ storeId: 'A', conversationId: 'c1', messageId: 'm1', at: t0 }).duplicate, true);

let n = s.next(t0 + 200);
assert.strictEqual(n.type, 'reply');
assert.strictEqual(n.task.conversationId, 'c1');

n = s.next(t0 + 1100);
assert.strictEqual(n.type, 'fallback');
assert.strictEqual(n.task.conversationId, 'c1');

n = s.next(t0 + 3000);
assert.strictEqual(n.type, 'human');

assert.strictEqual(s.acquireSend(), true);
assert.strictEqual(s.acquireSend(), false);
s.releaseSend();
assert.strictEqual(s.acquireSend(), true);

s.markReplied(s.keyOf('A', 'c1', 'm1'));
assert.strictEqual(s.next(t0 + 100).task.conversationId, 'c2');
assert.strictEqual(s.snapshot().done, 1);
console.log('reply-scheduler：多会话/最早优先/软硬deadline/去重/单发送 PASS');
