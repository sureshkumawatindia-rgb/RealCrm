const { v4: uuidv4 } = require('uuid'); // Will use crypto if uuid is not installed, but let's just use crypto.randomUUID()
const crypto = require('crypto');

const requestIdMiddleware = (req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

module.exports = requestIdMiddleware;
