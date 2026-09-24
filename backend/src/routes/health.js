const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

router.get('/', (req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  
  res.status(isDbConnected ? 200 : 503).json({
    success: isDbConnected,
    message: isDbConnected ? 'API is healthy' : 'Database connection issue',
    data: {
      status: isDbConnected ? 'UP' : 'DOWN',
      dbState: mongoose.connection.readyState,
      timestamp: new Date().toISOString()
    }
  });
});

module.exports = router;
