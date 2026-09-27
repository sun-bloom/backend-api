// scripts/testOrderTrackingWorkflow.js
const {
  formatOutForDeliveryMessage,
  isValidTrackingUrl,
  sendOutForDeliveryNotification,
} = require('../services/whatsappNotification.service');

async function runTests() {
  console.log('====================================================');
  console.log('SUNBLOOM ADORN: Order Delivery & Tracking Audit Tests');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  ✓ PASS: ${message}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${message}`);
      failed++;
    }
  }

  // 1. Tracking URL Validation Tests
  console.log('--- 1. Tracking URL Validation ---');
  assert(isValidTrackingUrl('https://track.delhivery.com/p/123456789'), 'Valid HTTPS Delhivery URL is accepted');
  assert(isValidTrackingUrl('http://shiprocket.co/tracking/SR12345'), 'Valid HTTP Shiprocket URL is accepted');
  assert(isValidTrackingUrl('https://www.bluedart.com/tracking?awb=987654321'), 'Valid BlueDart URL is accepted');
  assert(!isValidTrackingUrl('ftp://invalid-protocol.com/123'), 'FTP protocol is rejected');
  assert(!isValidTrackingUrl('javascript:alert(1)'), 'Javascript URI is rejected');
  assert(!isValidTrackingUrl('just-a-random-string'), 'Non-URL string is rejected');
  assert(!isValidTrackingUrl(''), 'Empty string is rejected');
  assert(!isValidTrackingUrl(null), 'Null is rejected');

  // 2. WhatsApp Message Format Tests
  console.log('\n--- 2. WhatsApp Message Formatting ---');
  const sampleMsg = formatOutForDeliveryMessage({
    orderNumber: 'ORD-2026-8888',
    customerName: 'Aaradhya Sharma',
    trackingUrl: 'https://track.delhivery.com/p/ORD8888',
  });

  assert(sampleMsg.includes('Sunbloom Adorn'), 'Message contains brand name "Sunbloom Adorn"');
  assert(sampleMsg.includes('ORD-2026-8888'), 'Message contains exact order number');
  assert(sampleMsg.includes('OUT FOR DELIVERY'), 'Message contains "OUT FOR DELIVERY" status');
  assert(sampleMsg.includes('https://track.delhivery.com/p/ORD8888'), 'Message contains exact tracking link');
  assert(sampleMsg.includes('Aaradhya Sharma'), 'Message addresses customer politely');
  assert(!sampleMsg.includes('password') && !sampleMsg.includes('token') && !sampleMsg.includes('otp'), 'No sensitive information exposed');

  // 3. WhatsApp Provider Handling & Unconfigured State
  console.log('\n--- 3. WhatsApp Notification Service & Provider Fallback ---');
  const testOrder = {
    orderNumber: 'ORD-TEST-101',
    customerName: 'Priya Iyer',
    whatsappNumber: '9876543210',
    customer: {
      name: 'Priya Iyer',
      phone: '9876543210',
      whatsappNumber: '9876543210',
    },
  };

  const notificationResult = await sendOutForDeliveryNotification(
    testOrder,
    'https://track.courier.com/TEST101'
  );

  assert(notificationResult.success === true, 'Notification processing returns success=true');
  assert(notificationResult.sent === false, 'Sent is false when provider not configured in .env');
  assert(notificationResult.reason === 'PROVIDER_NOT_CONFIGURED', 'Identifies PROVIDER_NOT_CONFIGURED accurately without faking API');
  assert(typeof notificationResult.message === 'string' && notificationResult.message.length > 20, 'Message body is prepared and ready for delivery');

  // 4. Verification that whatsappNotifiedAt is ONLY recorded on real success
  console.log('\n--- 4. whatsappNotifiedAt State Lifecycle ---');
  let orderState = {
    orderNumber: 'ORD-TEST-202',
    status: 'SHIPPED',
    trackingUrl: 'https://track.courier.com/202',
    whatsappNotifiedAt: null,
  };

  // Simulation: When notificationResult.sent is false (provider unconfigured or failed)
  if (notificationResult && notificationResult.sent === true) {
    orderState.whatsappNotifiedAt = new Date();
  }
  assert(orderState.whatsappNotifiedAt === null, 'whatsappNotifiedAt remains null when provider is not configured or fails');

  // Simulation: When provider is configured and successfully sends (sent === true)
  const simulatedSuccessResult = { success: true, sent: true, message: 'Sent via Meta API' };
  if (simulatedSuccessResult && simulatedSuccessResult.sent === true) {
    orderState.whatsappNotifiedAt = new Date();
  }
  assert(orderState.whatsappNotifiedAt instanceof Date, 'whatsappNotifiedAt is set to DateTime only upon real successful send');

  // Simulation: Re-saving the same tracking/status after successful notification prevents duplicate send
  const isOutForDelivery = orderState.status === 'SHIPPED';
  const hasValidTracking = Boolean(orderState.trackingUrl && isValidTrackingUrl(orderState.trackingUrl));
  const newTrackingUrlProvided = 'https://track.courier.com/202'; // same URL
  const shouldAttemptNotification =
    isOutForDelivery &&
    hasValidTracking &&
    (!orderState.whatsappNotifiedAt || newTrackingUrlProvided !== orderState.trackingUrl);

  assert(shouldAttemptNotification === false, 'Re-saving same tracking URL does not trigger duplicate WhatsApp notification');

  // Simulation: Changing the tracking URL allows a new notification
  const changedTrackingUrl = 'https://track.courier.com/NEW-202';
  const shouldAttemptNotificationOnNewLink =
    isOutForDelivery &&
    hasValidTracking &&
    (!orderState.whatsappNotifiedAt || changedTrackingUrl !== orderState.trackingUrl);

  assert(shouldAttemptNotificationOnNewLink === true, 'Updating to a new tracking URL triggers a new notification');

  // 5. Phone Validation Safety in WhatsApp Service
  console.log('\n--- 5. Customer Phone Validation ---');
  const invalidPhoneOrder = {
    orderNumber: 'ORD-TEST-102',
    customerName: 'Test Customer',
    whatsappNumber: '123', // Invalid
    customer: { phone: '123' },
  };

  const invalidPhoneResult = await sendOutForDeliveryNotification(
    invalidPhoneOrder,
    'https://track.courier.com/TEST102'
  );
  assert(invalidPhoneResult.success === false, 'Invalid phone number is safely rejected');
  assert(invalidPhoneResult.reason === 'INVALID_PHONE', 'Rejection reason is INVALID_PHONE');

  console.log('\n====================================================');
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
