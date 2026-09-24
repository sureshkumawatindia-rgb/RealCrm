const logger = require('../config/logger');

const errorHandler = (err, req, res, next) => {
  logger.error(`${req.id || ''} - ${err.message}`, { stack: err.stack });

  const statusCode = err.statusCode || (err.name === 'MulterError' ? 400 : 500);
  
  const response = {
    success: false,
    message: err.message || 'Internal Server Error',
    code: err.code || (err.name === 'MulterError' ? 'FILE_UPLOAD_ERROR' : 'INTERNAL_ERROR'),
    requestId: req.id,
  };

  if (err.errors) {
    response.errors = err.errors;
  }

  res.status(statusCode).json(response);
};

module.exports = errorHandler;
