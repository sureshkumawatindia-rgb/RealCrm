const crypto = require('crypto');
const Organization = require('../models/Organization');
const httpError = require('../utils/httpError');

// Made-up data for a staging company (F2): products, a project template, ten customers with
// their deals at every stage, follow-up tasks and a project from a won deal. Everything is made
// through the CRM's own API with the signed-in owner's or admin's session, so it is checked,
// counted and audited like anything a person adds. Once per company.

// Made-up names; the numbers follow one made-up series. Staging sends nothing to real
// customers (the providers are test stand-ins there).
const LEADS = [
  { title: 'Rooftop 10 kW', name: 'Bhatia Farms', source: 'IndiaMART', value: 450000, stage: 'Won' },
  { title: 'Cold storage solar 25 kW', name: 'Patel Dairy', source: 'Website', value: 1200000, stage: 'Negotiation' },
  { title: 'Home solar 3 kW', name: 'Anita Sharma', source: 'WhatsApp', value: 180000, stage: 'Quote Sent' },
  { title: 'Factory rooftop 50 kW', name: 'Gill Agro Industries', source: 'JustDial', value: 2100000, stage: 'Contacted' },
  { title: 'School rooftop 15 kW', name: 'Saraswati Vidya Mandir', source: 'Google Ads', value: 650000, stage: 'New' },
  { title: 'Petrol pump solar 8 kW', name: 'Kapoor Fuels', source: 'IndiaMART', value: 320000, stage: 'Won' },
  { title: 'Clinic backup 5 kW', name: 'Dr. Mehta Clinic', source: 'Facebook', value: 220000, stage: 'Lost' },
  { title: 'Warehouse lighting', name: 'Verma Logistics', source: 'TradeIndia', value: 90000, stage: 'New' },
  { title: 'Hotel water heating', name: 'Hotel Shiv Palace', source: 'Website', value: 270000, stage: 'Contacted' },
  { title: 'Society common area 20 kW', name: 'Green Park Society', source: 'Manual', value: 800000, stage: 'Quote Sent' },
];
const PRODUCTS = [
  { name: 'Solar panel 540 W', unit: 'pc', hsnSac: '8541', pricePaise: 1450000, gstRatePct: 12 },
  { name: 'Solar inverter 5 kW', unit: 'pc', hsnSac: '8504', pricePaise: 4200000, gstRatePct: 18 },
  { name: 'Installation service', unit: 'job', hsnSac: '9954', pricePaise: 800000, gstRatePct: 18 },
  { name: 'Annual maintenance (AMC)', unit: 'year', hsnSac: '9987', pricePaise: 600000, gstRatePct: 18 },
];
const TEMPLATE = {
  name: 'Solar installation', days: 30,
  milestones: [{ name: 'Site survey', dueAfterDays: 3 }, { name: 'Installation', dueAfterDays: 20 }, { name: 'Handover', dueAfterDays: 30 }],
  tasks: [
    { title: 'Visit the site', milestone: 0, dueAfterDays: 2, priority: 'High' },
    { title: 'Order the panels', milestone: 1, dueAfterDays: 5 },
    { title: 'Fit the panels', milestone: 1, dueAfterDays: 18 },
    { title: 'Train the customer', milestone: 2, dueAfterDays: 30 },
  ],
};
const TASKS = [
  { lead: 1, title: 'Call back about the final price', days: 1, priority: 'High' },
  { lead: 2, title: 'Send the revised quotation', days: 2, priority: 'Medium' },
  { lead: 3, title: 'Book a site visit', days: 3, priority: 'Medium' },
  { lead: 4, title: 'First call: understand the roof size', days: 0, priority: 'High' },
  { lead: 8, title: 'Share case studies on WhatsApp', days: 4, priority: 'Low' },
  { lead: 9, title: 'Follow up on the society meeting', days: 7, priority: 'Medium' },
];

// A day in India, n days from today, as YYYY-MM-DD.
const indiaDay = (n) => new Date(Date.now() + 5.5 * 3600 * 1000 + n * 86400 * 1000).toISOString().slice(0, 10);

function apiCaller(req) {
  const base = `http://127.0.0.1:${req.socket.localPort}/api/v1`;
  const authorization = req.get('authorization');
  return async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(authorization && { Authorization: authorization }),
        ...(method === 'POST' && { 'Idempotency-Key': `sample-${crypto.randomBytes(8).toString('hex')}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw httpError(502, 'SAMPLE_DATA_FAILED', `Sample data stopped at ${method} ${path}: ${json.message || response.status}`);
    return json.data;
  };
}

async function make(req) {
  const call = apiCaller(req);
  for (const product of PRODUCTS) await call('POST', '/products', product);
  const template = await call('POST', '/project-templates', TEMPLATE);
  const leads = [];
  for (const [index, lead] of LEADS.entries()) {
    const made = await call('POST', '/leads', {
      title: lead.title,
      source: lead.source,
      expectedValuePaise: lead.value * 100,
      contact: { name: lead.name, phone: `+9190000100${String(index + 1).padStart(2, '0')}`, company: lead.name },
    });
    if (lead.stage !== 'New') await call('POST', `/leads/${made.id}/stage`, { stage: lead.stage, ...(lead.stage === 'Lost' && { lostReason: 'Price' }) });
    leads.push(made);
  }
  for (const task of TASKS) {
    await call('POST', '/tasks', { title: task.title, dueDate: indiaDay(task.days), priority: task.priority, relatedType: 'Lead', relatedId: leads[task.lead].id });
  }
  const project = await call('POST', `/leads/${leads[0].id}/project`, { templateId: template.id });
  const [first] = await call('GET', `/projects/${project.id}/tasks`);
  if (first) await call('PATCH', `/projects/${project.id}/tasks/${first.id}`, { status: 'Done' });
  return { products: PRODUCTS.length, customers: LEADS.length, leads: LEADS.length, tasks: TASKS.length, projects: 1 };
}

async function fill(req) {
  const organizationId = req.tenant.organizationId;
  const claimed = await Organization.updateOne({ _id: organizationId, 'settings.sampleDataAt': null }, { $set: { 'settings.sampleDataAt': new Date() } });
  if (!claimed.modifiedCount) throw httpError(409, 'SAMPLE_DATA_EXISTS', 'Sample data was already added to this company.');
  try {
    return await make(req);
  } catch (error) {
    // What was made stays (it is made-up data); the button may be pressed again.
    await Organization.updateOne({ _id: organizationId }, { $unset: { 'settings.sampleDataAt': 1 } });
    throw error;
  }
}

module.exports = { fill, LEADS, TASKS };
