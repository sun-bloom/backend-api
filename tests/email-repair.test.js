const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const backendFlags = read('config/testFlags.js');
const customerFlags = fs.readFileSync(
  path.resolve(root, '..', 'customer-web', 'src/config/testFlags.ts'),
  'utf8'
);
const paymentsRoutes = read('routes/payments.routes.js');
const server = read('server.js');
const emailService = read('services/emailNotification.service.js');

assert.match(backendFlags, /:\s*true;\s*$/m, 'backend minimum flag defaults to true');
assert.match(customerFlags, /ENFORCE_MIN_PAYMENT_LIMIT\s*=\s*true;/, 'customer minimum flag is true');

for (const amount of [199, 200, 201]) {
  assert.equal(amount >= 200, amount !== 199, `₹${amount} minimum-order boundary`);
}

assert.match(paymentsRoutes, /paymentStatus:\s*\{\s*not:\s*'PAID'/, 'payment confirmation is conditionally atomic');
assert.match(paymentsRoutes, /const newlyConfirmed = await confirmVerifiedPayment/, 'success callback uses authoritative payment confirmation');
assert.match(paymentsRoutes, /sendConfirmedOrderEmail\(prisma, order\.id\)/, 'success and webhook paths dispatch the order email');
assert.equal((paymentsRoutes.match(/sendConfirmedOrderEmail\(prisma, order\.id\)/g) || []).length, 2, 'both verified PayU paths dispatch once per transition');

assert.match(server, /const statusChanged = newStatus !== existingOrder\.status;/, 'delivery email requires a status transition');
assert.match(server, /await sendOrderStatusEmail\(/, 'delivery email is awaited after persistence');
assert.match(server, /requestedStatusNormalized === 'OUT_FOR_DELIVERY'/, 'out-for-delivery notification keeps its customer-facing status');
assert.match(server, /notifyCustomersOfNewProduct\(product\)\.catch/, 'new-product email is create-triggered');
const productCreateIndex = server.indexOf("app.post('/api/products'");
const productUpdateIndex = server.indexOf("app.put('/api/products/:id'");
const productNotificationIndex = server.indexOf('notifyCustomersOfNewProduct(product)', productCreateIndex);
assert(productNotificationIndex > productCreateIndex && productNotificationIndex < productUpdateIndex, 'product notification is not wired to product updates');

assert.match(emailService, /EMAIL_SEND_FAILED/, 'email failures use a structured diagnostic');
assert.match(emailService, /INVALID_OR_MISSING_RECIPIENT/, 'missing recipients are handled safely');
assert.match(emailService, /sendNewProductAnnouncementEmail/, 'new-product template sender exists');
assert.match(emailService, /SITE_URL}\/products\//, 'new-product email uses the product detail route');

console.log('email-repair.test.js: all no-network regression checks passed');
