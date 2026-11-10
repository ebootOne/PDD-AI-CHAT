'use strict';

const A = {
  hasOrder: true, orderNo: '261110-57996742009410', status: '已发货',
  items: [{ title: '26年金乡大蒜精品山东新干蒜' }],
  packages: [{ courier: '申通', trackingNo: '773451233139410' }],
};
const B = {
  hasOrder: true, orderNo: '261109-47817165006789', status: '已发货',
  items: [{ title: '加量520张大包抽纸大号可湿水' }],
  packages: [{ courier: '中通', trackingNo: '753123456789' }],
};

module.exports = [
  {
    id: 'M01', text: '发货了吗', orders: [A, B],
    groups: [['两单|都'], ['已发货|发了']],
  },
  {
    id: 'M02', text: '大蒜那单发货了吗', orders: [A, B],
    all: ['已发|发货'],
    not: ['抽纸', '中通', '6789'],
  },
  {
    id: 'M03', text: '尾号6789那单到哪了', orders: [A, B],
    all: ['6789'],
    not: ['大蒜', '申通', '9410'],
  },
  {
    id: 'M04', text: '还有吗', orders: [A, B],
    all: ['页面|库存|查|看'],
    not: ['哪一单', '订单', '申通', '9410', '6789', '大蒜', '抽纸'],
  },
  {
    id: 'M05', text: '两单都发了吗', orders: [A, B],
    groups: [['两单|都'], ['发货|发了']],
  },
  {
    id: 'M06', text: '大蒜那单到哪了', orders: [
      { ...A, status: '待发货', packages: [] },
      { ...B, items: [{ title: '金乡大蒜' }], status: '已发货' },
    ],
    all: ['大蒜', '[？?]'],
    groups: [['9410'], ['6789']],
  },
];
