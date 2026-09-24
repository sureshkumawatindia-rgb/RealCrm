const path = require('path');

const allowedExtensions = new Set(['png', 'jpg', 'jpeg', 'svg', 'webp']);

function validateLogoFile(file) {
  const extension = path.extname(file.originalname || '').slice(1).toLowerCase();
  if (!allowedExtensions.has(extension)) {
    const error = new Error('Invalid file type. Choose a PNG, JPG, JPEG, SVG, or WebP image.');
    error.statusCode = 400;
    error.code = 'INVALID_FILE_TYPE';
    throw error;
  }

  const bytes = file.buffer;
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  const isWebp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const isSvg = /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(bytes.toString('utf8', 0, 512));
  const valid = (extension === 'png' && isPng) || (['jpg', 'jpeg'].includes(extension) && isJpeg) || (extension === 'webp' && isWebp) || (extension === 'svg' && isSvg);
  if (!valid) {
    const error = new Error('The uploaded file content does not match its file type.');
    error.statusCode = 400;
    error.code = 'INVALID_FILE_CONTENT';
    throw error;
  }
  return extension === 'jpeg' ? 'jpg' : extension;
}

module.exports = { validateLogoFile };