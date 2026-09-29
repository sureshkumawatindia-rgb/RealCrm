const crypto = require('crypto');

// JustDial and TradeIndia publish no developer documentation (checked 2026-09-29). Sellers get
// leads pushed by giving their account manager a URL; the format differs between accounts. So
// this reads whatever arrives (query string, JSON or form fields, one lead or a list) and looks
// for the usual field names. Anything it cannot read is kept raw in the intake log, so the
// mapping can be added once a real sample is seen.
const FIELDS = {
  ref: ['leadid', 'enquiryid', 'inquiryid', 'queryid', 'uniqueid', 'uniquequeryid', 'rfqid', 'id'],
  name: ['name', 'leadname', 'customername', 'sendername', 'buyername', 'contactperson', 'contactname', 'fullname', 'prefixname'],
  phone: ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'phonenumber', 'sendermobile', 'buyermobile', 'contactno', 'contactnumber', 'contact'],
  email: ['email', 'emailid', 'senderemail', 'buyeremail', 'mail'],
  company: ['company', 'companyname', 'sendercompany', 'buyercompany', 'firm', 'business'],
  city: ['city', 'sendercity', 'buyercity', 'area', 'location'],
  state: ['state', 'senderstate', 'buyerstate'],
  address: ['address', 'senderaddress', 'buyeraddress'],
  product: ['product', 'productname', 'category', 'service', 'subject', 'queryproductname', 'item'],
  message: ['message', 'requirement', 'requirements', 'query', 'enquiry', 'inquiry', 'description', 'details', 'remarks', 'querymessage'],
  quantity: ['quantity', 'qty'],
};
const LIST_KEYS = ['leads', 'data', 'response', 'records', 'items', 'enquiries', 'inquiries'];

const squash = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(flat, names) {
  for (const name of names) {
    const value = flat[name];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

// The leads inside a payload: a list under a common key, the payload itself, or its "RESPONSE".
function leadsIn(payload) {
  if (Array.isArray(payload)) return payload.filter((item) => item && typeof item === 'object');
  if (!payload || typeof payload !== 'object') return [];
  for (const [key, value] of Object.entries(payload)) {
    if (!LIST_KEYS.includes(squash(key))) continue;
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
    if (value && typeof value === 'object') return [value];
  }
  return [payload];
}

function toIntake(lead) {
  const flat = {};
  for (const [key, value] of Object.entries(lead)) {
    if (value != null && typeof value !== 'object') flat[squash(key)] = value;
  }
  const found = Object.fromEntries(Object.entries(FIELDS).map(([field, names]) => [field, pick(flat, names)]));
  // Without an id of its own, the same content arriving twice (a retry) is taken once.
  const sourceRef = found.ref || `hash:${crypto.createHash('sha256').update(JSON.stringify(lead)).digest('hex').slice(0, 32)}`;
  return {
    sourceRef,
    person: { name: found.name, phone: found.phone, email: found.email, company: found.company, city: found.city, state: found.state, address: found.address },
    enquiry: { product: found.product, message: found.message, quantity: found.quantity },
  };
}

module.exports = { leadsIn, toIntake };
