jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const AuditLog = require('../models/AuditLog');
const Notification = require('../models/Notification');
const OrganizationMember = require('../models/OrganizationMember');
const Ticket = require('../models/Ticket');
const ticketSla = require('../services/ticketSlaService');
const { addWorkingMinutes, workingMinutesBetween, businessHoursOf } = require('../utils/businessHours');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// G3 (D107): the ticket SLA — by priority, the first reply and the resolution are due within the
// company's working hours (Mon–Sat 10:00–19:00 in India unless changed); waiting on the customer
// or being resolved stops the resolution's clock; a check every 5 minutes flags each miss once and
// tells under the bell; a report shows how many were in time.
const IST = (local) => new Date(`${local}+05:30`);
const HOUR = 60 * 60 * 1000;
let number = 5000;

// A ticket made at a chosen moment, as POST /tickets makes it.
async function made(organizationId, at, fields = {}) {
  const ticket = new Ticket({ organizationId, number: (number += 1), subject: 'Printer stopped', ...fields });
  await ticketSla.apply(organizationId, ticket, at);
  await ticket.save();
  await Ticket.collection.updateOne({ _id: ticket._id }, { $set: { createdAt: at } });
  return ticket._id;
}

// What PATCH /tickets/:id does to the SLA at a chosen moment (resolvedAt as ticketService sets it).
async function change(organizationId, id, fields, at) {
  const ticket = await Ticket.findById(id);
  ticket.set(fields);
  await ticketSla.apply(organizationId, ticket, at);
  if (['Resolved', 'Closed'].includes(ticket.status)) ticket.resolvedAt = ticket.resolvedAt || at;
  else ticket.resolvedAt = undefined;
  await ticket.save();
  return ticket;
}
const noteAt = async (id, at) => ticketSla.noteAdded(await Ticket.findById(id), at);
const slaAt = async (id, at) => ticketSla.slaOf(await Ticket.findById(id).lean(), at);

