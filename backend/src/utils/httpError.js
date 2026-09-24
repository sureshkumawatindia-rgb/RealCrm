// Builds an Error the errorHandler understands: { statusCode, code, message, errors? }.
function httpError(statusCode, code, message, errors) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (errors) error.errors = errors;
  return error;
}

module.exports = httpError;
