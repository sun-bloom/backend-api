const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');
const { neon } = require('@neondatabase/serverless');
require('dotenv').config();

const connectionString = process.env.DIRECT_URL;
const adminEmail = (process.env.ADMIN_EMAIL || 'admin@example.com').trim();
const adminUsername = (process.env.ADMIN_USERNAME || 'Admin').trim();
const adminRole = (process.env.ADMIN_ROLE || 'super_admin').trim();
const adminPassword = process.env.ADMIN_PASSWORD;

if (!connectionString) {
  console.error('ERROR: DIRECT_URL environment variable is required');
  process.exit(1);
}

if (!adminPassword) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required');
  process.exit(1);
}

const adapter = new PrismaNeon({ connectionString });
const prisma = new PrismaClient({ adapter });
const bcrypt = require('bcryptjs');

async function main() {
  console.log('Creating admin user...');

  const hashedPassword = await bcrypt.hash(adminPassword, 10);

  const admin = await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      username: adminUsername,
      email: adminEmail,
      passwordHash: hashedPassword,
      role: adminRole,
      isActive: true,
    },
  });

  console.log('Admin user created:', admin.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
