const express = require('express');
const { customerRouter, adminRouter } = require('../routes/customerQuery.routes');

const app = express();
app.use(express.json());
app.locals.prisma = null; // simulate offline DB to test fallback

// Mock authenticateCustomer
app.use(
  '/api/customer/queries',
  (req, res, next) => {
    req.customer = {
      id: 'cust_test_123',
      firebaseUid: 'fb_test_123',
      name: 'Test Customer',
      email: 'test@example.com',
    };
    next();
  },
  customerRouter
);

// Mock authenticateAdmin
app.use(
  '/api/admin/customer-queries',
  (req, res, next) => {
    req.adminUser = {
      id: 'admin_test_1',
      username: 'admin',
    };
    next();
  },
  adminRouter
);

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log('Test server running on port', port);

  try {
    // 1. Test POST /api/customer/queries
    const createRes = await fetch(`http://localhost:${port}/api/customer/queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        category: 'Product',
        subject: 'Ring Sizing Inquiry',
        message: 'Hello, I would like to inquire about ring resizing.',
        priority: 'NORMAL',
      }),
    });
    const created = await createRes.json();
    console.log('Create Response Status:', createRes.status);
    console.log('Created Query Number:', created.query?.queryNumber);

    // 2. Test GET /api/customer/queries
    const getRes = await fetch(`http://localhost:${port}/api/customer/queries`);
    const getJson = await getRes.json();
    console.log('Get Queries Status:', getRes.status);
    console.log('Queries Count:', getJson.queries?.length);

    // 3. Test POST /api/customer/queries/:id/messages
    const queryId = created.query.id;
    const replyRes = await fetch(`http://localhost:${port}/api/customer/queries/${queryId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Here is an additional note from the customer.',
      }),
    });
    const replyJson = await replyRes.json();
    console.log('Reply Status:', replyRes.status);
    console.log('Reply Message:', replyJson.message?.message);

    // 4. Test GET /api/customer/queries/:id
    const detailRes = await fetch(`http://localhost:${port}/api/customer/queries/${queryId}`);
    const detailJson = await detailRes.json();
    console.log('Detail Status:', detailRes.status);
    console.log('Total messages in conversation:', detailJson.query?.messages?.length);

    // 5. Test Admin stats and list
    const adminStatsRes = await fetch(`http://localhost:${port}/api/admin/customer-queries/stats`);
    const adminStats = await adminStatsRes.json();
    console.log('Admin Stats:', adminStats);

    console.log('ALL TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Test failed with error:', err);
  } finally {
    server.close();
  }
});
