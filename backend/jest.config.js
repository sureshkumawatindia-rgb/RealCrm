module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/tests'],
  globalSetup: '<rootDir>/src/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/src/tests/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/src/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup/db.js'],
  testTimeout: 30000,
  // Every test file builds all indexes on the one in-memory MongoDB; with a worker per CPU core
  // (19 here) the first round's setup ran past the 30 s timeout.
  maxWorkers: '40%',
};
