jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const express = require('express');
const request = require('supertest');
const { api } = require('./helpers/api');
const errorHandler = require('../middleware/errorHandler');

describe('Request hardening', () => {
  it('rejects MongoDB operators in the body', async () => {
    const res = await api().post('/api/v1/auth/google').send({ credential: { $gt: '' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects operator keys in the query string', async () => {
    const res = await api().get('/api/v1/health?$where=1');
    expect(res.status).toBe(400);
  });

  it('answers malformed JSON with 400 INVALID_JSON', async () => {
    const res = await api().post('/api/v1/auth/google').set('Content-Type', 'application/json').send('{"credential":');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('allows only allowlisted browser origins (CORS)', async () => {
    const allowed = await api().get('/api/v1/health').set('Origin', 'http://127.0.0.1:5501');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5501');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const denied = await api().get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('replaces unsafe X-Request-Id values', async () => {
    const res = await api().get('/api/v1/health').set('X-Request-Id', 'bad id with spaces and "quotes"');
    expect(res.headers['x-request-id']).not.toContain(' ');
    const kept = await api().get('/api/v1/health').set('X-Request-Id', 'trace-123');
    expect(kept.headers['x-request-id']).toBe('trace-123');
  });

  it('serves uploads with a sandbox Content-Security-Policy', async () => {
    const res = await api().get('/uploads/missing.svg');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
  });

  it('serves the CRM pages without the API security headers', async () => {
    const res = await api().get('/crm/frontend/login.html');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('hides unexpected error details behind a generic message', async () => {
    const app = express();
    app.get('/boom', () => { throw new Error('Mongo exploded with secrets'); });
    app.use(errorHandler);
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(res.body.message).not.toMatch(/Mongo/);
  });

  it('rate limits with 429 RATE_LIMITED', async () => {
    const { rateLimit } = require('express-rate-limit');
    const httpError = require('../utils/httpError');
    const app = express();
    app.use(rateLimit({
      windowMs: 60000,
      limit: 2,
      handler: (req, res, next) => next(httpError(429, 'RATE_LIMITED', 'Too many requests.')),
    }));
    app.get('/', (req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    await request(app).get('/');
    await request(app).get('/');
    const third = await request(app).get('/');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
  });
});

describe('Environment validation', () => {
  it('names the missing keys without printing values', () => {
    const saved = { ...process.env };
    try {
      delete process.env.MONGO_URI;
      process.env.JWT_SECRET = 'short';
      jest.isolateModules(() => {
        expect(() => require('../config/env')).toThrow(/MONGO_URI is required[\s\S]*JWT_SECRET/);
      });
    } finally {
      process.env = saved;
    }
  });

  it('has no hard-coded Google client ID fallback', () => {
    const saved = { ...process.env };
    try {
      delete process.env.GOOGLE_CLIENT_ID;
      jest.isolateModules(() => {
        expect(() => require('../config/env')).toThrow(/GOOGLE_CLIENT_ID is required/);
      });
    } finally {
      process.env = saved;
    }
  });
});
