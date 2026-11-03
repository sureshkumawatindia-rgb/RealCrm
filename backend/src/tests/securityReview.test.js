jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mock = require('../integrations/whatsapp/mock');
const inbound = require('../services/whatsappInboundService');
const { api, bearer, login } = require('./helpers/api');

// Phase 1 of the 100 phases (D113): the security review before launch. A company never reaches
// another's records — the newer modules too (WhatsApp calls and forms, Instagram and Messenger
// accounts, calls, projects, chats) — and the gaps the review found stay closed.
describe('Security review (Phase 1, D113)', () => {
  let a;
  let b;
  const ids = {};
  const as = (user) => bearer(user.token);
  const req = (method, path, user, body) => {
    const call = api()[method](`/api/v1${path}`).set(as(user));
    return body === undefined ? call : call.send(body);
  };

  beforeAll(async () => {
    a = await login('review-a@example.com', { name: 'Asha A' });
    b = await login('review-b@example.com', { name: 'Bina B' });
    ids.memberA = a.data.member.id;
    ids.memberB = b.data.member.id;
    // Company A: a WhatsApp chat, a customer's call, a form, a test Page, a call log, a project.
    const account = (await req('post', '/whatsapp/accounts', a, { provider: 'mock' })).body.data;
    await req('put', `/whatsapp/accounts/${account.id}/calling`, a, { enabled: true });
    const chat = (await req('post', '/dev/simulate/whatsapp-inbound', a, { from: '98290 81111', text: 'Hello' })).body.data;
    await inbound.idle();
    ids.conversationA = chat.conversationId;
    ids.contactA = chat.contactId;
    ids.callA = (await req('post', '/dev/simulate/whatsapp-call', a, { event: 'incoming', from: '98290 82222', name: 'Caller' })).body.data.callId;
    await inbound.idle();
    ids.formA = (await req('post', '/whatsapp-forms', a, { kind: 'enquiry', name: 'Price enquiry' })).body.data.id;
    ids.socialA = (await req('post', '/social/test', a)).body.data.accounts[0].id;
    ids.callLogA = (await req('post', '/calls', a, { contactId: ids.contactA, outcome: 'connected' }).set('Idempotency-Key', 'review-call-1')).body.data.id;
    ids.projectA = (await req('post', '/projects', a, { name: 'Shop fit-out' })).body.data.id;
    ids.taskA = (await req('post', `/projects/${ids.projectA}/tasks`, a, { title: 'Measure the shop' })).body.data.id;
    // Company B: its own chat.
    await req('post', '/whatsapp/accounts', b, { provider: 'mock' });
    ids.conversationB = (await req('post', '/dev/simulate/whatsapp-inbound', b, { from: '98290 83333', text: 'Hi' })).body.data.conversationId;
    await inbound.idle();
  });

  it('never lets another company reach the newer modules by id', async () => {
    const probes = [
      ['get', `/whatsapp-calls/${ids.callA}`],
      ['post', `/whatsapp-calls/${ids.callA}/answer`, { sdp: mock.sampleSdp('answer') }],
      ['post', `/whatsapp-calls/${ids.callA}/decline`, {}],
      ['post', `/whatsapp-calls/${ids.callA}/end`, {}],
      ['patch', `/whatsapp-forms/${ids.formA}`, { name: 'Taken' }],
      ['post', `/whatsapp-forms/${ids.formA}/publish`, {}],
      ['delete', `/whatsapp-forms/${ids.formA}`],
      ['post', `/conversations/${ids.conversationB}/form`, { formId: ids.formA }], // A's form in B's own chat
      ['delete', `/social/accounts/${ids.socialA}`],
      ['patch', `/calls/${ids.callLogA}`, { notes: 'Taken' }],
      ['get', `/conversations/${ids.conversationA}`],
      ['post', `/conversations/${ids.conversationA}/messages`, { text: 'Taken' }],
      ['get', `/projects/${ids.projectA}`],
      ['patch', `/projects/${ids.projectA}/tasks/${ids.taskA}`, { title: 'Taken' }],
    ];
    for (const [index, [method, path, body]] of probes.entries()) {
      const res = await req(method, path, b, body).set('Idempotency-Key', `review-probe-${index}`);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 404 });
    }
    // Company A's records are untouched.
    expect((await req('get', `/whatsapp-calls/${ids.callA}`, a)).body.data.status).toBe('ringing');
    expect((await req('get', '/social', a)).body.data.accounts.every((account) => account.status === 'connected')).toBe(true);
    expect((await req('get', `/projects/${ids.projectA}/tasks`, a)).body.data.map((t) => t.title)).toEqual(['Measure the shop']);
    // Payment links of a record that is not this company's: nothing, and no error.
    const links = await req('get', `/payment-links?orderId=${ids.conversationA}`, b);
    expect(links.status).toBe(200);
    expect(links.body.data.links || links.body.data.items || []).toEqual([]);
  });

  it('keeps a project task\'s assignee inside the company', async () => {
    const foreign = await req('patch', `/projects/${ids.projectA}/tasks/${ids.taskA}`, a, { assigneeId: ids.memberB });
    expect(foreign.status).toBe(400);
    expect(foreign.body.errors[0].code).toBe('INVALID_MEMBER');
    const own = await req('patch', `/projects/${ids.projectA}/tasks/${ids.taskA}`, a, { assigneeId: ids.memberA });
    expect(own.status).toBe(200);
    expect(String(own.body.data.assigneeId)).toBe(String(ids.memberA));
    expect((await req('patch', `/projects/${ids.projectA}/tasks/${ids.taskA}`, a, { assigneeId: null })).status).toBe(200);
  });

  it('takes one logo file only, and answers a bad upload with 400', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const two = await api().post('/api/v1/organization/logo').set(as(a)).attach('logo', png, 'one.png').attach('logo', png, 'two.png');
    expect(two.status).toBe(400);
    expect(two.body.code).toBe('UPLOAD_ERROR');
    const wrongField = await api().post('/api/v1/organization/logo').set(as(a)).attach('image', png, 'logo.png');
    expect(wrongField.status).toBe(400);
    expect(wrongField.body.code).toBe('UPLOAD_ERROR');
    let many = api().post('/api/v1/organization/logo').set(as(a));
    for (let i = 0; i < 8; i += 1) many = many.field(`f${i}`, 'x');
    const tooMany = await many.attach('logo', png, 'logo.png');
    expect(tooMany.status).toBe(400);
    expect((await api().post('/api/v1/organization/logo').set(as(a)).attach('logo', png, 'logo.png')).status).toBe(200);
  });
});
