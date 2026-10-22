jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const xlsx = require('../utils/xlsx');
const { api, bearer, login, inviteAndJoin } = require('./helpers/api');

// Phase 4A (D82): Excel files in and out, and the Excel / Power BI feeds.
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};
const download = (path, token) => api().get(path).set(bearer(token)).buffer(true).parse(binary);

// An .xlsx laid out the way Excel saves one: shared strings, a date style, a number stored as a
// number, a TRUE, a skipped cell, rich text and an empty formatted row at the end.
function excelLikeFile() {
  const NS = 'http://schemas.openxmlformats.org';
  const strings = ['Party Name', 'Mobile No', 'City', 'Since', 'Active', 'Ravi Traders', 'Jaipur', 'Meena &amp; Sons'];
  return xlsx.zip([
    ['[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`],
    ['xl/workbook.xml', `<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="Parties" sheetId="1" r:id="rId7"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId7" Type="x" Target="worksheets/parties.xml"/></Relationships>`],
    ['xl/sharedStrings.xml', `<sst xmlns="${NS}/spreadsheetml/2006/main" count="9">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}<si><r><t>Kota</t></r><r><t xml:space="preserve"> City</t></r></si></sst>`],
    ['xl/styles.xml', `<styleSheet xmlns="${NS}/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="170" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="170"/></cellXfs></styleSheet>`],
    ['xl/worksheets/parties.xml', `<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>
      <row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>919829080001</v></c><c r="C2" t="s"><v>6</v></c><c r="D2" s="1"><v>46031</v></c><c r="E2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3" t="s"><v>7</v></c><c r="B3"><v>9.829080002E+9</v></c><c r="D3" s="1"/><c r="C3" t="s"><v>8</v></c></row>
      <row r="4" spans="1:5" ht="15"/>
      <row r="5"><c r="A5" s="1"/></row>
    </sheetData></worksheet>`],
  ]);
}

describe('Excel files and feeds (Phase 4A)', () => {
  it('writes files Excel reads back, with text that can never become a formula', () => {
    const when = new Date('2026-10-21T05:00:00Z'); // 10:30 in India
    const buffer = xlsx.write([{ name: 'Contacts / Oct', rows: [['Name', 'Phone', 'Value (₹)', 'Added on', 'Active'], ['=HYPERLINK("http://x")', '+919876543210', 1250.5, when, true], ['रवि ट्रेडर्स', '', null, '', false]] }]);
    const files = xlsx.unzip(buffer);
    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = files.get('xl/worksheets/sheet1.xml')();
    expect(sheet).not.toMatch(/<f>/);
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t></is></c>');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(files.get('xl/workbook.xml')()).toContain('name="Contacts   Oct"'); // "/" is not allowed in a sheet name
    expect(xlsx.read(buffer).rows).toEqual([
      ['Name', 'Phone', 'Value (₹)', 'Added on', 'Active'],
      ['=HYPERLINK("http://x")', '+919876543210', '1250.5', '2026-10-21 10:30', 'TRUE'],
      ['रवि ट्रेडर्स', '', '', '', 'FALSE'],
    ]);
  });

  it('reads an Excel-made file like a CSV, and refuses damaged or locked ones clearly', () => {
    expect(xlsx.read(excelLikeFile()).rows).toEqual([
      ['Party Name', 'Mobile No', 'City', 'Since', 'Active'],
      ['Ravi Traders', '919829080001', 'Jaipur', '2026-01-09', 'TRUE'],
      ['Meena & Sons', '9829080002', 'Kota City', '', ''],
    ]);
    expect(() => xlsx.read(Buffer.from('not a zip at all, just text in a file'))).toThrow(expect.objectContaining({ code: 'BAD_EXCEL_FILE' }));
    const locked = Buffer.from(excelLikeFile());
    const central = locked.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    locked.writeUInt16LE(1, central + 8); // the "encrypted" flag
    expect(() => xlsx.read(locked)).toThrow(/has a password/);
  });

  it('imports customers from an .xlsx with the same preview and mapping as a CSV', async () => {
    const owner = await login('excel-import@example.com', { name: 'Neha' });
    const upload = (path, fields = {}) => {
      const req = api().post(`/api/v1/contacts${path}`).set(bearer(owner.token)).attach('file', excelLikeFile(), 'parties.xlsx');
      for (const [key, value] of Object.entries(fields)) req.field(key, typeof value === 'string' ? value : JSON.stringify(value));
      return req;
    };
    const preview = (await upload('/import/preview')).body.data;
    expect(preview).toMatchObject({ headers: ['Party Name', 'Mobile No', 'City', 'Since', 'Active'], totalRows: 2 });
    expect(preview.mapping.slice(0, 3)).toEqual(['name', 'phone', 'city']);
    const report = (await upload('/import', { mapping: ['name', 'phone', 'city', '', ''] })).body.data;
    expect(report).toMatchObject({ totalRows: 2, created: 2, rejected: 0 });
    expect(await Contact.findOne({ organizationId: owner.data.organizationId, phoneE164: '+919829080001' })).toMatchObject({ name: 'Ravi Traders', city: 'Jaipur', source: 'Import' });
  });

  it('downloads the Contacts and Leads lists as on screen, for owners and admins, and audits it', async () => {
    const owner = await login('excel-list@example.com', { name: 'Om' });
    const agent = await inviteAndJoin(owner.token, 'excel-agent@example.com', { role: 'agent' });
    const field = await api().post('/api/v1/custom-fields').set(bearer(owner.token)).send({ object: 'contact', label: 'Credit days', type: 'number' });
    expect(field.status).toBe(201);
    const add = (body) => api().post('/api/v1/contacts').set(bearer(owner.token)).send(body);
    await add({ name: 'Ravi Traders', phone: '+919829080001', tags: ['VIP'], customFields: { credit_days: 30 } });
    await add({ name: 'Meena Stores', phone: '+919829080002', tags: ['Retail'] });
    await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Steel order', contact: { name: 'Gupta Steels', phone: '+919829080003' }, expectedValuePaise: 1250050 });

    const file = await download('/api/v1/contacts/export?tag=VIP', owner.token);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    expect(file.headers['content-disposition']).toMatch(/attachment; filename="contacts-\d{4}-\d{2}-\d{2}\.xlsx"/);
    const rows = xlsx.read(file.body).rows;
    expect(rows[0]).toEqual(expect.arrayContaining(['Name', 'Phone', 'Owner', 'Tags', 'Credit days']));
    expect(rows).toHaveLength(2); // only the VIP
    const at = (header) => rows[1][rows[0].indexOf(header)];
    expect([at('Name'), at('Phone'), at('Owner'), at('Credit days')]).toEqual(['Ravi Traders', '+919829080001', 'Om', '30']);

    const csv = await api().get('/api/v1/leads/export?format=csv').set(bearer(owner.token));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toMatch(/^﻿ID,Lead,Customer,Customer phone,Customer ID,Stage,Source,Owner,Value \(₹\)/);
    expect(csv.text).toContain("Steel order,Gupta Steels,'+919829080003"); // a CSV cell starting with + gets an apostrophe (never a formula)
    expect(csv.text).toContain(',12500.5,');

    expect((await api().get('/api/v1/contacts/export').set(bearer(agent.token))).status).toBe(403);
    expect((await api().get('/api/v1/leads/export').set(bearer(agent.token))).status).toBe(403);
    expect(await AuditLog.countDocuments({ organizationId: owner.data.organizationId, action: { $in: ['contacts.exported', 'leads.exported'] } })).toBe(2);
    // Another company's file has none of these.
    const other = await login('excel-other@example.com', { name: 'Other' });
    expect(xlsx.read((await download('/api/v1/contacts/export', other.token)).body).rows).toHaveLength(1);
  });

  it('gives every report tab as Excel with the same rows as the CSV', async () => {
    const owner = await login('excel-report@example.com', { name: 'Pooja' });
    await api().post('/api/v1/leads').set(bearer(owner.token)).send({ title: 'Enquiry', contact: { name: 'A', phone: '+919829080011' } });
    const csv = (await api().get('/api/v1/reports/export?type=sources').set(bearer(owner.token))).text.replace(/^﻿/, '').trim().split('\r\n');
    const file = await download('/api/v1/reports/export?type=sources&format=xlsx', owner.token);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    const rows = xlsx.read(file.body).rows;
    expect(rows[0].join(',')).toBe(csv[2]); // the CSV has a title line and a blank line first
    expect(rows.slice(1).map((r) => r.join(','))).toEqual(csv.slice(3).map((line) => line.replace(/(^|,)(-?\d+)\.00(?=,|$)/g, '$1$2').replace(/(^|,)(-?\d+\.\d)0(?=,|$)/g, '$1$2')));
  });

  it('feeds Excel and Power BI flat rows in rupees, per scope, and only the key\'s company', async () => {
    const owner = await login('feed-owner@example.com', { name: 'Qadir' });
    const organizationId = new mongoose.Types.ObjectId(owner.data.organizationId);
    await api().post('/api/v1/contacts').set(bearer(owner.token)).send({ name: 'Ravi Traders', phone: '+919829080021', tags: ['VIP', 'North'] });
    await Product.create({ organizationId, name: 'Jeera 1 kg', sku: 'JR1', pricePaise: 25050, gstRatePct: 5, stockQty: 40 });
    const key = (await api().post('/api/v1/api-keys').set(bearer(owner.token)).send({ name: 'Power BI', scopes: ['contacts:read', 'products:read'] })).body.data.key;
    const feed = (path) => api().get(`/api/public/v1/feeds/${path}`).set('Authorization', `Bearer ${key}`);

    const contacts = (await feed('contacts')).body.data;
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ name: 'Ravi Traders', phone: '+919829080021', tags: 'VIP, North', owner: 'Qadir', whatsappConsent: 'unknown' });
    expect(contacts[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await feed('contacts?format=csv')).text).toContain(',Ravi Traders,+919829080021,'); // no apostrophe for a plain phone in a feed
    expect((await feed('products')).body.data[0]).toMatchObject({ name: 'Jeera 1 kg', sku: 'JR1', priceRupees: 250.5, gstRatePct: 5, stockQty: 40, active: true });
    const csv = await feed('products?format=csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toBe('﻿id,name,sku,category,unit,hsnSac,priceRupees,gstRatePct,moq,stockQty,active,updatedAt');

    // Only the changed rows; the scope of each table; a table that does not exist.
    expect((await feed(`contacts?updatedSince=${new Date(Date.now() + 60000).toISOString()}`)).body.data).toEqual([]);
    expect((await feed('leads')).body.code).toBe('SCOPE_MISSING');
    expect((await feed('everything')).status).toBe(400);

    // Another company's key sees its own rows only.
    const other = await login('feed-other@example.com', { name: 'Other' });
    const otherKey = (await api().post('/api/v1/api-keys').set(bearer(other.token)).send({ name: 'BI', scopes: ['contacts:read'] })).body.data.key;
    expect((await api().get('/api/public/v1/feeds/contacts').set('Authorization', `Bearer ${otherKey}`)).body.data).toEqual([]);
  });
});
