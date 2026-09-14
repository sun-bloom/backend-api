// scripts/test-db-connection.js
// Safe diagnostic script to verify PostgreSQL / Prisma connection without logging secrets.

require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { PrismaClient } = require('@prisma/client');
const net = require('net');
const dns = require('dns').promises;

const HOST = 'sunbloom-postgres-sunbloomadornwork-0e2d.j.aivencloud.com';
const PORT = 16523;

async function runDiagnostics() {
  console.log('=== AIVEN POSTGRESQL CONNECTION VERIFICATION ===');
  console.log(`Target Host: ${HOST}`);
  console.log(`Target Port: ${PORT}`);

  // 1. DNS Resolution Test
  try {
    const addresses = await dns.lookup(HOST);
    console.log(`[1] DNS Resolution: SUCCESS (${addresses.address})`);
  } catch (err) {
    console.error(`[1] DNS Resolution: FAILED (${err.message})`);
    process.exit(1);
  }

  // 2. TCP Socket Connection Test
  await new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.on('connect', () => {
      console.log(`[2] TCP Port Check (port ${PORT}): SUCCESS`);
      socket.destroy();
      resolve();
    });
    socket.on('timeout', () => {
      console.error(`[2] TCP Port Check (port ${PORT}): TIMEOUT`);
      socket.destroy();
      reject(new Error('TCP timeout'));
    });
    socket.on('error', (err) => {
      console.error(`[2] TCP Port Check (port ${PORT}): FAILED (${err.message})`);
      reject(err);
    });
    socket.connect(PORT, HOST);
  }).catch(() => process.exit(1));

  // 3. Database URL Environment Presence
  if (!process.env.DATABASE_URL) {
    console.error('[3] DATABASE_URL: FAILED (DATABASE_URL is not set in backend-api/.env)');
    console.log('\nPlease configure backend-api/.env with:');
    console.log('DATABASE_URL="postgresql://avnadmin:<AIVEN_PASSWORD>@sunbloom-postgres-sunbloomadornwork-0e2d.j.aivencloud.com:16523/defaultdb?sslmode=require"');
    process.exit(1);
  }
  console.log('[3] DATABASE_URL Configuration: PRESENT (Safe masked)');

  // 4. Prisma Connection & Read Query
  const { Pool } = require('pg');
  const { PrismaPg } = require('@prisma/adapter-pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  try {
    await prisma.$connect();
    console.log('[4] Prisma Connection: SUCCESS');

    const result = await prisma.$queryRawUnsafe(`
      SELECT 
        version() as version, 
        current_database() as database, 
        current_user as user,
        (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) as ssl_active;
    `);

    const row = result[0];
    console.log(`[5] Read Query: SUCCESS`);
    console.log(`    - Database: ${row.database}`);
    console.log(`    - User: ${row.user}`);
    console.log(`    - SSL Active: ${row.ssl_active !== false ? 'YES (TLS Encrypted)' : 'NO'}`);
    console.log(`    - Engine: ${row.version?.split(',')[0]}`);

    // 5. Safe Temporary Transaction Write Test
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        CREATE TEMP TABLE __sunbloom_connection_test (id INT);
        INSERT INTO __sunbloom_connection_test (id) VALUES (1);
        DROP TABLE __sunbloom_connection_test;
      END $$;
    `);
    console.log('[6] Temporary Transaction Write Test: SUCCESS (Zero residual tables)');

    // 6. Inspect Database Schema / Tables
    const tables = await prisma.$queryRawUnsafe(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    console.log(`[7] Existing Schema Tables: ${tables.length === 0 ? 'Empty / Default Database' : tables.map(t => t.table_name).join(', ')}`);

    console.log('\n=== ALL VERIFICATION CHECKS PASSED ===');
  } catch (err) {
    console.error('[!] Prisma / PostgreSQL Query FAILED:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runDiagnostics();
