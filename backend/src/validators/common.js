const Joi = require('joi');
const { paginationQuery } = require('../utils/pagination');

const objectId = Joi.string().hex().length(24);

module.exports = {
  objectId,
  idParams: Joi.object({ id: objectId.required() }),
  pageQuery: Joi.object(paginationQuery),
};
