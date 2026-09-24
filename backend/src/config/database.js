const mongoose = require('mongoose');
const env = require('./env');
const logger = require('./logger');

const connectDB = async () => {
  try {
    await mongoose.connect(env.mongoUri);
    logger.info(`MongoDB Connected: ${mongoose.connection.host}`);
  } catch (error) {
    logger.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
