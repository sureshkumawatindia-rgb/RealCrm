// A company's workspace code (D66): the short name its team types on the login page, like
// "sharma-traders". Small letters and digits, single hyphens between them, 2-40 characters.
const CODE_PATTERN = /^(?=.{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LENGTH = 40;
// A name with no Latin letters or digits (a Hindi name, say) gets this code (company-2 when taken).
const FALLBACK = 'company';

// What a person typed: spaces trimmed and collapsed, so "  Sharma   Traders " is "Sharma Traders".
const tidyCompany = (text) => String(text || '').trim().replace(/\s+/g, ' ');

function codeFromName(name) {
  const code = tidyCompany(name)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // accents dropped: "Café" is "cafe"
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '');
  return CODE_PATTERN.test(code) ? code : FALLBACK;
}

// Room for "-999" after a long code.
const stemOf = (base) => base.slice(0, MAX_LENGTH - 4).replace(/-+$/, '') || FALLBACK;

// The first free code from `base`: base, base-2, base-3 ... (organizationId: its own code is free).
async function uniqueCode(Organization, base, { session = null, organizationId = null } = {}) {
  const stem = stemOf(base);
  const query = Organization.find({ slug: new RegExp(`^(${base}|${stem}-\\d+)$`), ...(organizationId && { _id: { $ne: organizationId } }) }, { slug: 1 }).lean();
  if (session) query.session(session);
  const taken = new Set((await query).map((organization) => organization.slug));
  if (!taken.has(base)) return base;
  for (let number = 2; ; number += 1) {
    if (!taken.has(`${stem}-${number}`)) return `${stem}-${number}`;
  }
}

// Whether a code is still the one made from this name (not one an owner chose): it then follows
// the name when the company is renamed.
function followsName(code, name) {
  const base = codeFromName(name);
  return code === base || new RegExp(`^${stemOf(base)}-\\d+$`).test(code);
}

// An escaped, anchored, case-insensitive pattern for a company name, any run of spaces matching
// any run of spaces ("sharma traders" finds "Sharma  Traders", not "Sharma Traders Pvt Ltd").
function namePattern(company) {
  const words = tidyCompany(company).split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^\\s*${words.join('\\s+')}\\s*$`, 'i');
}

module.exports = { CODE_PATTERN, MAX_LENGTH, tidyCompany, codeFromName, uniqueCode, followsName, namePattern };
