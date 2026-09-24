const request = require('supertest');
const app = require('../app');
const mongoose = require('mongoose');

describe('Health Check API', () => {
  afterAll(async () => {
    await mongoose.connection.close();
  });

  it('should return 200 OK and health status', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('data');
    expect(res.body.data).toHaveProperty('status', 'UP');
  });
});
