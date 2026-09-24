jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

const memberId = async (token, email) => (await api().get('/api/v1/members').set(bearer(token))).body.data.find((m) => m.email === email).id;
const newTicket = (token, body) => api().post('/api/v1/tickets').set(bearer(token)).send(body);

describe('Tickets', () => {
  let owner;
  beforeAll(async () => { owner = await login('tickets-owner@example.com', { name: 'Tara Support' }); });

  it('numbers tickets from 1001, one number each even when saved at the same moment', async () => {
    const first = await newTicket(owner.token, { subject: 'First' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ number: 1001, status: 'Open', priority: 'Medium', category: 'General', resolvedAt: null });

    const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => newTicket(owner.token, { subject: `Burst ${i}` })));
    const numbers = burst.map((res) => res.body.data.number).sort();
    expect(numbers).toEqual([1002, 1003, 1004, 1005, 1006]);

    // A deleted ticket's number is never handed out again.
    await api().delete(`/api/v1/tickets/${first.body.data.id}`).set(bearer(owner.token));
    expect((await newTicket(owner.token, { subject: 'After delete' })).body.data.number).toBe(1007);
  });

  it('links the customer by contact id, or keeps a typed name', async () => {
    const contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders', lifecycle: 'customer' })).body.data;
    const linked = await newTicket(owner.token, { subject: 'Late delivery', contactId: contact.id, customerName: 'typo' });
    expect(linked.body.data).toMatchObject({ contactId: contact.id, customerName: 'Ravi Traders' });

    const typed = await newTicket(owner.token, { subject: 'Walk-in', customerName: 'Somebody New' });
    expect(typed.body.data).toMatchObject({ contactId: null, customerName: 'Somebody New' });

    const unlinked = await api().patch(`/api/v1/tickets/${linked.body.data.id}`).set(bearer(owner.token)).send({ contactId: null, customerName: 'Other Shop' });
    expect(unlinked.body.data).toMatchObject({ contactId: null, customerName: 'Other Shop' });

    const unknown = await newTicket(owner.token, { subject: 'x', contactId: '0123456789abcdef01234567' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0].code).toBe('INVALID_CONTACT');

    const byContact = await api().get(`/api/v1/tickets?contactId=${contact.id}`).set(bearer(owner.token));
    expect(byContact.body.data).toHaveLength(0); // it was unlinked above
  });

  it('records when a ticket is resolved and clears it when reopened; validates values', async () => {
    const ticket = (await newTicket(owner.token, { subject: 'Wrong invoice', category: 'Billing', priority: 'Urgent', dueDate: '2026-10-01' })).body.data;
    const resolved = await api().patch(`/api/v1/tickets/${ticket.id}`).set(bearer(owner.token)).send({ status: 'Resolved' });
    expect(resolved.body.data.resolvedAt).not.toBeNull();
    const closed = await api().patch(`/api/v1/tickets/${ticket.id}`).set(bearer(owner.token)).send({ status: 'Closed' });
    expect(closed.body.data.resolvedAt).toBe(resolved.body.data.resolvedAt);
    const reopened = await api().patch(`/api/v1/tickets/${ticket.id}`).set(bearer(owner.token)).send({ status: 'Waiting on Customer', dueDate: '' });
    expect(reopened.body.data).toMatchObject({ resolvedAt: null, dueDate: '' });

    const urgent = await api().get('/api/v1/tickets?priority=Urgent&category=Billing&q=invoice').set(bearer(owner.token));
    expect(urgent.body.data.map((t) => t.id)).toEqual([ticket.id]);

    expect((await newTicket(owner.token, { subject: 'x', priority: 'Critical' })).status).toBe(400);
    expect((await newTicket(owner.token, { subject: '' })).status).toBe(400);
    expect((await newTicket(owner.token, { subject: 'x', number: 5 })).body.data.number).not.toBe(5); // numbers come from the server
  });

  it('keeps a reply timeline on each ticket', async () => {
    const ticket = (await newTicket(owner.token, { subject: 'Damaged box' })).body.data;
    const added = await api().post(`/api/v1/tickets/${ticket.id}/notes`).set(bearer(owner.token)).send({ text: 'Asked for photos' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ text: 'Asked for photos', authorName: 'Tara Support', parentType: 'ticket' });
    await api().post(`/api/v1/tickets/${ticket.id}/notes`).set(bearer(owner.token)).send({ text: 'Replacement sent' });

    const notes = await api().get(`/api/v1/tickets/${ticket.id}/notes`).set(bearer(owner.token));
    expect(notes.body.data.map((n) => n.text)).toEqual(['Replacement sent', 'Asked for photos']);
    expect((await api().post(`/api/v1/tickets/${ticket.id}/notes`).set(bearer(owner.token)).send({ text: '  ' })).status).toBe(400);
  });

  it('agents see tickets assigned to them or created by them; changing tickets needs support', async () => {
    const agent = await inviteAndJoin(owner.token, 'tickets-agent@example.com', { role: 'agent', modules: ['support'] });
    const agentId = await memberId(owner.token, 'tickets-agent@example.com');
    const forAgent = (await newTicket(owner.token, { subject: 'For the agent', assigneeId: agentId })).body.data;
    const byAgent = (await newTicket(agent.token, { subject: 'Agent made this' })).body.data;
    const ownersOnly = (await newTicket(owner.token, { subject: 'Owner only' })).body.data;

    const view = await api().get('/api/v1/tickets').set(bearer(agent.token));
    expect(view.body.data.map((t) => t.id).sort()).toEqual([forAgent.id, byAgent.id].sort());
    expect((await api().get(`/api/v1/tickets/${ownersOnly.id}`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().get(`/api/v1/tickets/${ownersOnly.id}/notes`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().post(`/api/v1/tickets/${forAgent.id}/notes`).set(bearer(agent.token)).send({ text: 'On it' })).status).toBe(201);
    expect((await api().delete(`/api/v1/tickets/${byAgent.id}`).set(bearer(agent.token))).status).toBe(403);

    const reportsOnly = await inviteAndJoin(owner.token, 'tickets-reports@example.com', { role: 'agent', modules: ['reports'] });
    expect((await api().get('/api/v1/tickets').set(bearer(reportsOnly.token))).status).toBe(200);
    expect((await newTicket(reportsOnly.token, { subject: 'x' })).status).toBe(403);

    await api().patch(`/api/v1/members/${agentId}`).set(bearer(owner.token)).send({ permissions: ['support:view_all', 'support:delete'] });
    expect((await api().get(`/api/v1/tickets/${ownersOnly.id}`).set(bearer(agent.token))).status).toBe(200);
    expect((await api().delete(`/api/v1/tickets/${byAgent.id}`).set(bearer(agent.token))).status).toBe(200);
  });

  it('another organization sees none of these tickets', async () => {
    const stranger = await login('tickets-stranger@example.com');
    expect((await api().get('/api/v1/tickets').set(bearer(stranger.token))).body.data).toEqual([]);
    // Its own numbering starts at 1001 too.
    expect((await newTicket(stranger.token, { subject: 'Mine' })).body.data.number).toBe(1001);
  });
});

