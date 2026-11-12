'use strict';
const assert = require('assert');
const focus = require('../server/focus');
const r = focus.adjust([{ tone: '标准', text: '您问的金乡大蒜目前不在本店在售商品里，具体库存/补货以页面为准。' }], [
  { role: 'buyer', text: '现在有货吗' },
  { role: 'seller', text: '您问的金乡大蒜目前不在本店在售商品里，具体库存/补货以页面为准。' },
], '现在有货吗');
const text = r.suggestions[0].text;
assert.ok(!/刚才|说过|重点|再说一遍|简单重复/.test(text), '不得带指责/元评论前缀');
assert.ok(/不在本店在售/.test(text), '保留原回答');
console.log('focus：重复回答不带语气前缀 PASS');
