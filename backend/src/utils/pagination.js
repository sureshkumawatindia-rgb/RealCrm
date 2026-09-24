const Joi = require('joi');

const MAX_LIMIT = 100;

const paginationQuery = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(20),
};

function toPage({ page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), MAX_LIMIT);
  const safePage = Math.max(Number(page) || 1, 1);
  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}

function paginationMeta({ page, limit }, total) {
  const totalPages = Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 };
}

module.exports = { MAX_LIMIT, paginationQuery, toPage, paginationMeta };