describe('Customer notes', () => {
  let owner;
  let contact;
  beforeAll(async () => {
    owner = await login('notes-owner@example.com', { name: 'Neha' });
    contact = (await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Meena Stores', lifecycle: 'customer' })).body.data;
  });

  it('adds and lists notes on a contact, newest first', async () => {
    const added = await api().post(`/api/v1/contacts/${contact.id}/notes`).set(bearer(owner.token)).send({ text: 'Prefers calls after 4 pm' });
    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ parentType: 'contact', authorName: 'Neha' });
    await api().post(`/api/v1/contacts/${contact.id}/notes`).set(bearer(owner.token)).send({ text: 'Pays by UPI' });
    const notes = await api().get(`/api/v1/contacts/${contact.id}/notes`).set(bearer(owner.token));
    expect(notes.body.data.map((n) => n.text)).toEqual(['Pays by UPI', 'Prefers calls after 4 pm']);
  });

  it('notes follow the contact: hidden from agents who cannot see it and from other organizations', async () => {
    const agent = await inviteAndJoin(owner.token, 'notes-agent@example.com', { role: 'agent', modules: ['customers'] });
    expect((await api().get(`/api/v1/contacts/${contact.id}/notes`).set(bearer(agent.token))).status).toBe(404);
    expect((await api().post(`/api/v1/contacts/${contact.id}/notes`).set(bearer(agent.token)).send({ text: 'x' })).status).toBe(404);

    const stranger = await login('notes-stranger@example.com');
    expect((await api().get(`/api/v1/contacts/${contact.id}/notes`).set(bearer(stranger.token))).status).toBe(404);
  });
});
