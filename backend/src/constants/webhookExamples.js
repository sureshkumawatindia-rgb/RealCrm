// What each webhook event's "data" looks like (Phase 1F, D78): shown in Settings → API & webhooks
// next to the event, for Zapier and Make, and checked by the tests against the real payloads'
// keys. Shapes are the public API's (services/publicApiService.js); values are made up.
const contact = {
  id: '6720a1b2c3d4e5f601234567', name: 'Kota Stone Works', phone: '+919829051001', email: 'orders@kotastone.in', company: 'Kota Stone Works',
  gstin: '08ABCDE1234F1Z5', city: 'Kota', state: 'Rajasthan', address: '', tags: ['dealer'], source: 'IndiaMART', lifecycle: 'customer',
  marketingConsent: 'opted_in', customFields: { credit_days: 30, dealer_type: 'Wholesale' }, createdAt: '2026-10-20T05:30:00.000Z', updatedAt: '2026-10-21T06:10:00.000Z',
};
const lead = {
  id: '6720a1b2c3d4e5f601234568', title: 'Monoblock pumps x10', stage: 'Quote Sent', lostReason: '', source: 'IndiaMART',
  contactId: contact.id, contact: { id: contact.id, name: contact.name, phone: contact.phone, email: contact.email, company: contact.company, customFields: contact.customFields },
  ownerId: '6720a1b2c3d4e5f6012345aa', expectedValuePaise: 11800000, probability: 50, quantity: 10, notes: '', stageChangedAt: '2026-10-21T06:10:00.000Z',
  customFields: { visit_date: '2026-10-25' }, createdAt: '2026-10-20T05:30:00.000Z', updatedAt: '2026-10-21T06:10:00.000Z',
};
const item = { productId: null, name: 'Monoblock pump 1HP', hsnSac: '8413', unit: 'pcs', quantity: 10, unitPricePaise: 1000000, gstRatePct: 18, taxablePaise: 8200000, taxPaise: 1476000, totalPaise: 9676000 };
const quotation = {
  id: '6720a1b2c3d4e5f601234569', number: 'QT/2026-27/0042', type: 'Quotation', status: 'Draft', revision: 0, contactId: contact.id, leadId: lead.id,
  billTo: { name: contact.name, gstin: contact.gstin }, items: [item], taxablePaise: 8200000, taxPaise: 1476000, totalPaise: 9676000,
  quotationDate: '2026-10-21T06:00:00.000Z', validUntil: '2026-11-05T00:00:00.000Z', sentAt: null, acceptedAt: null, createdAt: '2026-10-21T06:00:00.000Z', updatedAt: '2026-10-21T06:10:00.000Z',
};
const order = {
  id: '6720a1b2c3d4e5f60123456a', number: 'SO/2026-27/0007', stage: 'Confirmed', source: 'quotation', contactId: contact.id, leadId: lead.id, quotationId: quotation.id,
  items: [item], totalPaise: 9676000, paymentStatus: 'partly_paid', amountPaidPaise: 2000000, duePaise: 7676000,
  payments: [{ amountPaise: 2000000, method: 'upi', source: 'payment_link', reference: 'pay_N1a2b3', paidAt: '2026-10-21T07:00:00.000Z' }],
  createdAt: '2026-10-21T06:30:00.000Z', updatedAt: '2026-10-21T07:00:00.000Z',
};
const record = {
  id: '6720a1b2c3d4e5f60123456b', object: 'x_machines', name: 'CNC-200 main', contactId: contact.id, ownerId: lead.ownerId,
  customFields: { serial_number: 'SN-4471', install_date: '2026-03-14', amc_type: 'Comprehensive' }, createdAt: '2026-10-21T06:00:00.000Z', updatedAt: '2026-10-21T06:20:00.000Z',
};
const approval = {
  state: 'pending',
  reasons: [{ ruleName: 'Dealer discount', kind: 'discount', value: 18, limit: 10 }],
  requestedById: lead.ownerId, requestedAt: '2026-10-21T06:12:00.000Z', decidedById: null, decidedAt: null, comment: '',
};

const WEBHOOK_EXAMPLES = Object.freeze({
  'lead.created': { lead },
  'lead.stage_changed': { lead, from: 'Contacted', to: 'Quote Sent' },
  'contact.created': { contact },
  'contact.updated': { contact },
  'message.received': { message: { id: '6720a1b2c3d4e5f60123456c', type: 'text', text: 'Price for 20 pieces?', at: '2026-10-21T06:05:00.000Z' }, conversationId: '6720a1b2c3d4e5f60123456d', contact },
  'quotation.status_changed': { quotation: { ...quotation, status: 'Sent', sentAt: '2026-10-21T06:15:00.000Z' }, from: 'Draft', to: 'Sent' },
  'quotation.approval_requested': { quotation, approval },
  'quotation.approval_decided': { quotation, approval: { ...approval, state: 'approved', decidedById: '6720a1b2c3d4e5f6012345ab', decidedAt: '2026-10-21T06:14:00.000Z' } },
  'order.created': { order },
  'order.stage_changed': { order, from: 'Confirmed', to: 'Dispatched' },
  'payment.received': { amountPaise: 2000000, orderId: order.id, leadId: lead.id, order, contact },
  'record.created': { record },
  'record.updated': { record },
  'record.deleted': { record: { id: record.id, object: record.object, name: record.name } },
});

module.exports = { WEBHOOK_EXAMPLES };
