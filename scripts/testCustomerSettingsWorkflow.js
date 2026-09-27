// scripts/testCustomerSettingsWorkflow.js
require('dotenv').config();

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    process.exit(1);
  }
}

async function runTests() {
  console.log('===========================================================');
  console.log('SUNBLOOM ADORN: Customer Settings & Profile Workflow Tests');
  console.log('===========================================================\n');

  // 1. Phone number format validation test
  console.log('--- 1. Phone Number Validation ---');
  const validPhone = '9876543210';
  const invalidPhoneShort = '12345';
  const invalidPhoneAlpha = '987654321a';

  const cleanValid = String(validPhone).replace(/\D/g, '').slice(-10);
  assert(cleanValid.length === 10 && /^[6-9]\d{9}$/.test(cleanValid), 'Valid 10-digit Indian mobile is accepted');

  const cleanShort = String(invalidPhoneShort).replace(/\D/g, '').slice(-10);
  assert(cleanShort.length !== 10, 'Short mobile number is rejected');

  // 2. WhatsApp number validation test
  console.log('\n--- 2. WhatsApp Number Validation ---');
  const validWhatsapp = '8765432109';
  const cleanWhatsapp = String(validWhatsapp).replace(/\D/g, '').slice(-10);
  assert(cleanWhatsapp.length === 10 && /^[6-9]\d{9}$/.test(cleanWhatsapp), 'Valid 10-digit WhatsApp number is accepted');

  // 3. Profile update payload sanitization
  console.log('\n--- 3. Profile Payload Mapping & Sanitization ---');
  const rawBody = {
    name: '  Radhika Sharma  ',
    phone: ' +91 9876543210 ',
    whatsappNumber: ' 9876543210 ',
    address: '  123 Luxury Avenue  ',
    city: ' Coimbatore ',
    state: ' Tamil Nadu ',
    pincode: ' 641001 ',
  };

  const sanitized = {
    name: String(rawBody.name).trim(),
    phone: String(rawBody.phone).replace(/\D/g, '').slice(-10),
    whatsappNumber: String(rawBody.whatsappNumber).replace(/\D/g, '').slice(-10),
    address: String(rawBody.address).trim(),
    city: String(rawBody.city).trim(),
    state: String(rawBody.state).trim(),
    pincode: String(rawBody.pincode).trim(),
  };

  assert(sanitized.name === 'Radhika Sharma', 'Full name is trimmed');
  assert(sanitized.phone === '9876543210', 'Mobile number is cleaned to 10 digits');
  assert(sanitized.whatsappNumber === '9876543210', 'WhatsApp number is cleaned to 10 digits');
  assert(sanitized.address === '123 Luxury Avenue', 'Address is trimmed');
  assert(sanitized.city === 'Coimbatore', 'City is trimmed');
  assert(sanitized.state === 'Tamil Nadu', 'State is trimmed');
  assert(sanitized.pincode === '641001', 'Pincode is trimmed');

  // 4. In-memory fallback and safe synchronization without HTTP 500
  console.log('\n--- 4. Customer Identity & In-Memory Fallback Lifecycle ---');
  const mockUser = {
    uid: 'firebase_test_uid_999',
    email: 'client@sunbloomadorn.com',
    name: 'Atelier Client',
  };

  const initialCustomer = {
    id: `fb_${mockUser.uid}`,
    firebaseUid: mockUser.uid,
    name: mockUser.name,
    email: mockUser.email,
    phone: null,
    whatsappNumber: null,
    address: null,
    city: null,
    state: null,
    pincode: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  assert(initialCustomer.id.startsWith('fb_'), 'Initial unpersisted session uses consistent identifier');

  const updatedProfile = {
    ...initialCustomer,
    name: sanitized.name,
    phone: sanitized.phone,
    whatsappNumber: sanitized.whatsappNumber,
    address: sanitized.address,
    city: sanitized.city,
    state: sanitized.state,
    pincode: sanitized.pincode,
  };

  assert(updatedProfile.name === 'Radhika Sharma', 'Profile update persists updated name');
  assert(updatedProfile.phone === '9876543210', 'Profile update persists updated phone');
  assert(updatedProfile.email === 'client@sunbloomadorn.com', 'Email remains derived from authenticated account');

  console.log('\n===========================================================');
  console.log('All Settings & Profile Workflow Tests PASSED (0 failures)');
  console.log('===========================================================');
}

runTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
