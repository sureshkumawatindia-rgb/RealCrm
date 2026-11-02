jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const Job = require('../models/Job');
const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const OrganizationMember = require('../models/OrganizationMember');
const SheetSync = require('../models/SheetSync');
const env = require('../config/env');
const google = require('../integrations/google');
const sheetSync = require('../services/sheetSyncService');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Google Sheets (G4, D108): an owner or admin switches it on with their own Google connection
// (Drive access); the CRM makes a sheet in their Drive and a job every 2 minutes adds the company's
// new leads or orders at its end — in order, once, never private numbers. It pauses with a bell note
// when Google refuses, the sheet is gone or its maker is no longer an owner or admin.
const mock = google.mock;
const req = (token) => ({
  get: (path) => api().get(`/api/v1${path}`).set(bearer(token)),
  post: (path, body) => api().post(`/api/v1${path}`).set(bearer(token)).send(body),
  patch: (path, body) => api().patch(`/api/v1${path}`).set(bearer(token)).send(body),
  del: (path) => api().delete(`/api/v1${path}`).set(bearer(token)),
});
async function connectGoogle(user, features) {
  const started = await req(user.token).post('/gmail/connect', { features });
  const consent = new URL(started.body.data.authorizationUrl);
  const callback = new URL((await api().get(`${consent.pathname}${consent.search}`)).headers.location);
  await api().get(`${callback.pathname}${callback.search}`);
}
const syncOf = (organizationId, kind) => SheetSync.findOne({ organizationId, kind }).lean();
// A run a little later: records younger than 5 seconds wait for the next one.
const run = async (organizationId, kind, now = new Date(Date.now() + 10 * 1000)) => sheetSync.runSync((await syncOf(organizationId, kind))._id, now);
const rowsOf = async (email, organizationId, kind) => mock.sheetRows(email, (await syncOf(organizationId, kind)).spreadsheetId);
const newLead = (token, name, phone, extra = {}) => req(token).post('/leads', { contact: { name, phone }, ...extra }).then((res) => res.body.data);
const dateTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

beforeEach(() => mock.reset());

