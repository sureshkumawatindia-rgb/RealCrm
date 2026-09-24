module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/tests'],
  globalSetup: '<rootDir>/src/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/src/tests/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/src/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup/db.js'],
  testTimeout: 30000,
};
