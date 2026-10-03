jest.mock('../integrations/google/idToken', () => require('./helpers/fakeGoogle'));

const QRCode = require('qrcode');
const LeadActivity = require('../models/LeadActivity');
const Quotation = require('../models/Quotation');
const signedLink = require('../utils/signedLink');
const { amountInWords } = require('../utils/money');
const { upiLink } = require('../services/quotationPdf');
const { api, bearer, login } = require('./helpers/api');

// Phase 5C: the PDF and the customer's link ("Viewed").
const pages = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;

describe('Building blocks', () => {
  it('signs links that cannot be changed or reused for something else', () => {
    const id = '6abbdf0e3d3e1fca00417b9e';
    const token = signedLink.sign('quotation', id);
    expect(token).toMatch(/^6abbdf0e3d3e1fca00417b9e\.[A-Za-z0-9_-]{43}$/);
    expect(signedLink.verify('quotation', token)).toBe(id);
    expect(signedLink.verify('order', token)).toBeNull();
    expect(signedLink.verify('quotation', token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();
    expect(signedLink.verify('quotation', `6abbdf0e3d3e1fca00417b9f.${token.split('.')[1]}`)).toBeNull();
    expect(signedLink.verify('quotation', 'nonsense')).toBeNull();
    expect(signedLink.verify('quotation', `${token}.extra`)).toBeNull();
  });

  it('writes amounts in words the Indian way', () => {
    expect(amountInWords(1271300)).toBe('Rupees Twelve Thousand Seven Hundred Thirteen Only');
    expect(amountInWords(12713050)).toBe('Rupees One Lakh Twenty-Seven Thousand One Hundred Thirty and Fifty Paise Only');
    expect(amountInWords(12345678912)).toBe('Rupees Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine and Twelve Paise Only');
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(5)).toBe('Rupees Zero and Five Paise Only');
  });

  it('makes NPCI UPI payment links', () => {
    expect(upiLink({ upiId: 'yellowtraders@okhdfcbank', payee: 'Yellow Traders', amountPaise: 1271300, note: 'QT/2026-27/0001' }))
      .toBe('upi://pay?pa=yellowtraders@okhdfcbank&pn=Yellow%20Traders&am=12713.00&cu=INR&tn=QT%2F2026-27%2F0001');
    expect(upiLink({ upiId: 'a.b@ybl', payee: 'A & B', amountPaise: 0 })).toBe('upi://pay?pa=a.b@ybl&pn=A%20%26%20B&cu=INR');
  });
});

describe('Quotation PDF and the customer link', () => {
  let owner;
  let quotation;
  const auth = () => bearer(owner.token);

  beforeAll(async () => {
    owner = await login('pdf-owner@example.com');
    await api().patch('/api/v1/organization').set(auth()).send({ name: 'Yellow Traders', gstin: '08AAACY1234C1Z5', address: '12 MI Road', city: 'Jaipur', phone: '+91 98290 00000' });
    const logo = await QRCode.toBuffer('logo', { type: 'png' });
    expect((await api().post('/api/v1/organization/logo').set(auth()).attach('logo', logo, 'logo.png')).status).toBe(200);
    await api().put('/api/v1/organization/billing').set(auth()).send({ upiId: 'yellowtraders@okhdfcbank', bank: { accountName: 'Yellow Traders', accountNumber: '50100012345678', ifsc: 'HDFC0001234' }, terms: '50% advance.' });
    const contact = (await api().post('/api/v1/contacts').set(auth()).send({ name: 'Ravi <script>alert(1)</script>', phone: '9829012345', state: 'Rajasthan' })).body.data;
    const lead = (await api().post('/api/v1/leads').set(auth()).send({ contactId: contact.id, title: 'Spices' })).body.data;
    const items = Array.from({ length: 45 }, (_, i) => ({ name: `Spice blend number ${i + 1} with a longer description to wrap`, hsnSac: '0910', unit: 'kg', quantity: 2 + i, unitPricePaise: 12550, gstRatePct: i % 2 ? 5 : 18 }));
    quotation = (await api().post('/api/v1/quotations').set(auth()).send({ leadId: lead.id, items })).body.data;
  });

  it('downloads a multi-page PDF with the fonts, logo and QR code embedded', async () => {
    const res = await api().get(`/api/v1/quotations/${quotation.id}/pdf`).set(auth()).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${quotation.number.replace(/\//g, '-')}.pdf"`);
    const pdf = res.body;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pages(pdf)).toBeGreaterThanOrEqual(2);
    expect(pdf.toString('latin1')).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Bold/);
    expect((pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length).toBeGreaterThanOrEqual(2); // logo + UPI QR

    const stranger = await login('pdf-stranger@example.com');
    expect((await api().get(`/api/v1/quotations/${quotation.id}/pdf`).set(bearer(stranger.token))).status).toBe(404);
  });

  it('gives a link a draft does not show yet; once sent, opening it marks the quotation Viewed', async () => {
    expect(quotation.shareUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:3000/q/${quotation.id}\\.[A-Za-z0-9_-]{43}$`));
    const path = new URL(quotation.shareUrl).pathname;

    const draft = await api().get(path);
    expect(draft.status).toBe(200);
    expect(draft.text).toContain('is being updated');
    expect(draft.text).not.toContain('Spice blend');
    expect((await api().get(`${path}/pdf`)).status).toBe(404);

    await api().patch(`/api/v1/quotations/${quotation.id}`).set(auth()).send({ status: 'Sent' });
    const preview = await api().get(`${path}?preview=1`);
    expect(preview.text).toContain(quotation.number);
    expect(await Quotation.findById(quotation.id)).toMatchObject({ status: 'Sent', viewCount: 0 });

    const page = await api().get(path);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(page.text).toContain('Spice blend number 45');
    expect(page.text).toContain('Ravi &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.text).not.toContain('<script>');
    expect(page.text).toContain('upi://pay?pa=yellowtraders@okhdfcbank');
    expect(page.text).toContain('data:image/png;base64,'); // the QR code (and the logo)
    expect(page.text).toContain('Rupees ');
    await api().get(path);
    const seen = await Quotation.findById(quotation.id);
    expect(seen).toMatchObject({ status: 'Viewed', viewCount: 2 });
    expect(seen.viewedAt).toBeTruthy();
    const opened = await LeadActivity.find({ leadId: seen.leadId, text: /opened by the customer$/ });
    expect(opened).toHaveLength(1);

    const pdf = await api().get(`${path}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-disposition']).toMatch(/^inline; filename=/);

    expect((await api().get(path.replace(/.$/, (c) => (c === 'x' ? 'y' : 'x')))).status).toBe(404);
    await api().delete(`/api/v1/quotations/${quotation.id}`).set(auth());
    expect((await api().get(path)).status).toBe(404);
  });
});
