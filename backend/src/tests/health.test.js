const { api } = require('./helpers/api');

describe('Health Check API', () => {
  it('returns 200 with the database state (start-crm.vbs looks for "dbState")', async () => {
    const res = await api().get('/api/v1/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.data).toHaveProperty('status', 'UP');
    expect(res.body.data).toHaveProperty('dbState', 1);
    expect(res.text).toContain('"dbState"');
  });
});
