jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const http = require('http');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { io: connect } = require('socket.io-client');
const { rateLimit } = require('express-rate-limit');
const bus = require('../realtime/bus');
const { attachRealtime } = require('../realtime/socket');
const { MongoRateLimitStore } = require('../middleware/rateLimitStore');
const { withServerLock, ServerLock } = require('../utils/serverLock');
const { runMigrations, MIGRATIONS } = require('../migrations');
const Migration = require('../models/Migration');
const InboundEvent = require('../models/InboundEvent');
const inbound = require('../services/whatsappInboundService');
const { login } = require('./helpers/api');

// Two servers at once (F6): the live inbox reaches browsers on either server, the sign-in limits
// count together, migrations run once, and a WhatsApp event is handled by one server only.

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

describe('Live inbox across two servers', () => {
  it('sends an update made on one server to browsers on the other, once', async () => {
    const owner = await login('f6-live@example.com');
    const memberId = owner.data.member.id;
    // Server A takes the CRM's events; server B stands in for a second server (it only replays).
    const servers = [http.createServer(), http.createServer()];
    const ios = [attachRealtime(servers[0], { relay: true }), attachRealtime(servers[1], { relay: true, listen: false })];
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); })));
    await Promise.all(ios.map((io) => io.relayReady()));
    const clients = servers.map((server) => connect(`http://127.0.0.1:${server.address().port}`, { auth: { token: owner.token }, transports: ['websocket'], forceNew: true }));
    try {
      await Promise.all(clients.map((client) => new Promise((resolve, reject) => { client.on('connect', resolve); client.on('connect_error', reject); })));
      const received = [[], []];
      clients.forEach((client, i) => client.on('notification:new', (note) => received[i].push(note.title)));

      bus.emit('notification:new', { memberId, notification: { title: 'Lead assigned to you' } });
      for (let i = 0; i < 50 && received[1].length < 1; i += 1) await pause(100);
      await pause(300); // anything doubled would arrive by now
      expect(received).toEqual([['Lead assigned to you'], ['Lead assigned to you']]);

      // Access changed on server A: the member's browser on server B is dropped too.
      const dropped = new Promise((resolve) => { clients[1].on('disconnect', resolve); });
      bus.emit('member:access-changed', { memberId });
      await expect(Promise.race([dropped.then(() => 'dropped'), pause(5000).then(() => 'still connected')])).resolves.toBe('dropped');
    } finally {
      clients.forEach((client) => client.close());
      await Promise.all(ios.map((io) => io.detach()));
      await Promise.all(ios.map((io) => new Promise((resolve) => { io.close(resolve); })));
    }
  });
});

describe('Sign-in limits counted together', () => {
  it('stops the fourth try from one address whichever server answers', async () => {
    const app = () => {
      const server = express();
      server.set('trust proxy', 1);
      server.use(rateLimit({ windowMs: 60 * 1000, limit: 3, store: new MongoRateLimitStore('f6-test'), standardHeaders: 'draft-8', legacyHeaders: false }));
      server.get('/', (req, res) => res.send('ok'));
      return server;
    };
    const [a, b] = [app(), app()];
    const from = (server) => request(server).get('/').set('X-Forwarded-For', '203.0.113.9');
    expect((await from(a)).status).toBe(200);
    expect((await from(b)).status).toBe(200);
    expect((await from(a)).status).toBe(200);
    expect((await from(b)).status).toBe(429);
    expect((await request(a).get('/').set('X-Forwarded-For', '203.0.113.10')).status).toBe(200); // another address
  });
});

describe('One server at a time', () => {
  it('runs locked work one after the other, and takes over a lock whose server died', async () => {
    const order = [];
    const job = (name) => async () => {
      order.push(`${name} start`);
      await pause(150);
      order.push(`${name} end`);
    };
    await Promise.all([withServerLock('f6-lock', job('first'), { pollMs: 50 }), withServerLock('f6-lock', job('second'), { pollMs: 50 })]);
    expect(order[1]).toMatch(/end$/);
    expect(order[3]).toMatch(/end$/);
    expect(await ServerLock.countDocuments({ _id: 'f6-lock' })).toBe(0);

    await ServerLock.create({ _id: 'f6-dead', owner: 'gone-server', until: new Date(Date.now() - 1000) });
    await expect(withServerLock('f6-dead', async () => 'ran', { pollMs: 50 })).resolves.toBe('ran');
  });

  it('applies each migration once when two servers start together', async () => {
    await Promise.all([runMigrations(), runMigrations()]);
    for (const migration of MIGRATIONS) expect(await Migration.countDocuments({ name: migration.name })).toBe(1);
  });

  it('handles a WhatsApp event on one server only, and picks up one whose server stopped', async () => {
    const event = await InboundEvent.create({ provider: 'whatsapp', eventId: 'f6:wamid.ONE', kind: 'message', sourceId: new mongoose.Types.ObjectId(), payload: {} });
    await Promise.all([inbound.processNow([event._id]), inbound.processNow([event._id])]);
    const done = await InboundEvent.findById(event._id);
    expect(done.attempts).toBe(1); // taken once
    expect(done.status).toBe('ignored'); // no such number here
    expect(done.claimedUntil).toBeUndefined();

    // A server took it and stopped: after its claim runs out, the retry picks it up.
    const stuck = await InboundEvent.create({ provider: 'whatsapp', eventId: 'f6:wamid.TWO', kind: 'message', sourceId: new mongoose.Types.ObjectId(), payload: {}, status: 'processing', attempts: 1, claimedUntil: new Date(Date.now() - 1000) });
    const taken = await InboundEvent.create({ provider: 'whatsapp', eventId: 'f6:wamid.THREE', kind: 'message', sourceId: new mongoose.Types.ObjectId(), payload: {}, status: 'processing', attempts: 1, claimedUntil: new Date(Date.now() + 60 * 1000) });
    await inbound.retryPending();
    expect((await InboundEvent.findById(stuck._id)).status).toBe('ignored');
    expect((await InboundEvent.findById(taken._id)).status).toBe('processing'); // still another server's
  });
});
