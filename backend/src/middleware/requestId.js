const crypto = require('crypto');

// Accept a caller's X-Request-Id only when it is short and plain, so it is safe to log.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

const requestIdMiddleware = (req, res, next) => {
  const incoming = req.get('x-request-id');
  req.id = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestIdMiddleware;
