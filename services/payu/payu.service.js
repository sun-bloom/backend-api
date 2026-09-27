const crypto = require('crypto');

const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;
const PAYU_ENV = process.env.PAYU_ENV || 'production';
const PAYU_PAYMENT_URL = process.env.PAYU_PAYMENT_URL || 'https://secure.payu.in/_payment';
const PAYU_VERIFY_URL = process.env.PAYU_VERIFY_URL || 'https://info.payu.in/merchant/postservice.php?form=2';

function generatePaymentHash(payload) {
  const { txnid, amount, productinfo, firstname, email, udf1 = '', udf2 = '', udf3 = '', udf4 = '', udf5 = '' } = payload;
  // key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
  const hashString = `${PAYU_KEY}|${txnid}|${amount}|${productinfo}|${firstname}|${email}|${udf1}|${udf2}|${udf3}|${udf4}|${udf5}||||||${PAYU_SALT}`;
  return crypto.createHash('sha512').update(hashString).digest('hex');
}

function generateReverseHash(response) {
  const { status, udf5 = '', udf4 = '', udf3 = '', udf2 = '', udf1 = '', email, firstname, productinfo, amount, txnid, additionalCharges } = response;
  
  // If PayU returns additionalCharges, it changes the reverse hash sequence:
  // additionalCharges|SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
  let hashString = '';
  if (additionalCharges) {
    hashString = `${additionalCharges}|${PAYU_SALT}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${PAYU_KEY}`;
  } else {
    hashString = `${PAYU_SALT}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${PAYU_KEY}`;
  }
  return crypto.createHash('sha512').update(hashString).digest('hex');
}

function generateVerifyHash(txnid) {
  // key|verify_payment|txnid|SALT
  const hashString = `${PAYU_KEY}|verify_payment|${txnid}|${PAYU_SALT}`;
  return crypto.createHash('sha512').update(hashString).digest('hex');
}

async function verifyPayUTransaction(txnid) {
  const hash = generateVerifyHash(txnid);
  const params = new URLSearchParams();
  params.append('key', PAYU_KEY);
  params.append('command', 'verify_payment');
  params.append('var1', txnid);
  params.append('hash', hash);

  try {
    const response = await fetch(PAYU_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('[PayU Service] verifyPayUTransaction error:', error);
    return { status: 0, msg: error.message };
  }
}

module.exports = {
  PAYU_KEY,
  PAYU_SALT,
  PAYU_ENV,
  PAYU_PAYMENT_URL,
  PAYU_VERIFY_URL,
  generatePaymentHash,
  generateReverseHash,
  generateVerifyHash,
  verifyPayUTransaction
};
