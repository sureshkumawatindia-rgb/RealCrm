const Job = require('../models/Job');
const queue = require('../jobs/queue');

// The MongoDB job queue (D10): due jobs run once, failures are retried with a growing pause,
// recurring jobs come back, one live job per unique key, and a job whose worker died is taken over.
describe('Job queue', () => {
  afterEach(async () => {
    await queue.stop();
    await Job.deleteMany({});
  });

  it('runs a due job once and leaves future jobs alone', async () => {
    const seen = [];
    queue.define('test.record', async (data) => { seen.push(data.n); });
    await queue.enqueue('test.record', { n: 1 });
    await queue.enqueue('test.record', { n: 2 }, { runAt: new Date(Date.now() + 60 * 60 * 1000) });
    await queue.runDue();
    await queue.runDue();
    expect(seen).toEqual([1]);
    expect(await Job.countDocuments({ status: 'done' })).toBe(1);
    expect(await Job.countDocuments({ status: 'queued' })).toBe(1);
  });

  it('retries a failing job later and gives up after the last attempt', async () => {
    let calls = 0;
    queue.define('test.flaky', async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    }, { maxAttempts: 2 });
    const job = await queue.enqueue('test.flaky');
    await queue.runDue();
    let stored = await Job.findById(job._id);
    expect(stored).toMatchObject({ status: 'queued', attempts: 1, lastError: 'boom 1' });
    expect(stored.runAt.getTime()).toBeGreaterThan(Date.now() + 20 * 1000); // waits ~30 s

    await Job.updateOne({ _id: job._id }, { runAt: new Date() });
    await queue.runDue();
    stored = await Job.findById(job._id);
    expect(stored).toMatchObject({ status: 'failed', attempts: 2, lastError: 'boom 2' });
    expect(stored.finishedAt).toBeTruthy();
    expect(queue.backoffMs(1)).toBe(30000);
    expect(queue.backoffMs(20)).toBe(30 * 60 * 1000);
  });

  it('keeps one live job per unique key; recurring jobs come back; cancel stops them', async () => {
    let runs = 0;
    queue.define('test.poll', async () => { runs += 1; });
    const first = await queue.every('test.poll', 5 * 60 * 1000, { source: 'a' }, { uniqueKey: 'poll:a' });
    const again = await queue.every('test.poll', 5 * 60 * 1000, { source: 'a' }, { uniqueKey: 'poll:a' });
    expect(String(again._id)).toBe(String(first._id));
    expect(await Job.countDocuments({ uniqueKey: 'poll:a' })).toBe(1);

    await queue.runDue();
    const after = await Job.findById(first._id);
    expect(runs).toBe(1);
    expect(after.status).toBe('queued');
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    await queue.cancel('poll:a');
    expect(await Job.countDocuments({ uniqueKey: 'poll:a' })).toBe(0);
  });

  it('takes over a job whose worker stopped, and does not let the old worker overwrite it', async () => {
    const seen = [];
    queue.define('test.orphan', async (data) => { seen.push(data.id); });
    const job = await Job.create({
      name: 'test.orphan', data: { id: 'x' }, runAt: new Date(Date.now() - 60000), status: 'running',
      attempts: 1, lockedBy: 'dead-worker', lockUntil: new Date(Date.now() - 1000),
    });
    await queue.runDue();
    expect(seen).toEqual(['x']);
    expect(await Job.findById(job._id)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('the running worker picks up new work straight away', async () => {
    const done = new Promise((resolve) => queue.define('test.fast', async (data) => resolve(data.at)));
    queue.start({ pollMs: 60 * 1000 }); // polling alone would take a minute
    const started = Date.now();
    await queue.enqueue('test.fast', { at: started });
    await done;
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
