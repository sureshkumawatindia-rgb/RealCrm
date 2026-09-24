const app = require('./app');
const connectDB = require('./config/database');
const env = require('./config/env');
const logger = require('./config/logger');

const startServer = async () => {
  await connectDB();
  
  app.listen(env.port, () => {
    logger.info(`Server running in ${env.nodeEnv} mode on port ${env.port}`);
  });
};

startServer();
