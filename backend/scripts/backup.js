// The weekly R2 backup copy (F4a, docs/FOUNDATION_SETUP_STEPS.md), by hand. In the production
// service's Shell on Render:
//   node scripts/backup.js list          the backups in R2_BACKUP_BUCKET, newest first
//   node scripts/backup.js run           make one now (the job also does it every Sunday)
//   node scripts/backup.js check [day]   download, decrypt and count one (default: the newest)
// Backups are encrypted with a key made from DATA_ENCRYPTION_KEY: keep that key safe.
const mongoose = require('mongoose');
const env = require('../src/config/env');
const backups = require('../src/services/backupService');

(async () => {
  if (!backups.configured()) {
    console.error('Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BACKUP_BUCKET first.');
    process.exit(1);
  }
  const [command = 'list', day] = process.argv.slice(2);
  if (command === 'list') {
    const all = await backups.list();
    if (!all.length) console.log('No backups yet.');
    all.forEach((b) => console.log(`${b.day}  ${b.files} files  ${(b.bytes / 1024 / 1024).toFixed(1)} MB  ${b.complete ? 'complete' : 'INCOMPLETE'}`));
  } else if (command === 'run') {
    await mongoose.connect(env.mongoUri);
    const result = await backups.run();
    console.log(`Backup ${result.day}: ${result.collections} collections, ${result.documents} documents; removed: ${result.removed.join(', ') || 'none'}`);
  } else if (command === 'check') {
    const target = day || (await backups.list()).find((b) => b.complete)?.day;
    if (!target) throw new Error('No complete backup to check');
    const result = await backups.check(target);
    console.log(`Backup ${result.day}: ${result.ok ? 'OK' : 'PROBLEMS'}${result.collections ? `, ${result.collections} collections, ${result.documents} documents` : ''}`);
    result.problems.forEach((line) => console.log(`- ${line}`));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    throw new Error(`Unknown command "${command}" (list, run or check)`);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
