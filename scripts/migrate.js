const { PrismaClient } = require('@prisma/client');
const { PrismaNeon } = require('@prisma/adapter-neon');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const connectionString = process.env.DIRECT_URL;
const adapter = new PrismaNeon({ connectionString });
const prisma = new PrismaClient({ adapter });

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

async function migrateData() {
  console.log('Starting migration...\n');

  try {
    console.log('Migrating categories...');
    const categoriesData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'products.json'), 'utf8'));
    const categoriesMap = new Map();
    
    const uniqueCategories = [...new Set(categoriesData.products.map(p => p.category))];
    
    for (const categorySlug of uniqueCategories) {
      const category = await prisma.category.upsert({
        where: { slug: categorySlug },
        update: {},
        create: {
          name: categorySlug.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          slug: categorySlug,
          description: `${categorySlug} category`,
          image: 'https://placehold.co/600x400/gray/white/png?text=Category'
        }
      });
      categoriesMap.set(categorySlug, category.id);
      console.log(`  Created/Updated category: ${category.name}`);
    }

    console.log('\nMigrating products...');
    for (const productData of categoriesData.products) {
      const product = await prisma.product.upsert({
        where: { slug: productData.slug },
        update: {},
        create: {
          name: productData.name,
          slug: productData.slug,
          description: productData.description,
          basePrice: productData.basePrice,
          images: productData.images,
          isActive: productData.isActive,
          categoryId: categoriesMap.get(productData.category),
          createdAt: new Date(productData.createdAt),
          updatedAt: new Date(productData.updatedAt),
          variants: {
            create: productData.variants.map(variant => ({
              color: variant.color,
              pattern: variant.pattern,
              stock: variant.stock,
              additionalPrice: variant.additionalPrice,
              sku: variant.sku,
              isAvailable: variant.isAvailable,
              createdAt: new Date(),
              updatedAt: new Date()
            }))
          }
        }
      });
      console.log(`  Created/Updated product: ${product.name} with ${productData.variants.length} variants`);
    }

    console.log('\nMigrating admin users...');
    const adminData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'admin-users.json'), 'utf8'));

    for (const userData of adminData.users) {
      const hashedPassword = await bcrypt.hash(userData.passwordHash, 10);
      const user = await prisma.adminUser.upsert({
        where: { email: userData.email },
        update: {},
        create: {
          username: userData.username,
          email: userData.email,
          passwordHash: hashedPassword,
          role: userData.role,
          isActive: userData.isActive,
          lastLogin: userData.lastLogin ? new Date(userData.lastLogin) : null,
          createdAt: new Date(userData.createdAt)
        }
      });
      console.log(`  Created/Updated admin user: ${user.username}`);
    }

    console.log('\nMigrating settings...');
    const settingsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    
    const existingSettings = await prisma.settings.findFirst();
    if (!existingSettings) {
      await prisma.settings.create({
        data: {
          storeName: settingsData.storeName || 'My Store',
          upiId: settingsData.upiId || '',
          upiName: settingsData.upiName || '',
          currency: settingsData.currency || 'INR'
        }
      });
      console.log('  Created settings');
    } else {
      console.log('  Settings already exist, skipping');
    }

    console.log('\nMigrating delivery settings...');
    const deliveryData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'delivery-settings.json'), 'utf8'));
    
    const existingDeliverySettings = await prisma.deliverySettings.findFirst();
    if (!existingDeliverySettings) {
      const deliverySettings = await prisma.deliverySettings.create({
        data: {
          freeShippingThreshold: deliveryData.freeShippingThreshold || 999,
          defaultShippingCharge: deliveryData.defaultShippingCharge || 50,
          regions: {
            create: (deliveryData.regions || []).map(region => ({
              pincode: region.pincodeStart || '000000',
              city: region.regionName?.split(' ')[0] || 'Unknown',
              state: region.regionName || 'Unknown',
              shippingCharge: region.deliveryCharge || 50,
              isActive: region.isEnabled ?? true
            }))
          }
        }
      });
      console.log(`  Created delivery settings with ${deliveryData.regions?.length || 0} regions`);
    } else {
      console.log('  Delivery settings already exist, skipping');
    }

    console.log('\n✅ Migration completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

migrateData();
