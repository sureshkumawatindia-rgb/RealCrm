const Organization = require('../models/Organization');
const httpError = require('../utils/httpError');
const { CODE_PATTERN, tidyCompany, namePattern } = require('../utils/workspaceCode');

const NOT_FOUND = "We couldn't find this company. Check the name or ask your admin.";

// Only what the login card shows: the name, the logo (a public /uploads file) and the code the
// Google step sends back. Never an id.
const publicView = (organization) => ({ name: organization.name, logoUrl: organization.logoUrl || '', slug: organization.slug });

// An organization saved before migration 006 gets its code on the next save (models/Organization.js).
async function withCode(organization) {
  if (!organization.slug) await organization.save();
  return organization;
}

// The company someone typed on the login page (D66): the workspace code exactly, else the exact
// name (letter case and extra spaces ignored). Two companies with the same name need the code.
async function find(company) {
  const typed = tidyCompany(company);
  const code = typed.toLowerCase();
  if (CODE_PATTERN.test(code)) {
    const byCode = await Organization.findOne({ slug: code });
    if (byCode) return withCode(byCode);
  }
  const byName = await Organization.find({ name: namePattern(typed) }).limit(2);
  if (byName.length > 1) {
    throw httpError(409, 'WORKSPACE_AMBIGUOUS', 'More than one company has this name. Enter your workspace code instead. Your admin finds it in Settings → Company.');
  }
  if (!byName.length) throw httpError(404, 'WORKSPACE_NOT_FOUND', NOT_FOUND);
  return withCode(byName[0]);
}

// POST /auth/workspace { company } — the login page checks the company before Google.
async function lookup(company) {
  return publicView(await find(company));
}

// The code the login page sends with Google's answer.
async function byCode(code) {
  const organization = CODE_PATTERN.test(String(code || '')) ? await Organization.findOne({ slug: code }) : null;
  if (!organization) throw httpError(404, 'WORKSPACE_NOT_FOUND', NOT_FOUND);
  return organization;
}

const notInWorkspace = (organization) => httpError(403, 'NOT_IN_WORKSPACE', `This Google account hasn't been added to ${organization.name}. Ask your admin to add you.`);

module.exports = { find, lookup, byCode, publicView, notInWorkspace, NOT_FOUND };