describe('Ticket SLA (G3, D107)', () => {
  it('counts working minutes: Mon–Sat 10:00–19:00 in India by default', () => {
    const hours = businessHoursOf({});
    expect(addWorkingMinutes(hours, IST('2026-10-30T18:30:00'), 60)).toEqual(IST('2026-10-31T10:30:00')); // Friday evening → Saturday
    expect(addWorkingMinutes(hours, IST('2026-10-31T18:00:00'), 120)).toEqual(IST('2026-11-02T11:00:00')); // Sunday is off
    expect(addWorkingMinutes(hours, IST('2026-11-01T22:00:00'), 30)).toEqual(IST('2026-11-02T10:30:00'));
    expect(workingMinutesBetween(hours, IST('2026-10-30T12:00:00'), IST('2026-11-02T11:00:00'))).toBe(1020); // 420 + 540 + 60
    expect(workingMinutesBetween(hours, IST('2026-11-01T09:00:00'), IST('2026-11-01T20:00:00'))).toBe(0);
    expect(workingMinutesBetween({ days: [] }, IST('2026-11-01T09:00:00'), IST('2026-11-01T10:30:00'))).toBe(90);
  });

  describe('due times', () => {
    let organizationId;
    beforeAll(async () => { organizationId = (await login('sla-owner@example.com', { name: 'Sunita Owner' })).data.organizationId; });

    it('sets the first reply and the resolution by priority in working hours, and again from the start for a new priority', async () => {
      const id = await made(organizationId, IST('2026-10-30T18:30:00'), { priority: 'Urgent' });
      expect((await Ticket.findById(id).lean()).sla).toMatchObject({ replyDueAt: IST('2026-10-31T10:30:00'), resolveDueAt: IST('2026-10-31T17:30:00'), workingHours: true });

      // The first reply was missed; made Low, the new times run from when the ticket was made.
      await Ticket.updateOne({ _id: id }, { $set: { 'sla.replyBreachedAt': IST('2026-10-31T10:35:00') } });
      const low = await change(organizationId, id, { priority: 'Low' }, IST('2026-10-31T11:00:00'));
      expect(low.sla.replyDueAt).toEqual(IST('2026-11-02T18:30:00')); // 30 + 540 + 510 working minutes
      expect(low.sla.resolveDueAt).toEqual(IST('2026-11-11T18:30:00'));
      expect(low.sla.replyBreachedAt).toBeUndefined(); // not missed any more
      expect(await slaAt(id, IST('2026-10-31T11:00:00'))).toMatchObject({ reply: { at: null, state: 'due' }, resolve: { state: 'due' }, workingHours: true });
      expect(await slaAt(id, IST('2026-11-03T11:00:00'))).toMatchObject({ reply: { state: 'breached' }, resolve: { state: 'due' } });
    });

    it('stops the resolution\'s clock while it waits on the customer or is resolved', async () => {
      const id = await made(organizationId, IST('2026-11-02T10:00:00')); // Medium: 8 h to reply, 45 h to resolve
      expect((await Ticket.findById(id).lean()).sla).toMatchObject({ replyDueAt: IST('2026-11-02T18:00:00'), resolveDueAt: IST('2026-11-06T19:00:00') });

      // Put on Waiting on Customer on Tuesday noon: that is the first reply (after Monday 6 pm: late).
      await change(organizationId, id, { status: 'Waiting on Customer' }, IST('2026-11-03T12:00:00'));
      expect(await slaAt(id, IST('2026-11-09T12:00:00'))).toMatchObject({ reply: { at: IST('2026-11-03T12:00:00'), state: 'late' }, resolve: { state: 'paused' } });

      // The customer answered on Wednesday noon: 540 working minutes waited, so it is due Saturday 7 pm.
      const back = await change(organizationId, id, { status: 'Open' }, IST('2026-11-04T12:00:00'));
      expect(back.sla.resolveDueAt).toEqual(IST('2026-11-07T19:00:00'));
      expect(back.sla.pausedMinutes).toBe(540);
      expect(back.sla.pausedAt).toBeUndefined();

      // Resolved on Saturday at 6 pm, in time; reopened on Monday at 11, the hour left is left again.
      await change(organizationId, id, { status: 'Resolved' }, IST('2026-11-07T18:00:00'));
      expect(await slaAt(id, IST('2026-11-09T09:00:00'))).toMatchObject({ resolve: { at: IST('2026-11-07T18:00:00'), state: 'met' } });
      const reopened = await change(organizationId, id, { status: 'Open' }, IST('2026-11-09T11:00:00'));
      expect(reopened.sla.resolveDueAt).toEqual(IST('2026-11-09T12:00:00'));
      expect(reopened.sla.pausedMinutes).toBe(660);
      expect(await slaAt(id, IST('2026-11-09T12:30:00'))).toMatchObject({ resolve: { at: null, state: 'breached' } });
    });

    it('counts the first note as the first reply, and the wait when a ticket is resolved straight from waiting', async () => {
      const id = await made(organizationId, IST('2026-11-02T10:00:00'), { priority: 'Urgent' }); // 1 h / 8 h
      await noteAt(id, IST('2026-11-02T10:30:00'));
      await noteAt(id, IST('2026-11-02T10:50:00')); // only the first counts
      await change(organizationId, id, { status: 'Waiting on Customer' }, IST('2026-11-02T11:00:00'));
      await change(organizationId, id, { status: 'Resolved' }, IST('2026-11-04T11:00:00'));
      expect(await slaAt(id, IST('2026-11-04T11:00:00'))).toMatchObject({
        reply: { dueAt: IST('2026-11-02T11:00:00'), at: IST('2026-11-02T10:30:00'), state: 'met' },
        resolve: { dueAt: IST('2026-11-04T18:00:00'), at: IST('2026-11-04T11:00:00'), state: 'met' }, // 1,080 minutes waited
      });

      // Made straight on Waiting on Customer: replied at once, the resolution waits.
      const waiting = await made(organizationId, IST('2026-11-02T10:00:00'), { status: 'Waiting on Customer' });
      expect(await slaAt(waiting, IST('2026-11-20T10:00:00'))).toMatchObject({ reply: { state: 'met' }, resolve: { state: 'paused' } });
    });
  });

  describe('settings and the pages', () => {
    it('lets everyone on Support read the limits, owners and admins change them, and follows them for new tickets', async () => {
      const owner = await login('sla-api-owner@example.com');
      const agent = await inviteAndJoin(owner.token, 'sla-api-agent@example.com');
      const read = await api().get('/api/v1/ticket-sla').set(bearer(agent.token));
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({
        enabled: true, workingHoursOnly: true,
        limits: { Urgent: { reply: 60, resolve: 480 }, Medium: { reply: 480, resolve: 2700 }, Low: { reply: 1080, resolve: 5400 } },
        businessHours: { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '19:00', timezone: 'Asia/Kolkata' },
      });
      expect((await api().patch('/api/v1/ticket-sla').set(bearer(agent.token)).send({ enabled: false })).status).toBe(403);
      const wrong = await api().patch('/api/v1/ticket-sla').set(bearer(owner.token)).send({ limits: { Urgent: { reply: 120, resolve: 60 } } });
      expect(wrong.status).toBe(400);
      expect(wrong.body.errors[0]).toMatchObject({ field: 'limits.Urgent', message: 'The first reply cannot be due after the resolution' });
      expect((await api().patch('/api/v1/ticket-sla').set(bearer(owner.token)).send({ limits: { High: { reply: 2, resolve: 60 } } })).status).toBe(400);

      const saved = await api().patch('/api/v1/ticket-sla').set(bearer(owner.token)).send({ workingHoursOnly: false, limits: { Urgent: { reply: 30, resolve: 240 } } });
      expect(saved.status).toBe(200);
      expect(saved.body.data).toMatchObject({ enabled: true, workingHoursOnly: false, limits: { Urgent: { reply: 30, resolve: 240 }, High: { reply: 240, resolve: 1080 } } });
      expect(await AuditLog.countDocuments({ organizationId: owner.data.organizationId, action: 'ticket_sla.updated' })).toBe(1);

      // Every minute counts now: a new Urgent ticket's first reply is due 30 minutes after it is made.
      const before = Date.now();
      const ticket = (await api().post('/api/v1/tickets').set(bearer(owner.token)).send({ subject: 'Wrong item sent', priority: 'Urgent' })).body.data;
      const replyIn = new Date(ticket.sla.reply.dueAt).getTime() - before;
      expect(replyIn).toBeGreaterThanOrEqual(30 * 60 * 1000);
      expect(replyIn).toBeLessThan(31 * 60 * 1000);
      expect(ticket.sla).toMatchObject({ reply: { at: null, state: 'due' }, resolve: { at: null, state: 'due' }, workingHours: false });

      // The first note is the first reply; the list shows the SLA too.
      expect((await api().post(`/api/v1/tickets/${ticket.id}/notes`).set(bearer(owner.token)).send({ text: 'Sending the right one today.' })).status).toBe(201);
      expect((await api().get(`/api/v1/tickets/${ticket.id}`).set(bearer(owner.token))).body.data.sla.reply.state).toBe('met');
      const listed = (await api().get('/api/v1/tickets').set(bearer(owner.token))).body.data.find((t) => t.id === ticket.id);
      expect(listed.sla.reply.state).toBe('met');

      // A new priority follows the limits from when it was made.
      const high = (await api().patch(`/api/v1/tickets/${ticket.id}`).set(bearer(owner.token)).send({ priority: 'High' })).body.data;
      expect(new Date(high.sla.resolve.dueAt) - new Date(high.createdAt)).toBe(1080 * 60 * 1000);

      // Switched off: new tickets have none.
      await api().patch('/api/v1/ticket-sla').set(bearer(owner.token)).send({ enabled: false });
      expect((await api().post('/api/v1/tickets').set(bearer(owner.token)).send({ subject: 'No SLA' })).body.data.sla).toBeNull();
    });
  });

  describe('the check every 5 minutes', () => {
    it('flags each missed first reply or resolution once and tells the ticket\'s person and the managers', async () => {
      const owner = await login('sla-check-owner@example.com', { name: 'Kiran Owner' });
      const agent = await inviteAndJoin(owner.token, 'sla-check-agent@example.com');
      const organizationId = owner.data.organizationId;
      const now = new Date();
      const past = new Date(now.getTime() - HOUR);
      const soon = new Date(now.getTime() + HOUR);
      const overdue = async (fields, sla) => {
        const id = await made(organizationId, new Date(now.getTime() - 5 * HOUR), fields);
        await Ticket.updateOne({ _id: id }, { $set: Object.fromEntries(Object.entries(sla).map(([key, value]) => [`sla.${key}`, value])) });
        return id;
      };
      const missed = await overdue({ priority: 'Urgent', subject: 'Machine not starting', assigneeId: agent.data.member.id }, { replyDueAt: past, resolveDueAt: past });
      await overdue({}, { replyDueAt: past, resolveDueAt: soon, firstReplyAt: past }); // answered, still has time
      await overdue({ status: 'Waiting on Customer' }, { replyDueAt: past, resolveDueAt: past }); // paused
      await overdue({ status: 'Resolved' }, { replyDueAt: past, resolveDueAt: past });

      // Another company has the SLA switched off.
      const other = await login('sla-check-off@example.com');
      await api().patch('/api/v1/ticket-sla').set(bearer(other.token)).send({ enabled: false });
      const quiet = await made(other.data.organizationId, new Date(now.getTime() - 5 * HOUR));
      await Ticket.updateOne({ _id: quiet }, { $set: { 'sla.replyDueAt': past, 'sla.resolveDueAt': past } });

      await ticketSla.checkBreaches(now);
      const notes = await Notification.find({ organizationId, source: 'support' }).sort({ title: 1 }).lean();
      const ticketNo = (await Ticket.findById(missed).lean()).number;
      expect(notes.map((n) => [String(n.memberId), n.title])).toEqual(expect.arrayContaining([
        [owner.data.member.id, `Ticket #${ticketNo}: first reply time missed`],
        [owner.data.member.id, `Ticket #${ticketNo}: resolution time missed`],
        [agent.data.member.id, `Ticket #${ticketNo}: first reply time missed`],
        [agent.data.member.id, `Ticket #${ticketNo}: resolution time missed`],
      ]));
      expect(notes).toHaveLength(4);
      expect(notes[0]).toMatchObject({ link: `Support.html?open=${missed}`, source: 'support' });
      expect(notes[0].body).toMatch(/^Machine not starting \(Urgent\): /);
      expect((await Ticket.findById(missed).lean()).sla).toMatchObject({ replyBreachedAt: now, resolveBreachedAt: now });
      expect(await Notification.countDocuments({ organizationId: other.data.organizationId })).toBe(0);

      // Once each: the next check tells nobody again.
      await ticketSla.checkBreaches(new Date(now.getTime() + 5 * 60 * 1000));
      expect(await Notification.countDocuments({ organizationId, source: 'support' })).toBe(4);
    });
  });

  describe('the report', () => {
    it('shows the first replies and resolutions in time, by priority and by person', async () => {
      const owner = await login('sla-report-owner@example.com', { name: 'Rohit Owner' });
      const agent = await inviteAndJoin(owner.token, 'sla-report-agent@example.com');
      const organizationId = owner.data.organizationId;
      const agentId = agent.data.member.id;
      // Monday 19 October 2026.
      const a = await made(organizationId, IST('2026-10-19T10:00:00'), { priority: 'Urgent', assigneeId: agentId });
      await noteAt(a, IST('2026-10-19T10:20:00')); // in time
      await change(organizationId, a, { status: 'Resolved' }, IST('2026-10-19T15:00:00')); // in time
      const b = await made(organizationId, IST('2026-10-19T10:00:00'), { priority: 'Urgent', assigneeId: agentId });
      await noteAt(b, IST('2026-10-19T12:00:00')); // late; still open long after 6 pm
      await made(organizationId, IST('2026-10-19T11:00:00'), { priority: 'Low' }); // nobody's, never answered
      const d = await made(organizationId, IST('2026-10-19T10:00:00'), { assigneeId: agentId });
      await change(organizationId, d, { status: 'Waiting on Customer' }, IST('2026-10-19T12:00:00'));
      await made(organizationId, IST('2026-10-20T10:00:00')); // the next day: outside the range

      const res = await api().get('/api/v1/reports/sla?from=2026-10-19&to=2026-10-19').set(bearer(owner.token));
      expect(res.status).toBe(200);
      const { total, byPriority, byMember } = res.body.data;
      expect(total).toEqual({
        tickets: 4,
        reply: { met: 2, late: 1, breached: 1, due: 0, metPct: 50 },
        resolve: { met: 1, late: 0, breached: 2, due: 0, paused: 1, metPct: 33.3 },
        firstReplyMedianMinutes: 120,
      });
      expect(byPriority.map((p) => [p.priority, p.tickets, p.reply.metPct, p.resolve.metPct])).toEqual([
        ['Urgent', 2, 50, 50], ['High', 0, null, null], ['Medium', 1, 100, null], ['Low', 1, 0, 0],
      ]);
      expect(byPriority[0].firstReplyMedianMinutes).toBe(70);
      expect(byMember.map((m) => [m.name, m.tickets])).toEqual([['sla-report-agent', 3], [null, 1]]);

      // A member who may see reports but not every ticket sees their own.
      await OrganizationMember.updateOne({ _id: agentId }, { $addToSet: { modules: 'reports' } });
      const own = (await api().get('/api/v1/reports/sla?from=2026-10-19&to=2026-10-19').set(bearer(agent.token))).body.data;
      expect(own.total.tickets).toBe(3);
      expect(own.byMember.map((m) => m.name)).toEqual(['sla-report-agent']);
    });
  });
});
