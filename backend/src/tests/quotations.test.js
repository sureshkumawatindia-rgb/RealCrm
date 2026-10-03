jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const Quotation = require('../models/Quotation');
const quotationService = require('../services/quotationService');
const migration = require('../migrations/002-quotations-v2');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 5A: billing settings, GST quotations through the API, revisions, statuses, expiry.
const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;

describe('Billing settings', () => {
  it('owners and admins set bank, UPI, terms and prefixes; the GST state comes from the GSTIN', async () => {
    const owner = await login('bill-owner@example.com');
    const agent = await inviteAndJoin(owner.token, 'bill-agent@example.com', { role: 'agent' });
    const initial = await api().get('/api/v1/organization/billing').set(bearer(owner.token));
    expect(initial.body.data).toMatchObject({ upiId: '', validityDays: 15, roundOff: true, reduceStockOnDispatch: false, stateCode: '', stateFrom: '', prefixes: { quotation: 'QT', estimate: 'EST', proforma: 'PI', order: 'SO' } });
    expect((await api().get('/api/v1/organization/billing').set(bearer(agent.token))).status).toBe(403);

    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ state: 'Rajasthan' });
    expect((await api().get('/api/v1/organization/billing').set(bearer(owner.token))).body.data).toMatchObject({ stateCode: '08', state: 'Rajasthan', stateFrom: 'address' });
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ gstin: '27AAACY1234C1Z5' });
    expect((await api().get('/api/v1/organization/billing').set(bearer(owner.token))).body.data).toMatchObject({ stateCode: '27', state: 'Maharashtra', stateFrom: 'gstin' });

    const saved = await api().put('/api/v1/organization/billing').set(bearer(owner.token)).send({
      bank: { accountName: 'Yellow Traders', accountNumber: '50100012345678', ifsc: 'hdfc0001234', bankName: 'HDFC Bank' },
      upiId: 'yellowtraders@okhdfcbank', terms: '50% advance.', validityDays: 7, prefixes: { quotation: 'YT-Q' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ bank: { ifsc: 'HDFC0001234', branch: '' }, upiId: 'yellowtraders@okhdfcbank', validityDays: 7, prefixes: { quotation: 'YT-Q', estimate: 'EST' } });

    const bad = async (body) => (await api().put('/api/v1/organization/billing').set(bearer(owner.token)).send(body)).status;
    expect(await bad({ bank: { ifsc: 'HDFC1234' } })).toBe(400);
    expect(await bad({ upiId: 'not a upi id' })).toBe(400);
    expect(await bad({ prefixes: { estimate: 'YT-Q' } })).toBe(400); // same as quotations
    expect(await bad({ prefixes: { order: 'has space' } })).toBe(400);
    expect((await api().put('/api/v1/organization/billing').set(bearer(agent.token)).send({ upiId: 'a@b' })).status).toBe(403);
  });
});

