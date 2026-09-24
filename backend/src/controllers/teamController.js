const memberService = require('../services/memberService');
const inviteService = require('../services/inviteService');

async function listMembers(req, res) {
  const { items, pagination } = await memberService.list(req, req.valid.query);
  res.json({ success: true, data: items, pagination });
}

async function updateMember(req, res) {
  res.json({ success: true, data: await memberService.update(req, req.valid.params.id, req.body), message: 'Member updated' });
}

async function removeMember(req, res) {
  await memberService.remove(req, req.valid.params.id);
  res.json({ success: true, data: { removed: true }, message: 'Member removed' });
}

async function listInvites(req, res) {
  const { status, ...pageQuery } = req.valid.query;
  const { items, pagination } = await inviteService.list(req, pageQuery, { status });
  res.json({ success: true, data: items, pagination });
}

async function createInvite(req, res) {
  res.status(201).json({ success: true, data: await inviteService.create(req, req.body), message: 'Invite created' });
}

async function resendInvite(req, res) {
  res.json({ success: true, data: await inviteService.resend(req, req.valid.params.id), message: 'Invite renewed' });
}

async function revokeInvite(req, res) {
  res.json({ success: true, data: await inviteService.revoke(req, req.valid.params.id), message: 'Invite revoked' });
}

async function lookupInvite(req, res) {
  res.json({ success: true, data: await inviteService.lookup(req.body.token) });
}

module.exports = { listMembers, updateMember, removeMember, listInvites, createInvite, resendInvite, revokeInvite, lookupInvite };
