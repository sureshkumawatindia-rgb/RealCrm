const mongoose = require('mongoose');

// A rate-limit count kept in MongoDB (F6), for the limits that stop people guessing (sign-in,
// company names): with two servers, both count together. One document per key and minute
// window ("<limit>:<key>:<window start>"), removed by MongoDB after its window (TTL). Plugs into
// express-rate-limit as its store.
const RateLimitHit = mongoose.models.RateLimitHit || mongoose.model('RateLimitHit', new mongoose.Schema({
  _id: { type: String },
  hits: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true, expires: 0 },
}, { versionKey: false }));

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class MongoRateLimitStore {
  constructor(name) {
    this.name = name;
    this.localKeys = false;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  window(now = Date.now()) {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    return { start, resetTime: new Date(start + this.windowMs) };
  }

  async increment(key) {
    const { start, resetTime } = this.window();
    const id = `${this.name}:${key}:${start}`;
    const add = () => RateLimitHit.findOneAndUpdate(
      { _id: id },
      { $inc: { hits: 1 }, $setOnInsert: { expiresAt: new Date(resetTime.getTime() + 60 * 1000) } },
      { upsert: true, returnDocument: 'after', lean: true },
    );
    let doc;
    try {
      doc = await add();
    } catch (error) {
      if (error.code !== 11000) throw error;
      doc = await add(); // two first hits at the same moment: the second one counts again
    }
    return { totalHits: doc.hits, resetTime };
  }

  async get(key) {
    const { start, resetTime } = this.window();
    const doc = await RateLimitHit.findById(`${this.name}:${key}:${start}`).lean();
    return doc ? { totalHits: doc.hits, resetTime } : undefined;
  }

  async decrement(key) {
    const { start } = this.window();
    await RateLimitHit.updateOne({ _id: `${this.name}:${key}:${start}`, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
  }

  async resetKey(key) {
    await RateLimitHit.deleteMany({ _id: { $regex: `^${escapeRegex(`${this.name}:${key}:`)}` } });
  }
}

module.exports = { MongoRateLimitStore, RateLimitHit };
