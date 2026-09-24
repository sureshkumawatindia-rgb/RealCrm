const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const connectDB = require('./config/database');
const { runMigrations } = require('./migrations');

const startServer = async () => {
  env.warnings.forEach((warning) => logger.warn(warning));
  await connectDB();
  await runMigrations();

  app.listen(env.port, () => {
    logger.info(`Server running in ${env.nodeEnv} mode on port ${env.port}`);
  });
};

startServer().catch((error) => {
  logger.error(`Server failed to start: ${error.message}`, { stack: error.stack });
  process.exit(1);
});
