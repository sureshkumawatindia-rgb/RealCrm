const httpError = require('../utils/httpError');

// validate({ params, query, body }) with Joi schemas. Unknown fields are dropped.
// Validated values land on req.valid (Express 5 makes req.query read-only); body is also replaced.
function validate(schemas) {
  return (req, res, next) => {
    const errors = [];
    req.valid = req.valid || {};
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const { error, value } = schemas[part].validate(req[part] ?? {}, { abortEarly: false, stripUnknown: true, convert: true });
      if (error) {
        errors.push(...error.details.map((detail) => ({
          field: detail.path.join('.'),
          code: detail.type.toUpperCase().replace(/[^A-Z]+/g, '_'),
          message: detail.message.replace(/"/g, ''),
        })));
      } else {
        req.valid[part] = value;
        if (part === 'body') req.body = value;
      }
    }
    if (errors.length) return next(httpError(400, 'VALIDATION_ERROR', 'Validation failed', errors));
    next();
  };
}

module.exports = validate;
