process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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

async function seedDelivery() {
  try {
    let settings = await prisma.deliverySettings.findFirst({
      include: { regions: true },
    });

    if (!settings) {
      settings = await prisma.deliverySettings.create({
        data: {
          freeShippingThreshold: 9999,
          defaultShippingCharge: 100,
          regions: {
            create: [
              { regionName: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', shippingCharge: 100, isActive: true },
              { regionName: 'Tirupur', city: 'Tirupur', state: 'Tamil Nadu', shippingCharge: 200, isActive: true },
              { regionName: 'Coimbatore', city: 'Coimbatore', state: 'Tamil Nadu', shippingCharge: 20, isActive: true },
            ],
          },
        },
        include: { regions: true },
      });
      console.log('Created DeliverySettings with initial regions:', settings.regions.map(r => `${r.regionName} -> ₹${r.shippingCharge}`));
    } else if (settings.regions.length === 0) {
      await prisma.deliveryRegion.createMany({
        data: [
          { deliverySettingsId: settings.id, regionName: 'Chennai', city: 'Chennai', state: 'Tamil Nadu', shippingCharge: 100, isActive: true },
          { deliverySettingsId: settings.id, regionName: 'Tirupur', city: 'Tirupur', state: 'Tamil Nadu', shippingCharge: 200, isActive: true },
          { deliverySettingsId: settings.id, regionName: 'Coimbatore', city: 'Coimbatore', state: 'Tamil Nadu', shippingCharge: 20, isActive: true },
        ],
      });
      console.log('Added initial regions to existing DeliverySettings.');
    } else {
      console.log('Delivery regions already configured:', settings.regions.length);
    }
  } catch (e) {
    console.error('Delivery seed error:', e);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

seedDelivery();