describe('Google Sheets (G4, D108)', () => {
  it('makes the sheet in the owner\'s Drive and adds new leads at its end, in order and once', async () => {
    const owner = await login('gs-owner@example.com', { name: 'Meera Owner' });
    const agent = await inviteAndJoin(owner.token, 'gs-agent@example.com');
    const organizationId = owner.data.organizationId;
    const o = req(owner.token);
    expect((await req(agent.token).get('/sheet-syncs')).status).toBe(403);
    expect((await req(agent.token).post('/sheet-syncs', { kind: 'leads' })).status).toBe(403);

    // Google without Drive is not enough.
    expect((await o.get('/sheet-syncs')).body.data).toMatchObject({ google: { available: true, connected: false, drive: false }, sheets: { leads: null, orders: null } });
    await connectGoogle(owner, []);
    const noDrive = await o.post('/sheet-syncs', { kind: 'leads' });
    expect(noDrive.status).toBe(409);
    expect(noDrive.body.code).toBe('GOOGLE_NO_DRIVE');
    await connectGoogle(owner, ['drive']);

    const before = await newLead(owner.token, 'Old Enquiry', '98290 41000'); // made before: not in the sheet
    const started = await o.post('/sheet-syncs', { kind: 'leads' });
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ kind: 'leads', status: 'active', rowsAdded: 0, mine: true, startedBy: { name: 'Meera Owner', googleEmail: 'gs-owner@example.com' } });
    expect(started.body.data.url).toMatch(/^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
    expect((await o.post('/sheet-syncs', { kind: 'leads' })).body.code).toBe('SHEET_SYNC_EXISTS');
    const sync = await syncOf(organizationId, 'leads');
    expect(await Job.findOne({ name: sheetSync.JOB, liveKey: `sheet-sync:${sync._id}` }).lean()).toMatchObject({ status: 'queued', repeatEveryMs: 120000 });
    expect(await rowsOf('gs-owner@example.com', organizationId, 'leads')).toEqual([sheetSync.HEADERS.leads]);

    const asha = await newLead(owner.token, 'Asha Traders', '98290 41001', { title: 'Jeera 500 kg', source: 'IndiaMART', expectedValuePaise: 1250000 });
    await req(owner.token).patch(`/contacts/${asha.contactId}`, { email: 'asha@example.com', company: 'Asha Traders Pvt Ltd', city: 'Jaipur' });
    const bala = await newLead(owner.token, 'Bala Stores', '98290 41002');
    const hidden = await newLead(owner.token, 'Private Buyer', '98290 41003');
    await Lead.updateOne({ _id: hidden.id }, { $set: { private: true } }); // a private number's lead stays out

    expect(await run(organizationId, 'leads')).toEqual({ added: 2 });
    const rows = await rowsOf('gs-owner@example.com', organizationId, 'leads');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([
      expect.stringMatching(dateTime), 'Asha Traders', '+919829041001', 'asha@example.com', 'Asha Traders Pvt Ltd', 'Jaipur',
      'Jeera 500 kg', 'IndiaMART', '', 'New', 12500, 'Meera Owner', `${env.frontendUrl}/leads.html?open=${asha.id}`,
    ]);
    expect(rows[2].slice(1, 3)).toEqual(['Bala Stores', '+919829041002']);
    expect(rows.flat()).not.toContain('Old Enquiry');
    expect(rows.flat()).not.toContain(`${env.frontendUrl}/leads.html?open=${before.id}`);

    // Nothing new: nothing sent. A lead saved a moment ago waits for the next run.
    expect(await run(organizationId, 'leads')).toEqual({ added: 0 });
    await newLead(owner.token, 'Chetan Mart', '98290 41004');
    expect(await run(organizationId, 'leads', new Date())).toEqual({ added: 0 });
    expect(await run(organizationId, 'leads')).toEqual({ added: 1 });
    expect((await o.get('/sheet-syncs')).body.data.sheets.leads).toMatchObject({ status: 'active', rowsAdded: 3, lastError: '' });
  });

  it('adds orders too, from the last 30 days when asked, and never sends a row twice after a failed call', async () => {
    const owner = await login('gs-orders@example.com', { name: 'Kabir Owner' });
    const organizationId = owner.data.organizationId;
    const o = req(owner.token);
    await connectGoogle(owner, ['drive']);
    const product = (await o.post('/products', { name: 'Rice 1kg', pricePaise: 10000, gstRatePct: 0, unit: 'kg' })).body.data;
    const order = async (name, phone, quantity) => {
      const lead = await newLead(owner.token, name, phone);
      const quotation = (await o.post('/quotations', { leadId: lead.id, items: [{ productId: product.id, quantity }] })).body.data;
      await o.patch(`/quotations/${quotation.id}`, { status: 'Sent' });
      await o.patch(`/quotations/${quotation.id}`, { status: 'Accepted' });
      const made = await o.post('/orders', { quotationId: quotation.id });
      if (made.status !== 201) throw new Error(JSON.stringify(made.body));
      return { ...made.body.data, quotationNumber: quotation.number };
    };
    const first = await order('Devika Foods', '98290 42001', 2); // before the sheet: in the last 30 days

    const started = await o.post('/sheet-syncs', { kind: 'orders', backfillDays: 30 });
    expect(started.status).toBe(201);
    expect(await run(organizationId, 'orders')).toEqual({ added: 1 });
    const rows = await rowsOf('gs-orders@example.com', organizationId, 'orders');
    expect(rows[0]).toEqual(sheetSync.HEADERS.orders);
    expect(rows[1]).toEqual([
      expect.stringMatching(dateTime), first.number, 'Devika Foods', '+919829042001', 'Rice 1kg × 2 kg', 200, 0, 'Received',
      `Quotation ${first.quotationNumber}`, 'Kabir Owner', `${env.frontendUrl}/Orders.html?id=${first.id}`,
    ]);

    // Google does not answer: the run fails, nothing moves, and the next run sends the row once.
    await order('Esha Kirana', '98290 42002', 1);
    mock.failNextSheetAppend();
    await expect(run(organizationId, 'orders')).rejects.toMatchObject({ code: 'GOOGLE_FAILED' });
    expect(await rowsOf('gs-orders@example.com', organizationId, 'orders')).toHaveLength(2);
    expect((await syncOf(organizationId, 'orders')).lastError).toMatch(/Google did not answer/);
    expect(await run(organizationId, 'orders')).toEqual({ added: 1 });
    expect(await run(organizationId, 'orders')).toEqual({ added: 0 });
    const after = await rowsOf('gs-orders@example.com', organizationId, 'orders');
    expect(after.map((row) => row[2])).toEqual(['Customer', 'Devika Foods', 'Esha Kirana']);
    expect((await syncOf(organizationId, 'orders')).lastError).toBe('');

    // Stopped: the job goes, the sheet stays in the Drive.
    const sync = await syncOf(organizationId, 'orders');
    expect((await o.del('/sheet-syncs/orders')).status).toBe(200);
    expect(await Job.countDocuments({ liveKey: `sheet-sync:${sync._id}`, status: 'queued' })).toBe(0);
    expect((await o.get('/sheet-syncs')).body.data.sheets.orders).toBeNull();
    expect(mock.sheetRows('gs-orders@example.com', sync.spreadsheetId)).toHaveLength(3);
    expect((await o.del('/sheet-syncs/orders')).status).toBe(404);
  });

  it('pauses with a bell note when Google refuses, the sheet is gone or its maker is no longer an admin; Resume carries on', async () => {
    const owner = await login('gs-pause-owner@example.com', { name: 'Nisha Owner' });
    const admin = await inviteAndJoin(owner.token, 'gs-pause-admin@example.com', { role: 'admin' });
    const organizationId = owner.data.organizationId;
    const notes = () => Notification.find({ organizationId, source: 'sheets' }).lean();
    await connectGoogle(admin, ['drive']);
    expect((await req(admin.token).post('/sheet-syncs', { kind: 'leads' })).status).toBe(201);
    expect((await req(owner.token).get('/sheet-syncs')).body.data.sheets.leads).toMatchObject({ mine: false, startedBy: { googleEmail: 'gs-pause-admin@example.com' } });

    // Google refuses the admin's access.
    mock.revoke('gs-pause-admin@example.com');
    await newLead(owner.token, 'Farhan Agencies', '98290 43001');
    expect(await run(organizationId, 'leads')).toEqual({ added: 0, paused: 'GOOGLE_RECONNECT' });
    const paused = await syncOf(organizationId, 'leads');
    expect(paused).toMatchObject({ status: 'paused', pausedReason: 'GOOGLE_RECONNECT' });
    expect(await Job.countDocuments({ liveKey: `sheet-sync:${paused._id}`, status: 'queued' })).toBe(0);
    const told = await notes();
    expect(told.map((n) => String(n.memberId)).sort()).toEqual([admin.data.member.id, owner.data.member.id].sort());
    expect(told[0]).toMatchObject({ title: 'Google Sheets: new leads stopped going to the sheet', link: 'Settings.html?tab=integrations' });
    expect(await run(organizationId, 'leads')).toEqual({ added: 0 }); // paused: nothing runs, no second note
    expect(await notes()).toHaveLength(2);

    const early = await req(owner.token).post('/sheet-syncs/leads/resume');
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('GOOGLE_RECONNECT');
    await connectGoogle(admin, ['drive']);
    const resumed = await req(owner.token).post('/sheet-syncs/leads/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toMatchObject({ status: 'active', pausedReason: '' });
    expect(await run(organizationId, 'leads')).toEqual({ added: 1 }); // the same sheet, from where it stopped
    expect((await rowsOf('gs-pause-admin@example.com', organizationId, 'leads')).map((row) => row[1])).toEqual(['Customer', 'Farhan Agencies']);

    // The sheet was deleted at Google.
    mock.deleteSheet('gs-pause-admin@example.com', paused.spreadsheetId);
    await newLead(owner.token, 'Gopal Sons', '98290 43002');
    expect(await run(organizationId, 'leads')).toEqual({ added: 0, paused: 'SHEET_GONE' });
    expect((await req(owner.token).get('/integrations/status')).body.data.items.find((i) => i.kind === 'sheets'))
      .toMatchObject({ name: 'New leads', state: 'attention', settingsTab: 'integrations', problem: expect.stringMatching(/was deleted/) });
    expect((await req(owner.token).del('/sheet-syncs/leads')).status).toBe(200);

    // Its maker is no longer an admin: their Drive gets nothing more.
    expect((await req(admin.token).post('/sheet-syncs', { kind: 'leads' })).status).toBe(201);
    await OrganizationMember.updateOne({ _id: admin.data.member.id }, { $set: { role: 'agent' } });
    await newLead(owner.token, 'Hari Stores', '98290 43003');
    expect(await run(organizationId, 'leads')).toEqual({ added: 0, paused: 'MEMBER_GONE' });
    expect((await req(owner.token).post('/sheet-syncs/leads/resume')).body.code).toBe('MEMBER_GONE');
    expect((await notes()).filter((n) => /no longer an owner or admin/.test(n.body)).map((n) => String(n.memberId))).toEqual([owner.data.member.id]);
  });
});