describe('Quotations', () => {
  let owner;
  let cumin;
  let rack;
  let rajasthan; // contact in the seller's state
  let gujarat; // contact with a Gujarat GSTIN
  let lead;
  const post = (path, body, token = owner.token) => api().post(`/api/v1${path}`).set(bearer(token)).send(body);
  const patch = (path, body, token = owner.token) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body);

  beforeAll(async () => {
    owner = await login('quote5-owner@example.com');
    await patch('/organization', { name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: 'MI Road', city: 'Jaipur' });
    cumin = (await post('/products', { name: 'Cumin Seeds', unit: 'kg', hsnSac: '0909', pricePaise: 25000, gstRatePct: 5 })).body.data;
    rack = (await post('/products', { name: 'Steel Rack', unit: 'pcs', hsnSac: '9403', pricePaise: 899950, gstRatePct: 18 })).body.data;
    rajasthan = (await post('/contacts', { name: 'Ravi Traders', phone: '9829012345', state: 'Rajasthan', city: 'Jodhpur' })).body.data;
    gujarat = (await post('/contacts', { name: 'Surat Mart', phone: '9824012345', gstin: '24AAACS1234C1Z5' })).body.data;
    lead = (await post('/leads', { contactId: rajasthan.id, title: 'Cumin enquiry' })).body.data;
  });

  it('prices a quotation for a lead in the seller\'s state with CGST + SGST, from the product details', async () => {
    const res = await post('/quotations', { leadId: lead.id, items: [{ productId: cumin.id, quantity: 10 }, { productId: rack.id, quantity: 1, discountType: 'percent', discountValue: 5 }] });
    expect(res.status).toBe(201);
    const q = res.body.data;
    expect(q).toMatchObject({
      type: 'Quotation', status: 'Draft', revision: 0, leadId: lead.id, contactId: rajasthan.id,
      billTo: { name: 'Ravi Traders', state: 'Rajasthan', stateCode: '08', city: 'Jodhpur' },
      seller: { name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', stateCode: '08', state: 'Rajasthan' },
      supply: { sellerStateCode: '08', placeOfSupplyCode: '08', placeOfSupply: 'Rajasthan', interState: false, taxLabel: 'SGST', stateAssumed: false },
    });
    expect(q.number).toMatch(/^QT\/\d{4}-\d{2}\/0001$/);
    expect(q.items[0]).toMatchObject({ name: 'Cumin Seeds', unit: 'kg', hsnSac: '0909', unitPricePaise: 25000, gstRatePct: 5, cgstPaise: 6250, sgstPaise: 6250, totalPaise: 262500 });
    expect(q.items[1]).toMatchObject({ discountPaise: 44998, taxablePaise: 854952, cgstPaise: 76946 });
    expect(q.totals).toMatchObject({ taxablePaise: 1104952, cgstPaise: 83196, sgstPaise: 83196, igstPaise: 0, roundOffPaise: -44, grandTotalPaise: 1271300 });
    // Valid for 15 days by default (India's calendar).
    const days = Math.round((new Date(q.validUntil) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
    expect(days).toBeGreaterThanOrEqual(14);
    expect(days).toBeLessThanOrEqual(16);
    const activity = await LeadActivity.findOne({ leadId: lead.id, type: 'Quotation' });
    expect(activity.text).toMatch(/^Quotation QT\/.+\/0001 created \(₹12,713\)$/);
  });

  it('charges IGST to a customer in another state (from the GSTIN), and numbers each type on its own', async () => {
    const estimate = (await post('/quotations', { type: 'Estimate', contactId: gujarat.id, items: [{ productId: cumin.id, quantity: 10 }] })).body.data;
    expect(estimate.number).toMatch(/^EST\/\d{4}-\d{2}\/0001$/);
    expect(estimate).toMatchObject({ supply: { placeOfSupplyCode: '24', interState: true }, totals: { igstPaise: 12500, cgstPaise: 0, grandTotalPaise: 262500 } });
    const proforma = (await post('/quotations', { type: 'Proforma Invoice', contactId: gujarat.id, items: [{ name: 'Packing', quantity: 1, unitPricePaise: 5000, gstRatePct: 18 }] })).body.data;
    expect(proforma.number).toMatch(/^PI\/\d{4}-\d{2}\/0001$/);
    expect(proforma.items[0]).toMatchObject({ name: 'Packing', igstPaise: 900 });
    const second = (await post('/quotations', { contactId: gujarat.id, items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    expect(second.number).toMatch(/\/0002$/);
    // An agent-picked place of supply wins; zero-rated (export under LUT) charges nothing.
    const exported = (await post('/quotations', { contactId: gujarat.id, placeOfSupplyCode: '99', zeroRated: true, items: [{ productId: rack.id, quantity: 1 }] })).body.data;
    expect(exported).toMatchObject({ placeOfSupplyCode: '99', supply: { placeOfSupplyCode: '99', zeroRated: true }, totals: { taxPaise: 0, grandTotalPaise: 900000 } });
  });

  it('previews without saving, and says when the customer\'s state is assumed', async () => {
    const stranger = (await post('/contacts', { name: 'No State Buyer', phone: '9000000001' })).body.data;
    const before = await Quotation.countDocuments();
    const res = await post('/pricing/preview', { contactId: stranger.id, items: [{ productId: cumin.id, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.supply).toMatchObject({ interState: false, stateAssumed: true, placeOfSupply: 'Rajasthan' });
    expect(res.body.data.supply.warnings.map((w) => w.code)).toEqual(['BUYER_STATE_ASSUMED']);
    expect(res.body.data.totals.grandTotalPaise).toBe(52500);
    // Typing the customer's state in the editor changes the tax at once.
    const typed = await post('/pricing/preview', { contactId: stranger.id, billTo: { state: 'Punjab' }, items: [{ productId: cumin.id, quantity: 2 }] });
    expect(typed.body.data.supply).toMatchObject({ interState: true, stateAssumed: false, placeOfSupply: 'Punjab' });
    expect(await Quotation.countDocuments()).toBe(before);
    expect((await post('/pricing/preview', { items: [{ quantity: 1 }] })).status).toBe(400); // a line needs a product or a name
    // With no items it still returns the customer's details and the document defaults.
    const first = (await post('/pricing/preview', { leadId: lead.id })).body.data;
    expect(first).toMatchObject({ billTo: { name: 'Ravi Traders', stateCode: '08' }, totals: { grandTotalPaise: 0 } });
    expect(first.defaults.validUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const states = (await api().get('/api/v1/pricing/states').set(bearer(owner.token))).body.data;
    expect(states).toContainEqual({ code: '08', name: 'Rajasthan' });
    expect(states).toHaveLength(38);
  });

  it('edits a draft in place; a GSTIN typed on the quotation switches to IGST and completes the contact', async () => {
    const draft = (await post('/quotations', { contactId: (await post('/contacts', { name: 'Late GSTIN', phone: '9000000002' })).body.data.id, items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    expect(draft.supply.interState).toBe(false);
    const edited = await patch(`/quotations/${draft.id}`, { billTo: { gstin: '06aaacl1234c1z5', address: 'Sector 18' }, items: [{ productId: cumin.id, quantity: 4 }], notes: 'Delivery in 3 days' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ number: draft.number, notes: 'Delivery in 3 days', billTo: { gstin: '06AAACL1234C1Z5', stateCode: '06', state: 'Haryana' }, supply: { interState: true }, totals: { igstPaise: 5000 } });
    const contact = await Contact.findById(draft.contactId);
    expect(contact).toMatchObject({ gstin: '06AAACL1234C1Z5', stateCode: '06', address: 'Sector 18' });
    expect((await patch(`/quotations/${draft.id}`, { type: 'Estimate' })).status).toBe(409);
  });

  it('sending moves the lead to Quote Sent; a sent quotation is revised, and the old revision kept', async () => {
    const q = (await Quotation.findOne({ leadId: lead.id, status: 'Draft' }));
    const sent = await patch(`/quotations/${q._id}`, { status: 'Sent' });
    expect(sent.body.data).toMatchObject({ status: 'Sent', sentVia: 'manual' });
    expect((await Lead.findById(lead.id)).stage).toBe('Quote Sent');
    expect((await patch(`/quotations/${q._id}`, { notes: 'too late' })).body.code).toBe('NOT_DRAFT');
    expect((await post(`/quotations/${q._id}/revise`, {})).status).toBe(200);
    const revised = (await api().get(`/api/v1/quotations/${q._id}`).set(bearer(owner.token))).body.data;
    expect(revised).toMatchObject({ status: 'Draft', revision: 1, sentAt: null, revisionCount: 1, number: q.number });
    expect(revised.revisions[0]).toMatchObject({ revision: 0, status: 'Sent', totals: { grandTotalPaise: 1271300 } });
    expect((await post(`/quotations/${q._id}/revise`, {})).body.code).toBe('NOT_REVISABLE'); // still a draft
    const cheaper = await patch(`/quotations/${q._id}`, { items: [{ productId: cumin.id, quantity: 10 }] });
    expect(cheaper.body.data.totals.grandTotalPaise).toBe(262500);

    // Accepted: no revision, no going back to Draft; "Rejected" needs no reason but keeps one.
    await patch(`/quotations/${q._id}`, { status: 'Sent' });
    expect((await patch(`/quotations/${q._id}`, { status: 'Accepted' })).body.data).toMatchObject({ status: 'Accepted' });
    expect((await post(`/quotations/${q._id}/revise`, {})).status).toBe(409);
    expect((await patch(`/quotations/${q._id}`, { status: 'Draft' })).status).toBe(400);
    const other = (await post('/quotations', { leadId: lead.id, items: [{ productId: rack.id, quantity: 2 }] })).body.data;
    const rejected = await patch(`/quotations/${other.id}`, { status: 'Rejected', rejectedReason: 'Price too high' });
    expect(rejected.body.data).toMatchObject({ status: 'Rejected', rejectedReason: 'Price too high' });
    expect((await patch(`/quotations/${other.id}`, { status: 'Sent' })).body.code).toBe('INVALID_STATUS');
    const texts = (await LeadActivity.find({ leadId: lead.id }).sort({ createdAt: 1 })).map((a) => a.text);
    expect(texts).toEqual(expect.arrayContaining([expect.stringMatching(/ sent$/), 'New → Quote Sent', expect.stringMatching(/revised \(revision 1\)$/), expect.stringMatching(/rejected: Price too high$/)]));
  });

  it('marks sent quotations past their last valid day Expired (the hourly job)', async () => {
    const q = (await post('/quotations', { contactId: gujarat.id, validUntil: '2026-01-10', items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    const draft = (await post('/quotations', { contactId: gujarat.id, validUntil: '2026-01-10', items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    await patch(`/quotations/${q.id}`, { status: 'Sent' });
    expect(await quotationService.expireDue()).toBeGreaterThanOrEqual(1);
    expect((await Quotation.findById(q.id)).status).toBe('Expired');
    expect((await Quotation.findById(draft.id)).status).toBe('Draft');
    // Expired can still be accepted, or revised with a fresh validity.
    const revised = (await post(`/quotations/${q.id}/revise`, {})).body.data;
    expect(new Date(revised.validUntil) > new Date()).toBe(true);
  });

  it('makes a quotation from a WhatsApp chat: its customer and open lead', async () => {
    await post('/whatsapp/accounts', { provider: 'mock' });
    const chat = (await post('/dev/simulate/whatsapp-inbound', { from: '98290 55555', name: 'Chat Buyer', text: 'Rate?' })).body.data;
    const q = (await post('/quotations', { conversationId: chat.conversationId, items: [{ productId: cumin.id, quantity: 5 }] })).body.data;
    const chatLead = await Lead.findOne({ contactId: chat.contactId });
    expect(q).toMatchObject({ contactId: String(chat.contactId), leadId: String(chatLead._id), billTo: { name: 'Chat Buyer' } });
    expect((await post('/quotations', { items: [{ productId: cumin.id, quantity: 1 }] })).status).toBe(400);
  });

  it('lists with filters; agents see the quotations of their own leads; other companies see none', async () => {
    const agent = await inviteAndJoin(owner.token, 'quote5-agent@example.com', { role: 'agent' });
    const agentId = await memberId(owner.token, 'quote5-agent@example.com');
    const theirs = (await post('/leads', { contact: { name: 'Agent Buyer', phone: '9000000003' }, ownerId: agentId })).body.data;
    const mine = (await post('/quotations', { leadId: theirs.id, items: [{ productId: cumin.id, quantity: 1 }] })).body.data;
    const seen = (await api().get('/api/v1/quotations').set(bearer(agent.token))).body.data;
    expect(seen.map((q) => q.id)).toEqual([mine.id]);
    expect(seen[0].revisions).toBeUndefined();
    const estimates = (await api().get('/api/v1/quotations?type=Estimate').set(bearer(owner.token))).body.data;
    expect(estimates.every((q) => q.type === 'Estimate')).toBe(true);
    const search = (await api().get('/api/v1/quotations?q=surat').set(bearer(owner.token))).body.data;
    expect(search.length).toBeGreaterThan(0);
    expect(search.every((q) => q.billTo.name === 'Surat Mart')).toBe(true);

    const stranger = await login('quote5-stranger@example.com');
    expect((await api().get('/api/v1/quotations').set(bearer(stranger.token))).body.data).toEqual([]);
    expect((await api().get(`/api/v1/quotations/${mine.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect((await patch(`/quotations/${mine.id}`, { status: 'Sent' }, stranger.token)).status).toBe(404);
    expect((await post('/quotations', { leadId: theirs.id, items: [{ productId: cumin.id, quantity: 1 }] }, stranger.token)).status).toBe(404);
    expect((await post('/quotations', { contactId: gujarat.id, items: [{ productId: cumin.id, quantity: 1 }] }, stranger.token)).status).toBe(404);
  });
});

describe('Migration 002: Phase 2 quotations', () => {
  it('splits the tax without changing any amount, once', async () => {
    const owner = await login('mig5-owner@example.com');
    await api().patch('/api/v1/organization').set(bearer(owner.token)).send({ gstin: '08AAACM1234C1Z5' });
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Old Buyer', phone: '9000000004', state: 'Delhi' })).body.data;
    const me = (await api().get('/api/v1/auth/me').set(bearer(owner.token))).body.data;
    const { insertedId } = await Quotation.collection.insertOne({
      organizationId: new (require('mongoose').Types.ObjectId)(me.organization?.id || me.member?.organizationId || me.organizationId),
      number: 'QT/2026-27/9001', financialYear: '2026-27', contactId: new (require('mongoose').Types.ObjectId)(contact.id), status: 'Sent',
      items: [{ name: 'Old item', quantity: 3, unitPricePaise: 10050, discountPaise: 150, taxRatePct: 18, subtotalPaise: 30150, taxPaise: 5401, totalPaise: 35401 }],
      totals: { subtotalPaise: 30150, discountPaise: 150, taxPaise: 5401, grandTotalPaise: 35401 },
      deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    expect((await migration.up()).updated).toBeGreaterThanOrEqual(1);
    const migrated = await Quotation.findById(insertedId);
    expect(migrated).toMatchObject({ type: 'Quotation', revision: 0, roundOff: false, schemaVersion: 2, supply: { interState: true, placeOfSupplyCode: '07' }, billTo: { name: 'Old Buyer', stateCode: '07' } });
    expect(migrated.items[0].toObject()).toMatchObject({ discountType: 'amount', discountValue: 150, taxablePaise: 30000, gstRatePct: 18, igstPaise: 5401, cgstPaise: 0, totalPaise: 35401 });
    expect(migrated.totals.toObject()).toMatchObject({ igstPaise: 5401, taxablePaise: 30000, roundOffPaise: 0, grandTotalPaise: 35401 });
    expect((await migration.up()).updated).toBe(0);
  });
});
