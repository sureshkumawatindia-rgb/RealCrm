module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/tests'],
  globalSetup: '<rootDir>/src/tests/setup/globalSetup.js',
  globalTeardown: '<rootDir>/src/tests/setup/globalTeardown.js',
  setupFiles: ['<rootDir>/src/tests/setup/env.js'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup/db.js'],
  // A test that hangs still fails; the heaviest ones (PDFs, a 200-row background job, the 2-step
  // grace days) need more than 30 s on a slower machine while every file runs at once.
  testTimeout: 90000,
  // Every test file builds all indexes on the one in-memory MongoDB; with a worker per CPU core
  // (19 here) the first round's setup ran past the 30 s timeout.
  maxWorkers: '40%',
};
