process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('Applying safe schema alterations...');
    await client.query('ALTER TABLE "Variant" ADD COLUMN IF NOT EXISTS "variantNumber" TEXT;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "subtotal" DOUBLE PRECISION;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryCharge" DOUBLE PRECISION;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryAddress" TEXT;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "city" TEXT;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "state" TEXT;');
    await client.query('ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "pincode" TEXT;');
    await client.query('ALTER TABLE "DeliveryRegion" ADD COLUMN IF NOT EXISTS "regionName" TEXT;');
    await client.query('ALTER TABLE "DeliveryRegion" ALTER COLUMN "pincode" DROP NOT NULL;');
    await client.query('ALTER TABLE "DeliveryRegion" ALTER COLUMN "state" DROP NOT NULL;');
    await client.query('DROP INDEX IF EXISTS "DeliveryRegion_pincode_key";');

    console.log('Safe schema alterations applied successfully.');
  } catch (e) {
    console.error('Migration error:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
