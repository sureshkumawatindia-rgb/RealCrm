// Copies this server's files (DOCUMENT_DIR and UPLOAD_DIR) to Cloudflare R2, once (F5,
// docs/FOUNDATION_SETUP_STEPS.md). Run it in the production service's Shell on Render:
//   node scripts/files-to-r2.js           copy what is missing, then check each copy
//   node scripts/files-to-r2.js --check   only compare, change nothing
// It needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET. Nothing on the
// disk is changed or deleted. It ends with "0 missing, 0 failed" when every file is in R2.
const env = require('../src/config/env');
const { createR2Client } = require('../src/storage/r2Client');
const { copyToR2 } = require('../src/storage/copyToR2');

(async () => {
  const r2 = env.storage.r2;
  if (!r2.accessKeyId || !r2.secretAccessKey || !r2.bucket || !(r2.accountId || r2.endpoint)) {
    console.error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first.');
    process.exit(1);
  }
  const check = process.argv.includes('--check');
  const report = await copyToR2({
    client: createR2Client(r2),
    bucket: r2.bucket,
    documentDir: env.documentDir,
    uploadDir: env.uploadDir,
    check,
    log: (line) => console.log(line),
  });
  console.log(`${report.files} files: ${report.alreadyThere} already in R2, ${report.copied} copied, ${report.missing.length} missing, ${report.failed.length} failed`);
  [...report.missing.map((key) => `missing: ${key}`), ...report.failed.map((key) => `failed: ${key}`)].slice(0, 50).forEach((line) => console.log(line));
  process.exitCode = report.ok ? 0 : 1;
})().catch((error) => {
  console.error(`Copy stopped: ${error.message}`);
  process.exit(1);
});
