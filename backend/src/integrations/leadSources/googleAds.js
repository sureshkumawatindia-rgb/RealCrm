// Google Ads lead form webhook, checked 2026-09-29:
// https://developers.google.com/google-ads/webhook/docs/implementation
// Google POSTs JSON { lead_id, user_column_data: [{ column_id, column_name, string_value }], form_id,
// campaign_id, google_key, is_test, gcl_id, … } to our URL. google_key is the key the advertiser
// typed into the form: it must match before a lead is taken. Answer 200 with {}; 4xx is final,
// 5xx is retried. A lead may arrive more than once (dedupe by lead_id).
const COLUMNS = {
  FULL_NAME: 'name', FIRST_NAME: 'first', LAST_NAME: 'last', EMAIL: 'email', WORK_EMAIL: 'email',
  PHONE_NUMBER: 'phone', PHONE_NUMBER_VERIFIED: 'phone', WORK_PHONE: 'phone', CITY: 'city', REGION: 'state',
  COMPANY_NAME: 'company', STREET_ADDRESS: 'address', POSTAL_CODE: 'postcode',
};

function toIntake(payload) {
  const fields = {};
  const extra = [];
  for (const column of Array.isArray(payload.user_column_data) ? payload.user_column_data : []) {
    const value = String(column?.string_value ?? '').trim();
    if (!value) continue;
    const key = COLUMNS[String(column.column_id || '').toUpperCase()];
    if (key && !fields[key]) fields[key] = value;
    else extra.push(`${column.column_name || column.column_id || 'Answer'}: ${value}`);
  }
  return {
    sourceRef: String(payload.lead_id || '').trim(),
    isTest: payload.is_test === true || payload.is_test === 'true',
    person: {
      name: fields.name || [fields.first, fields.last].filter(Boolean).join(' '),
      phone: fields.phone || '', email: fields.email || '', company: fields.company || '',
      city: fields.city || '', state: fields.state || '', address: [fields.address, fields.postcode].filter(Boolean).join(' '),
    },
    enquiry: { product: '', message: extra.join('\n') },
  };
}

module.exports = { toIntake };
