'use strict';

/**
 * kb-templates.js —— 知识库模板库
 *
 * 2026-11-09：按要求清空。店铺类型可能不同，不再内置行业/品类模板；
 * 商家新建知识即可，回复层的四个通用模板在 server/templates.js，和这里无关。
 */

const CATEGORIES = [];

function list() {
  return [];
}

function find() {
  return null;
}

module.exports = { list, find, CATEGORIES };
