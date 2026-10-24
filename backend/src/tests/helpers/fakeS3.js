const crypto = require('crypto');
const http = require('http');
const { sign, sha256Hex } = require('../../storage/s3Signer');

// A stand-in for Cloudflare R2 (S3 protocol) in the tests: objects in memory, multipart
// uploads, ListObjectsV2 with pages, and every request's SigV4 signature checked (403 if wrong).
async function startFakeS3({ accessKeyId = 'test-key-id', secretAccessKey = 'test-secret-key', port = 0 } = {}) {
  const objects = new Map(); // "bucket/key" → { body, etag }
  const uploads = new Map();
  const requests = [];

  const xml = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
  };
  const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

      // The signature, as the real service checks it.
      const amzDate = req.headers['x-amz-date'] || '';
      const date = new Date(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      const expected = sign({ method: req.method, url: url.toString(), payloadHash: req.headers['x-amz-content-sha256'], accessKeyId, secretAccessKey, region: 'auto', service: 's3', date });
      if (req.headers.authorization !== expected.authorization || req.headers['x-amz-content-sha256'] !== sha256Hex(body)) {
        return xml(res, 403, '<Error><Code>SignatureDoesNotMatch</Code></Error>');
      }

      const [, bucket, ...rest] = url.pathname.split('/');
      const key = rest.map(decodeURIComponent).join('/');
      const id = `${bucket}/${key}`;
      const q = url.searchParams;

      if (req.method === 'GET' && !key && q.get('list-type') === '2') {
        const prefix = q.get('prefix') || '';
        const max = Number(q.get('max-keys') || 1000);
        const all = [...objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`)).sort();
        const start = Number(q.get('continuation-token') || 0);
        const page = all.slice(start, start + max);
        const truncated = start + max < all.length;
        return xml(res, 200, `<ListBucketResult>${page.map((k) => `<Contents><Key>${k.slice(bucket.length + 1)}</Key><Size>${objects.get(k).body.length}</Size><ETag>&quot;${objects.get(k).etag}&quot;</ETag></Contents>`).join('')}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : ''}</ListBucketResult>`);
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const uploadId = crypto.randomBytes(8).toString('hex');
        uploads.set(uploadId, { id, parts: new Map() });
        return xml(res, 200, `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        const upload = uploads.get(q.get('uploadId'));
        if (!upload) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        upload.parts.set(Number(q.get('partNumber')), body);
        res.writeHead(200, { ETag: `"${md5(body)}"` });
        return res.end();
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const upload = uploads.get(q.get('uploadId'));
        if (!upload) return xml(res, 404, '<Error><Code>NoSuchUpload</Code></Error>');
        const numbers = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
        const whole = Buffer.concat(numbers.map((n) => upload.parts.get(n)));
        objects.set(upload.id, { body: whole, etag: `${md5(whole)}-${numbers.length}` });
        uploads.delete(q.get('uploadId'));
        return xml(res, 200, '<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId'));
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'PUT') {
        objects.set(id, { body, etag: md5(body) });
        res.writeHead(200, { ETag: `"${md5(body)}"` });
        return res.end();
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const object = objects.get(id);
        if (!object) return req.method === 'HEAD' ? res.writeHead(404).end() : xml(res, 404, '<Error><Code>NoSuchKey</Code></Error>');
        res.writeHead(200, { 'Content-Length': object.body.length, ETag: `"${object.etag}"` });
        return res.end(req.method === 'GET' ? object.body : undefined);
      }
      if (req.method === 'DELETE') {
        objects.delete(id);
        res.writeHead(204);
        return res.end();
      }
      return xml(res, 400, '<Error><Code>NotImplemented</Code></Error>');
    });
  });
  await new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    accessKeyId,
    secretAccessKey,
    objects,
    uploads,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

module.exports = { startFakeS3 };
