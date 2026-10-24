// Support: turns off someone's 2-step login (authenticator app, F7) when they lost the phone and
// their backup codes, and no other owner or admin of their company can do it (a one-owner
// company, or a person in several companies). Check who is asking first (their Google account,
// their company, a call back on the number you know). In the production service's Shell:
//   node scripts/totp-reset.js <email> --yes
// Their remembered browsers are forgotten too; an owner or admin gets a fresh grace period. The
// reset is written to the audit log of each of their companies.
const mongoose = require('mongoose');
const env = require('../src/config/env');
const User = require('../src/models/User');
const OrganizationMember = require('../src/models/OrganizationMember');
const AuditLog = require('../src/models/AuditLog');
const totpService = require('../src/services/totpService');

(async () => {
  const [email, confirm] = process.argv.slice(2);
  if (!email || confirm !== '--yes') {
    console.error('Usage: node scripts/totp-reset.js <email> --yes');
    process.exit(1);
  }
  await mongoose.connect(env.mongoUri);
  const user = await User.findOne({ email: email.toLowerCase().trim() });
  if (!user) throw new Error(`No account with the email ${email}`);
  if (!totpService.enabled(user)) {
    console.log(`${user.email} does not use an authenticator app; nothing to reset.`);
    return;
  }
  await totpService.resetFor(user._id);
  const memberships = await OrganizationMember.find({ userId: user._id, status: 'active' }).select('organizationId');
  for (const member of memberships) {
    await AuditLog.create({ organizationId: member.organizationId, action: 'support.totp_reset', entityType: 'User', entityId: String(user._id), changes: { by: 'support script' } });
  }
  console.log(`2-step login turned off for ${user.email} (${memberships.length} companies told in their audit log).`);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
