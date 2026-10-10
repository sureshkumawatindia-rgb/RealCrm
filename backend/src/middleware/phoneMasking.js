const { maskPhonesIn, stripMaskedPhones } = require('../utils/phoneMask');

// Customers' numbers for agents and viewers (D65). authenticate sets req.maskPhones; every JSON
// answer to such a member is masked here, whichever route sent it. The member's own sign-in and
// the company's own details (its phone, its WhatsApp numbers, the team) are not customer data.
const COMPANY_PATHS = ['/auth', '/organization', '/members', '/invites', '/billing', '/push', '/site', '/health', '/whatsapp/accounts', '/whatsapp/connect'];

function phoneMasking(req, res, next) {
  // A masked number coming back from a form is dropped, whoever sends it: the real one stays.
  if (req.body && typeof req.body === 'object') stripMaskedPhones(req.body);
  const path = req.path; // nested routers change req.path before the answer is sent
  const companyData = COMPANY_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  const json = res.json.bind(res);
  res.json = (body) => json(req.maskPhones && !companyData ? maskPhonesIn(body) : body);
  next();
}

module.exports = phoneMasking;
