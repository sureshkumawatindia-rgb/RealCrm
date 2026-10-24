const crypto = require('crypto');
const { Readable } = require('stream');
const { sign, sha256Hex, encode } = require('./s3Signer');

// Cloudflare R2 by the S3 protocol (F5): https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
// (path style), region "auto". Only what the CRM needs: put, get, head, delete, list, and
// multipart uploads for large backup files. Every request is signed (SigV4) and has a timeout.

const TIMEOUT_MS = 60 * 1000;
const PART_BYTES = 8 * 1024 * 1024; // R2 parts are at least 5 MiB, except the last

const tag = (xml, name) => (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml) || [])[1];
const unescapeXml = (text) => String(text).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function createR2Client({ accountId, accessKeyId, secretAccessKey, endpoint, fetchImpl = (...args) => fetch(...args) }) {
  const base = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');

  async function request(method, bucket, key, { query = {}, body, headers = {}, okStatuses = [] } = {}) {
    const path = key ? `/${bucket}/${key.split('/').map(encode).join('/')}` : `/${bucket}`;
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, value);
    const payload = body ?? Buffer.alloc(0);
    const signed = sign({ method, url: url.toString(), payloadHash: sha256Hex(payload), accessKeyId, secretAccessKey, region: 'auto', service: 's3' });
    const response = await fetchImpl(url, {
      method,
      headers: { ...headers, ...signed },
      body: body ?? undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok && !okStatuses.includes(response.status)) {
      const text = await response.text().catch(() => '');
      const error = new Error(`R2 ${method} ${key || bucket}: ${response.status} ${tag(text, 'Code') || ''}`.trim());
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async function putObject(bucket, key, body, { contentType } = {}) {
    const response = await request('PUT', bucket, key, { body, headers: contentType ? { 'Content-Type': contentType } : {} });
    return { etag: (response.headers.get('etag') || '').replace(/"/g, '') };
  }

  // A read stream, or null when there is no such object.
  async function getObject(bucket, key) {
    const response = await request('GET', bucket, key, { okStatuses: [404] });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return Readable.fromWeb(response.body);
  }

  async function getBuffer(bucket, key) {
    const stream = await getObject(bucket, key);
    if (!stream) return null;
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async function headObject(bucket, key) {
    const response = await request('HEAD', bucket, key, { okStatuses: [404] });
    if (response.status === 404) return null;
    return { size: Number(response.headers.get('content-length')), etag: (response.headers.get('etag') || '').replace(/"/g, '') };
  }

  async function deleteObject(bucket, key) {
    await request('DELETE', bucket, key, { okStatuses: [404] });
  }

  // Every object under a prefix: [{ key, size, etag }] (ListObjectsV2, page by page).
  async function listObjects(bucket, prefix, { pageSize = 1000 } = {}) {
    const items = [];
    let token;
    do {
      const response = await request('GET', bucket, '', { query: { 'list-type': '2', prefix, 'max-keys': String(pageSize), 'continuation-token': token } });
      const xml = await response.text();
      for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        items.push({ key: unescapeXml(tag(entry, 'Key')), size: Number(tag(entry, 'Size')), etag: unescapeXml(tag(entry, 'ETag') || '').replace(/"/g, '') });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? unescapeXml(tag(xml, 'NextContinuationToken') || '') : undefined;
    } while (token);
    return items;
  }

  // Uploads chunks as they come (a stream or async iterable of Buffers): one PUT when the whole
  // is smaller than a part, else a multipart upload (aborted if anything fails).
  async function putStream(bucket, key, source, { partBytes = PART_BYTES, contentType } = {}) {
    let pending = [];
    let pendingBytes = 0;
    let uploadId = null;
    const parts = [];
    const hash = crypto.createHash('sha256');
    let total = 0;

    async function sendPart(buffer) {
      if (!uploadId) {
        const created = await request('POST', bucket, key, { query: { uploads: '' }, headers: contentType ? { 'Content-Type': contentType } : {} });
        uploadId = unescapeXml(tag(await created.text(), 'UploadId'));
      }
      const partNumber = parts.length + 1;
      const response = await request('PUT', bucket, key, { query: { partNumber: String(partNumber), uploadId }, body: buffer });
      parts.push({ partNumber, etag: response.headers.get('etag') });
    }

    try {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        total += buffer.length;
        pending.push(buffer);
        pendingBytes += buffer.length;
        if (pendingBytes >= partBytes) {
          const whole = Buffer.concat(pending);
          pending = [whole.subarray(partBytes)];
          pendingBytes = pending[0].length;
          await sendPart(whole.subarray(0, partBytes));
        }
      }
      const rest = Buffer.concat(pending);
      if (!uploadId) {
        await putObject(bucket, key, rest, { contentType });
      } else {
        if (rest.length) await sendPart(rest);
        const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
        await request('POST', bucket, key, { query: { uploadId }, body: Buffer.from(xml), headers: { 'Content-Type': 'application/xml' } });
      }
      return { bytes: total, sha256: hash.digest('hex') };
    } catch (error) {
      if (uploadId) await request('DELETE', bucket, key, { query: { uploadId }, okStatuses: [404] }).catch(() => {});
      throw error;
    }
  }

  return { putObject, getObject, getBuffer, headObject, deleteObject, listObjects, putStream };
}

module.exports = { createR2Client };
