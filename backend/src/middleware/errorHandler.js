const logger = require('../config/logger');

// Maps library errors to the API error shape. Errors without an explicit statusCode are
// unexpected: they are logged in full but answered with a generic message.
function normalize(err) {
  if (err.type === 'entity.parse.failed') return { statusCode: 400, code: 'INVALID_JSON', message: 'The request body is not valid JSON.' };
  if (err.type === 'entity.too.large') return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' };
  if (err.statusCode) return { ...err, message: err.message, code: err.code || (err.statusCode < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR') };
  if (err.name === 'MulterError') return { statusCode: 400, code: 'FILE_UPLOAD_ERROR', message: err.message };
  if (err.name === 'CastError') return { statusCode: 400, code: 'INVALID_ID', message: 'One of the ids in the request is not valid.' };
  if (err.code === 11000) return { statusCode: 409, code: 'CONFLICT', message: 'This record already exists.' };
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };
}

const errorHandler = (err, req, res, next) => {
  const { statusCode, code, message, errors } = normalize(err);
  if (statusCode >= 500) logger.error(`${req.id || ''} - ${err.message}`, { stack: err.stack });
  else logger.warn(`${req.id || ''} - ${statusCode} ${code}: ${message}`);

  const response = {
    success: false,
    message: message || 'Internal Server Error',
    code: code || 'INTERNAL_ERROR',
    requestId: req.id,
  };
  if (errors) response.errors = errors;

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
