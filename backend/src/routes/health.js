const express = require('express');
const mongoose = require('mongoose');
const env = require('../config/env');
const Job = require('../models/Job');

const router = express.Router();

// Jobs waiting longer than this make the CRM "DEGRADED" (still 200: the server answers, so the
// platform does not restart it; the watchdog and UptimeRobot alert on it).
const LATE_JOBS_SECONDS = 15 * 60;

// The platform, UptimeRobot and the alert watchdog (F3) ask this: 503 when the database is
// down. It says which copy this is and its version, and nothing secret.
router.get('/', async (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  let queueDelaySeconds = null;
  if (isDbConnected) {
    const oldest = await Job.findOne({ status: 'queued', runAt: { $lte: new Date() } })
      .sort({ runAt: 1 }).select('runAt').maxTimeMS(2000).lean().catch(() => null);
    queueDelaySeconds = oldest ? Math.max(0, Math.round((Date.now() - oldest.runAt.getTime()) / 1000)) : 0;
  }
  const status = !isDbConnected ? 'DOWN' : queueDelaySeconds > LATE_JOBS_SECONDS ? 'DEGRADED' : 'UP';

  res.status(isDbConnected ? 200 : 503).json({
    success: isDbConnected,
    message: isDbConnected ? 'API is healthy' : 'Database connection issue',
    data: {
      status,
      dbState: mongoose.connection.readyState,
      timestamp: new Date().toISOString(),
      environment: env.appEnv,
      version: env.release || null,
      // Which server answered (Render names each instance), to see both at work (F6).
      instance: process.env.RENDER_INSTANCE_ID || null,
      queueDelaySeconds,
    },
  });
});

module.exports = router;
