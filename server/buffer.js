'use strict';

/**
 * buffer.js —— 三级缓冲地带
 *
 * 前提：**没有人工客服**。所以"转人工"不是出路，每一句话都必须能发出去。
 *
 * 退款/投诉这类诉求，不是一上来就给规则，而是分三级缓冲：
 *   L1 问清楚：先共情 + 问具体问题（"是有什么问题呢？"）
 *   L2 给办法：根据已知信息给解决方向，不承诺结果
 *   L3 给出口：买家仍然坚持 → 告诉他自助售后入口
 *
 * 状态不靠内存：从会话里数"买家提过几次退款"就能算出阶段。
 */

const REFUND_WORDS = /退款|退货|退钱|退掉|退了|不想要了|申请售后/;

function refundStage(messages) {
  const n = (messages || []).filter((m) => m.role === 'buyer' && REFUND_WORDS.test(m.text || '')).length;
  return Math.min(3, Math.max(1, n));
}

const TEXT = {
  refund: {
    1: '亲，是遇到什么问题了呢？您方便说下具体情况吗，咱们一起看看怎么弄哈。',
    2: '亲，您说的情况我记下了哈。如果是商品本身的问题，您先把照片留好，按平台规则走售后就行。',
    3: '亲，实在不好意思没能让您满意。您可以在订单页点「申请售后」，按平台规则提交哈。',
  },
  complaint: {
    1: '亲，实在抱歉让您不开心了。具体是哪儿没让您满意，您跟我说说，看看怎么补救哈。',
    2: '亲，您说的这个情况我记下了，确实是我们没做好，给您添麻烦了。具体是哪一单的问题，您方便说一下吗？',
    3: '亲，实在抱歉。您可以先在订单页提交售后，平台会按规则处理；需要我这边确认的，您把问题写在售后里就行哈。',
  },
};

// 阶段不只看"提了几次退款"，还要看"有没有说清问题"
const TROUBLE = /破损|坏了|断|裂|不发芽|没出|少了|发错|烂|死了|质量问题|用不了/;

function stageFor(messages, query) {
  const list = messages || [];
  const mentions = list.filter((m) => m.role === 'buyer' && REFUND_WORDS.test(m.text || '')).length;
  const explained =
    TROUBLE.test(String(query || '')) ||
    list.slice(0, -1).some((m) => m.role === 'buyer' && TROUBLE.test(m.text || ''));
  if (mentions >= 3) return 3;                          // 反复坚持 → 给自助出口
  if (explained && mentions >= 2) return 3;             // 说清问题后还在坚持 → 给出口
  if (explained && mentions >= 1) return 2;             // 说清了问题 → 给办法
  return 1;                                              // 先问清楚
}

function replyFor(kind, stage) {
  const set = TEXT[kind] || TEXT.refund;
  return set[Math.min(3, Math.max(1, stage))] || set[1];
}

module.exports = { refundStage, stageFor, replyFor, REFUND_WORDS };
