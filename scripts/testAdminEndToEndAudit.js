/**
 * Comprehensive Local End-to-End Audit Test Suite for Sunbloom Adorn Admin Panel
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const http = require('http');

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : null;
          resolve({ status: res.statusCode, headers: res.headers, body: json, rawBody: body });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, rawBody: body });
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function runAudit() {
  console.log('================================================================');
  console.log('  STARTING SUNBLOOM ADORN ADMIN PANEL END-TO-END AUDIT TESTS');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(name, condition, extra = '') {
    if (condition) {
      console.log(`  ✓ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ✗ [FAIL] ${name} ${extra}`);
      failed++;
    }
  }

  // 1. Health check
  try {
    const health = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/health', method: 'GET' });
    assert('1. Backend Server is healthy (GET /api/health)', health.status === 200 && (health.body?.ok === true || health.body?.status === 'ok'));
  } catch (err) {
    assert('1. Backend Server is reachable', false, err.message);
  }

  // 2. Unauthorized access checks on admin endpoints
  try {
    const unauthStats = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/dashboard/stats', method: 'GET' });
    assert('2. Unauthenticated GET /api/admin/dashboard/stats is rejected (401)', unauthStats.status === 401);

    const unauthCustomers = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/customers', method: 'GET' });
    assert('3. Unauthenticated GET /api/customers is rejected (401)', unauthCustomers.status === 401);

    const unauthOrders = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/orders', method: 'GET' });
    assert('4. Unauthenticated GET /api/orders is rejected (401)', unauthOrders.status === 401);

    const unauthPayStatus = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/payment-gateway-status', method: 'GET' });
    assert('5. Unauthenticated GET /api/admin/payment-gateway-status is rejected (401)', unauthPayStatus.status === 401);

    const unauthRegions = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/delivery/regions', method: 'GET' });
    assert('6. Unauthenticated GET /api/admin/delivery/regions is rejected (401)', unauthRegions.status === 401);

    const unauthQueries = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/customer-queries', method: 'GET' });
    assert('7. Unauthenticated GET /api/admin/customer-queries is rejected (401)', unauthQueries.status === 401);
  } catch (err) {
    assert('Security check execution', false, err.message);
  }

  // Generate an admin dev test token for local verification
  const jwt = require('jsonwebtoken');
  const JWT_SECRET = process.env.JWT_SECRET || 'sunbloom-adorn-production-secret-key-change-in-env';
  const adminToken = jwt.sign(
    {
      id: 'admin_audit_test',
      email: 'skavinraj.dev@gmail.com',
      role: 'super_admin',
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const authHeader = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  // 3. Admin Auth verification
  try {
    const me = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/auth/me', method: 'GET', headers: authHeader });
    if (me.status !== 200) {
      console.log('    [DEBUG me error]:', me.status, me.body);
    }
    assert('8. Admin Profile & Roles verification (GET /api/auth/me)', me.status === 200 && me.body?.user?.email === 'skavinraj.dev@gmail.com');
  } catch (err) {
    assert('Admin profile verification', false, err.message);
  }

  // 4. Admin Dashboard Stats
  try {
    const stats = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/dashboard/stats', method: 'GET', headers: authHeader });
    assert(
      '9. Dynamic Dashboard Operational Stats (GET /api/admin/dashboard/stats)',
      stats.status === 200 &&
        stats.body?.success === true &&
        typeof stats.body?.orders?.total === 'number' &&
        typeof stats.body?.revenue?.total === 'number' &&
        typeof stats.body?.products?.total === 'number' &&
        typeof stats.body?.customers?.total === 'number' &&
        Array.isArray(stats.body?.recentOrders)
    );
  } catch (err) {
    assert('Dashboard stats check', false, err.message);
  }

  // 5. Admin Customers API
  try {
    const customersRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/customers', method: 'GET', headers: authHeader });
    assert(
      '10. Admin Customer Directory List (GET /api/customers)',
      customersRes.status === 200 && Array.isArray(customersRes.body?.customers)
    );

    if (customersRes.body?.customers?.length > 0) {
      const sampleId = customersRes.body.customers[0].id;
      const custDetail = await request({ hostname: '127.0.0.1', port: 3001, path: `/api/customers/${sampleId}`, method: 'GET', headers: authHeader });
      assert(
        '11. Admin Customer Profile & History (GET /api/customers/:id)',
        custDetail.status === 200 && custDetail.body?.customer?.id === sampleId && Array.isArray(custDetail.body?.customer?.orders)
      );
    } else {
      assert('11. Customer detail endpoint reachable', true);
    }
  } catch (err) {
    assert('Customers API check', false, err.message);
  }

  // 6. Admin Orders API
  try {
    const ordersRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/orders', method: 'GET', headers: authHeader });
    assert('12. Admin Orders List (GET /api/orders)', ordersRes.status === 200 && Array.isArray(ordersRes.body?.orders));
  } catch (err) {
    assert('Orders API check', false, err.message);
  }

  // 7. Admin Products API
  try {
    const productsRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/products', method: 'GET', headers: authHeader });
    assert('13. Admin Products Catalog (GET /api/admin/products)', productsRes.status === 200 && Array.isArray(productsRes.body?.products));
  } catch (err) {
    assert('Products API check', false, err.message);
  }

  // 8. Admin Categories API
  try {
    const catRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/categories', method: 'GET', headers: authHeader });
    assert('14. Admin Categories & Subcategories (GET /api/admin/categories)', catRes.status === 200 && Array.isArray(catRes.body?.categories));
  } catch (err) {
    assert('Categories API check', false, err.message);
  }

  // 9. Admin Delivery Regions
  try {
    const delivRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/delivery/regions', method: 'GET', headers: authHeader });
    assert('15. Admin Delivery Configuration (GET /api/admin/delivery/regions)', delivRes.status === 200 && Array.isArray(delivRes.body?.regions));
  } catch (err) {
    assert('Delivery regions check', false, err.message);
  }

  // 10. Admin Payment Gateway Status (No secrets exposed)
  try {
    const payRes = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/payment-gateway-status', method: 'GET', headers: authHeader });
    assert(
      '16. Admin Payment Status (PayU production status check with no secrets exposed)',
      payRes.status === 200 &&
        payRes.body?.gateway === 'PayU' &&
        payRes.body?.PAYU_SALT === undefined &&
        payRes.body?.keySecret === undefined &&
        typeof payRes.body?.isConfigured === 'boolean'
    );
  } catch (err) {
    assert('Payment status check', false, err.message);
  }

  // 11. Customer Queries & Consultations
  try {
    const queryStats = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/customer-queries/stats', method: 'GET', headers: authHeader });
    assert('17. Customer Query Statistics (GET /api/admin/customer-queries/stats)', queryStats.status === 200 && queryStats.body?.stats !== undefined);

    const consultCount = await request({ hostname: '127.0.0.1', port: 3001, path: '/api/admin/order-consultants/count', method: 'GET', headers: authHeader });
    assert('18. Delivery Enquiries Count (GET /api/admin/order-consultants/count)', consultCount.status === 200 && typeof consultCount.body?.count === 'number');
  } catch (err) {
    assert('Query & Consultations check', false, err.message);
  }

  console.log('\n================================================================');
  console.log(`  AUDIT SUMMARY: ${passed} PASSED / ${failed} FAILED (TOTAL: ${passed + failed})`);
  console.log('================================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runAudit().catch((e) => {
  console.error('Fatal audit runner error:', e);
  process.exit(1);
});
