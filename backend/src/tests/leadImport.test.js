jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Contact = require('../models/Contact');
const Lead = require('../models/Lead');
const LeadActivity = require('../models/LeadActivity');
const LeadStageEvent = require('../models/LeadStageEvent');
const automationEvents = require('../services/automation/events');
const xlsx = require('../utils/xlsx');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// G1 (D105): leads from a CSV or Excel file — the customer found or added, the stage (fixed,
// a common word, or the pipeline's own stage), the owner by email or name, the value in Indian
// ways of writing it, the close date, source and the company's own lead fields; an open lead is
// never doubled; private, blocked and deleted customers are left out; no automation unless asked.
const csv = (lines) => Buffer.from(lines.map((line) => line.join(',')).join('\n'));

describe('Importing leads (G1, D105)', () => {
  let owner;
  let agent;
  const as = (who) => bearer(who.token);
  const previewOf = (who, file, name = 'leads.csv') => api().post('/api/v1/leads/import/preview').set(as(who)).attach('file', file, name);
  const importAs = (who, file, mapping, fields = {}, name = 'leads.csv') => {
    const req = api().post('/api/v1/leads/import').set(as(who)).attach('file', file, name).field('mapping', JSON.stringify(mapping));
    Object.entries(fields).forEach(([key, value]) => req.field(key, String(value)));
    return req;
  };

  beforeAll(async () => {
    owner = await login('import-owner@example.com', { name: 'Asha Mehta' });
    agent = await inviteAndJoin(owner.token, 'ravi.kumar@example.com', { role: 'agent', modules: ['leads'], displayName: 'Ravi Kumar' });
    await inviteAndJoin(owner.token, 'meena@example.com', { role: 'agent', modules: ['leads'], displayName: 'Meena Joshi' });
  });
  afterEach(() => jest.restoreAllMocks());

  it('reads a file\'s columns and guesses what each one is', async () => {
    const file = csv([
      ['Customer Name', 'Mobile No', 'Lead Status', 'Assigned To', 'Deal Value', 'Requirement', 'Expected Close Date', 'Remarks', 'Budget'],
      ['Meena Stores', '98290 11111', 'Quotation sent', 'ravi.kumar@example.com', '1.2 lakh', 'Jeera 500 kg', '20/11/2026', 'Wants delivery', '5000'],
      ['', '', '', '', '', '', '', '', ''],
      ['Ravi Traders', '98290 22222', 'New', '', '', '', '', '', ''],
    ]);
    const res = await previewOf(owner, file);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({
      totalRows: 2, // the empty row is passed over
      mapping: ['name', 'phone', 'stage', 'owner', 'value', 'title', 'closeDate', 'notes', ''],
      canChooseOwners: true,
      pipelines: [expect.objectContaining({ name: 'Sales', isDefault: true, stages: ['New', 'Contacted', 'Quote Sent', 'Negotiation'] })],
    }));
    expect(res.body.data.rows).toHaveLength(2);
    expect((await previewOf(owner, Buffer.from('Name,Phone\n'))).body.code).toBe('EMPTY_FILE');
    expect((await previewOf(owner, Buffer.from('x'), 'old.xls')).body.code).toBe('UNSUPPORTED_FILE');
    expect((await previewOf(agent, file)).body.data.canChooseOwners).toBe(false);
  });

  it('checks first without saving, then imports with stage, owner, value, close date and source', async () => {
    // Already here: a customer with an open lead, a private number and a blocked customer.
    const known = (await api().post('/api/v1/leads').set(as(owner)).send({ contact: { name: 'Known Buyer', phone: '98290 33333' }, title: 'Old enquiry' })).body.data;
    await api().post('/api/v1/privacy/numbers').set(as(owner)).send({ phone: '98290 44444', note: 'Family' });
    const blocked = await Contact.create({ organizationId: owner.data.organizationId, name: 'Spammer', phone: '9829055555', phoneE164: '+919829055555', blocked: { at: new Date(), byName: 'Asha', reason: 'Spam' } });
    const field = (await api().post('/api/v1/custom-fields').set(as(owner)).send({ object: 'lead', label: 'Quantity (kg)', type: 'number' })).body.data;

    const header = ['Name', 'Phone', 'Email', 'City', 'Requirement', 'Stage', 'Owner', 'Value', 'Source', 'Close date', 'Remarks', 'Lost reason', 'Quantity (kg)'];
    const file = csv([
      header,
      ['Meena Stores', '98290 11111', 'meena@shop.in', 'Jaipur', 'Jeera 500 kg', 'Quotation sent', 'ravi.kumar@example.com', '1.2 lakh', 'IndiaMART', '20/11/2026', 'Wants delivery', '', '"1,200"'],
      ['Meena again', '+91 98290 11111', '', '', 'Saunf', 'New', '', '', '', '', '', '', ''], // same customer, open: skipped
      ['Known Buyer', '9829033333', '', '', 'Second enquiry', 'Contacted', '', '50000', '', '', '', '', ''], // has an open lead: skipped
      ['Known Buyer', '9829033333', '', '', 'Last year\'s order', 'Closed won', 'Meena', '"₹2,40,000"', 'fb', '', '', '', ''], // Won: history, added
      ['Lost Kirana', '98290 66666', '', '', 'Ajwain', 'Dead', 'Ravi', 'lots', 'newspaper', 'someday', '', 'Price too high', ''],
      ['Bad Number', '12345', '', '', '', '', '', '', '', '', '', '', ''],
      ['No Number', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Family', '98290 44444', '', '', '', '', '', '', '', '', '', '', ''],
      ['Spammer', '9829055555', '', '', '', '', '', '', '', '', '', '', ''],
      ['Nobody\'s Lead', '98290 77777', '', '', '', 'Site visit', 'Somebody Else', '', '', '', '', '', ''],
    ]);
    const mapping = ['name', 'phone', 'email', 'city', 'title', 'stage', 'owner', 'value', 'source', 'closeDate', 'notes', 'lostReason', `cf:${field.key}`];
    const leadsBefore = await Lead.countDocuments({ organizationId: owner.data.organizationId });

    const check = await importAs(owner, file, mapping, { dryRun: true, tags: 'Expo 2026' });
    expect(check.status).toBe(200);
    expect(check.body.data).toEqual(expect.objectContaining({
      dryRun: true, totalRows: 10, created: 4, contactsCreated: 3, contactsFound: 1, skippedOpen: 2, rejected: 4,
      byStage: { New: 1, Contacted: 0, 'Quote Sent': 1, Negotiation: 0, Won: 1, Lost: 1 }, valuePaise: 12000000 + 24000000, pipeline: 'Sales', automations: false,
    }));
    expect(check.body.data.rejectedRows.map((r) => r.row)).toEqual([7, 8, 9, 10]);
    expect(check.body.data.rejectedRows.map((r) => r.text)).toEqual([
      '"12345" is not a phone number', 'no phone number or email', 'a private number (Settings → WhatsApp): not imported', 'the customer is blocked',
    ]);
    expect(await Lead.countDocuments({ organizationId: owner.data.organizationId })).toBe(leadsBefore);

    const emit = jest.spyOn(automationEvents, 'emit');
    const res = await importAs(owner, file, mapping, { tags: 'Expo 2026' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ dryRun: false, created: 4, contactsCreated: 3 }));
    expect(emit.mock.calls.filter(([event]) => event === 'lead.created')).toHaveLength(0); // no automation unless asked
    const warnings = res.body.data.warnings.map((w) => `${w.row}: ${w.text}`);
    expect(warnings).toEqual(expect.arrayContaining([
      '3: the customer already has an open lead: skipped',
      '4: the customer already has an open lead: skipped',
      '6: value "lots" is not an amount: left out',
      '6: source "newspaper" is not one the CRM knows: kept as Import',
      '6: close date "someday" is not a date (use 20/11/2026 or 2026-11-20): left out',
      '11: stage "Site visit" is not a stage: the lead is New',
      '11: owner "Somebody Else" is not in the team: given to you',
    ]));

    const leads = await Lead.find({ organizationId: owner.data.organizationId, createdAt: { $gte: new Date(Date.now() - 60000) }, title: { $ne: 'Old enquiry' } }).populate('contactId').populate({ path: 'ownerId', populate: { path: 'userId', select: 'email' } });
    const byTitle = Object.fromEntries(leads.map((l) => [l.title || l.contactId.name, l]));
    expect(byTitle['Jeera 500 kg']).toEqual(expect.objectContaining({ stage: 'Quote Sent', probability: 50, source: 'IndiaMART', expectedValuePaise: 12000000, notes: 'Wants delivery' }));
    expect(byTitle['Jeera 500 kg'].expectedCloseDate.toISOString().slice(0, 10)).toBe('2026-11-20');
    expect(byTitle['Jeera 500 kg'].ownerId.userId.email).toBe('ravi.kumar@example.com');
    expect(byTitle['Jeera 500 kg'].customFields).toEqual({ [field.key]: 1200 });
    expect(byTitle['Jeera 500 kg'].contactId).toEqual(expect.objectContaining({ name: 'Meena Stores', phoneE164: '+919829011111', email: 'meena@shop.in', city: 'Jaipur', lifecycle: 'lead', tags: ['Expo 2026'] }));
    expect(byTitle["Last year's order"]).toEqual(expect.objectContaining({ stage: 'Won', probability: 100, source: 'Facebook', expectedValuePaise: 24000000, convertedAt: expect.any(Date) }));
    expect(byTitle["Last year's order"].ownerId.userId.email).toBe('meena@example.com'); // by first name
    expect(String(byTitle["Last year's order"].contactId._id)).toBe(String(known.contact.id));
    expect(byTitle["Last year's order"].contactId).toEqual(expect.objectContaining({ lifecycle: 'customer', tags: ['Expo 2026'] })); // a Won lead: a customer now
    expect(byTitle.Ajwain).toEqual(expect.objectContaining({ stage: 'Lost', lostReason: 'Price too high', source: 'Import' }));
    expect(byTitle.Ajwain.ownerId.userId.email).toBe('ravi.kumar@example.com');
    expect(byTitle["Nobody's Lead"]).toEqual(expect.objectContaining({ stage: 'New' }));
    expect(String(byTitle["Nobody's Lead"].ownerId._id)).toBe(String(owner.data.member.id));
    expect(await Contact.exists({ _id: blocked._id, tags: 'Expo 2026' })).toBeNull();

    // Each lead has its first stage in the history and a note in its activity; the import is audited.
    const ids = leads.map((l) => l._id);
    expect(await LeadStageEvent.countDocuments({ leadId: { $in: ids }, source: 'create' })).toBe(4);
    expect((await LeadActivity.find({ leadId: { $in: ids } })).map((a) => a.text)).toEqual(Array(4).fill('Imported from leads.csv'));
    expect(await AuditLog.findOne({ action: 'leads.imported' })).toEqual(expect.objectContaining({ changes: expect.objectContaining({ created: 4, contactsCreated: 3, rows: 10, file: 'leads.csv', automations: false }) }));
  });

  it('uses the pipeline\'s own stage names, leaves unmatched owners without one if asked, and runs automations only when ticked', async () => {
    const pipeline = (await api().post('/api/v1/pipelines').set(as(owner)).send({ name: 'Projects', stages: [{ name: 'Enquiry', kind: 'New' }, { name: 'Site visit', kind: 'Contacted' }, { name: 'Estimate', kind: 'Quote Sent' }] })).body.data;
    const file = csv([['Name', 'Phone', 'Stage', 'Owner'], ['Builder One', '98290 88881', 'Site visit', 'Who Knows'], ['Builder Two', '98290 88882', 'Estimate', '']]);
    const emit = jest.spyOn(automationEvents, 'emit');
    const res = await importAs(owner, file, ['name', 'phone', 'stage', 'owner'], { pipelineId: pipeline.id, ownerFallback: 'none', runAutomations: true });
    expect(res.body.data).toEqual(expect.objectContaining({ created: 2, pipeline: 'Projects', automations: true }));
    const leads = await Lead.find({ pipelineId: pipeline.id }).sort({ createdAt: 1 }).populate('contactId');
    const siteVisit = pipeline.stages.find((s) => s.name === 'Site visit');
    expect(leads.map((l) => [l.contactId.name, l.stage, String(l.pipelineStageId), l.ownerId ?? null])).toEqual([
      ['Builder One', 'Contacted', String(siteVisit.id), null],
      ['Builder Two', 'Quote Sent', String(pipeline.stages.find((s) => s.name === 'Estimate').id), null],
    ]);
    expect(emit.mock.calls.filter(([event]) => event === 'lead.created').map(([, payload]) => String(payload.leadId)).sort()).toEqual(leads.map((l) => String(l._id)).sort());
  });

  it('reads Excel files too; an agent\'s leads are their own whatever the owner column says', async () => {
    const file = xlsx.write([{ name: 'Leads', rows: [['Name', 'Phone', 'Owner', 'Value'], ['Excel Buyer', '+919829099991', 'meena@example.com', 75000]] }]);
    const res = await importAs(agent, file, ['name', 'phone', 'owner', 'value'], {}, 'leads.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ created: 1, ownersIgnored: true }));
    const lead = await Lead.findOne({ organizationId: owner.data.organizationId, expectedValuePaise: 7500000 });
    expect(String(lead.ownerId)).toBe(String(agent.data.member.id));

    // Named .xlsx: read as CSV, a workbook's bytes (with the time in them) gave a varying column count.
    expect((await importAs(owner, file, ['name', 'phone'], {}, 'leads.xlsx')).body.message).toMatch(/column choices do not match/);
    expect((await importAs(owner, file, ['name', '', 'owner', 'value'], {}, 'leads.xlsx')).body.errors[0].code).toBe('PHONE_REQUIRED');
    expect((await importAs(owner, file, ['name', 'phone', 'owner', 'price'], {}, 'leads.xlsx')).status).toBe(400);
    const viewer = await inviteAndJoin(owner.token, 'viewer@example.com', { role: 'viewer' });
    expect((await importAs(viewer, file, ['name', 'phone', 'owner', 'value'], {}, 'leads.xlsx')).status).toBe(403);
  });
});
