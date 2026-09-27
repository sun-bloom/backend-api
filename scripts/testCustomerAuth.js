// scripts/testCustomerAuth.js
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  try {
    const count = await prisma.customer.count();
    console.log('Customer count in DB:', count);
    const sample = await prisma.customer.findFirst();
    console.log('Sample customer:', sample);
  } catch (err) {
    console.error('Database connection error:', err.message);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
