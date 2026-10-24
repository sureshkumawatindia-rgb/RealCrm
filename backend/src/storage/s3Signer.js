const crypto = require('crypto');

// AWS Signature Version 4 (the S3 protocol, which Cloudflare R2 speaks), header-based, without
// the AWS SDK. Checked against AWS's signing test suite (tests/storage.test.js).

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_SHA256 = sha256Hex('');

// RFC 3986: everything but A-Z a-z 0-9 - _ . ~ is percent-encoded.
const encode = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function canonicalQuery(url) {
  return [...url.searchParams]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// The headers to add to the request: x-amz-date, x-amz-content-sha256 (S3 needs it; AWS's
// generic test suite does not sign it) and authorization. Other headers to sign come in `headers`.
function sign({ method, url, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, region, service, date = new Date(), contentHashHeader = true }) {
  const target = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const added = { 'x-amz-date': amzDate, ...(contentHashHeader && { 'x-amz-content-sha256': payloadHash }) };
  const toSign = { host: target.host, ...added };
  for (const [name, value] of Object.entries(headers)) toSign[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  const names = Object.keys(toSign).sort();
  const canonicalUri = target.pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/') || '/';
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery(target),
    names.map((name) => `${name}:${toSign[name]}\n`).join(''),
    names.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

module.exports = { sign, sha256Hex, encode, EMPTY_SHA256 };
