const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const connectDB = require('./config/database');
const { runMigrations } = require('./migrations');
const whatsappInbound = require('./services/whatsappInboundService');

const startServer = async () => {
  env.warnings.forEach((warning) => logger.warn(warning));
  await connectDB();
  await runMigrations();
  // WhatsApp webhook items left unprocessed by a restart or an error are picked up again.
  whatsappInbound.startRetryLoop();

  app.listen(env.port, () => {
    logger.info(`Server running in ${env.nodeEnv} mode on port ${env.port}`);
  });
};

startServer().catch((error) => {
  logger.error(`Server failed to start: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
