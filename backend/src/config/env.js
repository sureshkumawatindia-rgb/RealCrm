require('dotenv').config();

const env = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/crm',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '910305219970-gimdha8ojccrddq4oocivgg8ha32kurl.apps.googleusercontent.com',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://127.0.0.1:3000/api/v1/gmail/oauth/callback',
  frontendUrl: process.env.FRONTEND_URL || 'http://127.0.0.1:5500/crm/frontend',
  gmailTokenEncryptionKey: process.env.GMAIL_TOKEN_ENCRYPTION_KEY || '',
  publicUrl: process.env.PUBLIC_URL || 'http://127.0.0.1:3000',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
};

module.exports = env;