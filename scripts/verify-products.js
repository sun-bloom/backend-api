const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
prisma.product.findMany({ select: { productNumber: true, name: true, basePrice: true }, orderBy: { productNumber: "asc" } })
  .then(ps => { ps.forEach(p => console.log("[" + p.productNumber + "] " + p.name + " Rs." + p.basePrice)); })
  .catch(e => console.error(e))
  .finally(async () => { await prisma.$disconnect(); await pool.end(); });
