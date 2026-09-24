const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const requestId = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');
const routes = require('./routes');
const logger = require('./config/logger');
const path = require('path');
const env = require('./config/env');

const app = express();

app.use(requestId);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(path.resolve(env.uploadDir)));

app.use(morgan('combined', {
  stream: { write: message => logger.info(message.trim()) }
}));

app.use('/api/v1', routes);

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: 'Resource not found',
    code: 'NOT_FOUND',
    requestId: req.id
  });
});

app.use(errorHandler);

module.exports = app;
