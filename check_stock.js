require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.replace(/\?.*$/, ''),
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  // Reset stock to 999 for all variants that are available but have stock <= 0
  // This handles cases where stock was accidentally decremented to 0
  const result = await prisma.variant.updateMany({
    where: {
      isAvailable: true,
      stock: { lte: 0 }
    },
    data: { stock: 999 }
  });
  console.log(`✅ Reset stock to 999 for ${result.count} variant(s) that were available but had stock <= 0`);

  // Show current state
  const all = await prisma.variant.findMany({
    select: { id: true, stock: true, isAvailable: true, color: true, product: { select: { name: true } } }
  });
  console.log('\n=== All variants now ===');
  all.forEach(v => {
    const status = v.isAvailable && v.stock > 0 ? '✅' : '⚠️';
    console.log(`  ${status} [${v.id}] "${v.product?.name}" | ${v.color} | stock: ${v.stock} | available: ${v.isAvailable}`);
  });

  await prisma.$disconnect();
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
