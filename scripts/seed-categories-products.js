const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const IMG = {
  ring:      "https://images.unsplash.com/photo-1605100804763-247f67b3557e?auto=format&fit=crop&q=80&w=800",
  ring2:     "https://images.unsplash.com/photo-1603561591411-07134e71a2a9?auto=format&fit=crop&q=80&w=800",
  ring3:     "https://images.unsplash.com/photo-1611591437281-460bfbe1220a?auto=format&fit=crop&q=80&w=800",
  necklace:  "https://images.unsplash.com/photo-1599643477877-530eb83abc8e?auto=format&fit=crop&q=80&w=800",
  necklace2: "https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?auto=format&fit=crop&q=80&w=800",
  necklace3: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&q=80&w=800",
  bracelet:  "https://images.unsplash.com/photo-1573408301185-9519f94ef0ff?auto=format&fit=crop&q=80&w=800",
  bracelet2: "https://images.unsplash.com/photo-1610694955371-d4a3e0ce4b52?auto=format&fit=crop&q=80&w=800",
  bracelet3: "https://images.unsplash.com/photo-1561802815-5b91a4e06c50?auto=format&fit=crop&q=80&w=800",
  earrings:  "https://images.unsplash.com/photo-1629224316810-9d8805b95e76?auto=format&fit=crop&q=80&w=800",
  earrings2: "https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&q=80&w=800",
  earrings3: "https://images.unsplash.com/photo-1560343776-97e7d202ff0e?auto=format&fit=crop&q=80&w=800",
  pendant:   "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&q=80&w=800",
  pendant2:  "https://images.unsplash.com/photo-1506630448388-4e683c67ddb0?auto=format&fit=crop&q=80&w=800",
  pendant3:  "https://images.unsplash.com/photo-1515562141207-7a88fb7ce338?auto=format&fit=crop&q=80&w=800",
};

const CATEGORIES = [
  { catNum: 101, slug: "ring",     name: "Rings",     description: "Elegant Korean minimalist rings crafted for everyday luxury and timeless styling.",               image: IMG.ring     },
  { catNum: 102, slug: "necklace", name: "Necklaces", description: "Refined necklaces designed with delicate silhouettes and radiant golden detailing.",              image: IMG.necklace },
  { catNum: 103, slug: "bracelet", name: "Bracelets", description: "Minimalist bracelets designed for effortless everyday elegance.",                                 image: IMG.bracelet },
  { catNum: 104, slug: "earrings", name: "Earrings",  description: "Elegant earrings combining clean Korean-inspired forms with timeless jewellery styling.",          image: IMG.earrings },
  { catNum: 105, slug: "pendant",  name: "Pendants",  description: "Statement and minimalist pendants designed around refined geometric forms.",                       image: IMG.pendant  },
];

const PRODUCTS = [
  { pn:"101-01", catSlug:"ring",     name:"Aurora Minimal Ring",         slug:"aurora-minimal-ring",         price:899,  desc:"A refined minimalist ring with a polished golden finish, designed for effortless everyday elegance.",                          img:IMG.ring,     vColor:"Gold",       vPattern:"Solid",     vSku:"101-01-GOLD" },
  { pn:"101-02", catSlug:"ring",     name:"Luna Crystal Ring",           slug:"luna-crystal-ring",           price:1299, desc:"A delicate crystal-accented ring inspired by soft moonlight and Korean minimalist jewellery design.",                         img:IMG.ring2,    vColor:"Silver",     vPattern:"Crystal",   vSku:"101-02-SLV"  },
  { pn:"101-03", catSlug:"ring",     name:"Eclipse Signature Ring",      slug:"eclipse-signature-ring",      price:1799, desc:"A sophisticated statement ring with a clean silhouette and radiant golden finish.",                                           img:IMG.ring3,    vColor:"Gold",       vPattern:"Polished",  vSku:"101-03-GOLD" },
  { pn:"102-01", catSlug:"necklace", name:"Solara Fine Necklace",        slug:"solara-fine-necklace",        price:1599, desc:"A delicate golden necklace inspired by the warmth and brilliance of sunlight.",                                              img:IMG.necklace, vColor:"Gold",       vPattern:"Solid",     vSku:"102-01-GOLD" },
  { pn:"102-02", catSlug:"necklace", name:"Celeste Layer Necklace",      slug:"celeste-layer-necklace",      price:2199, desc:"A refined layered necklace designed for modern minimalist styling.",                                                          img:IMG.necklace2,vColor:"Gold",       vPattern:"Layered",   vSku:"102-02-GOLD" },
  { pn:"102-03", catSlug:"necklace", name:"Noir Pearl Necklace",         slug:"noir-pearl-necklace",         price:2699, desc:"An elegant necklace combining a dark accent with a refined golden chain.",                                                   img:IMG.necklace3,vColor:"Black Pearl", vPattern:"Classic",   vSku:"102-03-BLK"  },
  { pn:"103-01", catSlug:"bracelet", name:"Serene Gold Bracelet",        slug:"serene-gold-bracelet",        price:999,  desc:"A lightweight minimalist bracelet with a polished golden finish.",                                                            img:IMG.bracelet, vColor:"Gold",       vPattern:"Solid",     vSku:"103-01-GOLD" },
  { pn:"103-02", catSlug:"bracelet", name:"Halo Chain Bracelet",         slug:"halo-chain-bracelet",         price:1499, desc:"A delicate chain bracelet designed for subtle everyday luxury.",                                                              img:IMG.bracelet2,vColor:"Gold",       vPattern:"Chain",     vSku:"103-02-GOLD" },
  { pn:"103-03", catSlug:"bracelet", name:"Radiance Link Bracelet",      slug:"radiance-link-bracelet",      price:1999, desc:"A refined link bracelet with a modern silhouette and radiant finish.",                                                        img:IMG.bracelet3,vColor:"Gold",       vPattern:"Link",      vSku:"103-03-GOLD" },
  { pn:"104-01", catSlug:"earrings", name:"Dewdrop Stud Earrings",       slug:"dewdrop-stud-earrings",       price:799,  desc:"Minimalist stud earrings inspired by the soft form of morning dew.",                                                         img:IMG.earrings, vColor:"Gold",       vPattern:"Stud",      vSku:"104-01-GOLD" },
  { pn:"104-02", catSlug:"earrings", name:"Solstice Hoop Earrings",      slug:"solstice-hoop-earrings",      price:1299, desc:"Clean circular hoops designed for versatile everyday styling.",                                                               img:IMG.earrings2,vColor:"Gold",       vPattern:"Hoop",      vSku:"104-02-GOLD" },
  { pn:"104-03", catSlug:"earrings", name:"Aurora Drop Earrings",        slug:"aurora-drop-earrings",        price:1899, desc:"Elegant drop earrings featuring a graceful silhouette and luminous golden finish.",                                           img:IMG.earrings3,vColor:"Gold",       vPattern:"Drop",      vSku:"104-03-GOLD" },
  { pn:"105-01", catSlug:"pendant",  name:"Sunbloom Medallion Pendant",  slug:"sunbloom-medallion-pendant",  price:2499, desc:"A signature Sunbloom pendant inspired by radiant sunlight and refined geometric forms.",                                      img:IMG.pendant,  vColor:"Gold",       vPattern:"Medallion", vSku:"105-01-GOLD" },
  { pn:"105-02", catSlug:"pendant",  name:"Azure Crystal Pendant",       slug:"azure-crystal-pendant",       price:2999, desc:"A distinctive crystal pendant combining deep blue tones with a warm golden setting.",                                          img:IMG.pendant2, vColor:"Blue Gold",  vPattern:"Crystal",   vSku:"105-02-BLUE" },
  { pn:"105-03", catSlug:"pendant",  name:"Golden Orbit Pendant",        slug:"golden-orbit-pendant",        price:3499, desc:"A sophisticated geometric pendant inspired by celestial forms and modern Korean minimalism.",                                   img:IMG.pendant3, vColor:"Gold",       vPattern:"Geometric", vSku:"105-03-GOLD" },
];

function validPN(pn) { return /^\d{3}-\d{2}$/.test(pn); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("\n=== Sunbloom Adorn Seed Script ===\n");

  // Validate
  const allPNs = PRODUCTS.map(p => p.pn);
  if (allPNs.some(pn => !validPN(pn))) throw new Error("Invalid PN format found");
  if (new Set(allPNs).size !== allPNs.length) throw new Error("Duplicate PNs");
  console.log("[1/5] Product Number validation: PASS (" + allPNs.length + " numbers, format ###-##)\n");

  // Categories
  console.log("[2/5] Categories...");
  const catMap = {};
  for (const c of CATEGORIES) {
    const ex = await prisma.category.findFirst({ where: { slug: c.slug } });
    if (ex) {
      const up = await prisma.category.update({ where: { id: ex.id }, data: {
        name: c.name, categoryNumber: String(c.catNum), description: c.description,
        image: ex.image.includes("cloudinary.com") ? ex.image : c.image,
      }});
      catMap[c.slug] = up.id;
      console.log("  [" + c.catNum + "] UPDATED: " + c.name + " (slug:" + c.slug + ")");
    } else {
      const cr = await prisma.category.create({ data: { name: c.name, slug: c.slug, categoryNumber: String(c.catNum), description: c.description, image: c.image } });
      catMap[c.slug] = cr.id;
      console.log("  [" + c.catNum + "] CREATED: " + c.name + " (slug:" + c.slug + ")");
    }
    await sleep(50);
  }
  console.log("  => 5 categories ready\n");

  // Handle existing Medallion Pendant
  console.log("[3/5] Existing Sunbloom Medallion Pendant...");
  const exMed = await prisma.product.findFirst({ where: { slug: "sunbloom-medallion-pendant" }, include: { variants: true } });
  if (exMed) {
    console.log("  Found: id=" + exMed.id + " pn=" + (exMed.productNumber||"null") + " catId=" + exMed.categoryId);
    await prisma.product.update({ where: { id: exMed.id }, data: {
      productNumber: "105-01", categoryId: catMap["pendant"],
      description: "A signature Sunbloom pendant inspired by radiant sunlight and refined geometric forms.",
      basePrice: 2499, isActive: true, images: [IMG.pendant],
    }});
    // Update existing variant SKU to match new scheme if it has an old SKU
    if (exMed.variants.length > 0) {
      const oldV = exMed.variants[0];
      if (oldV.sku !== "105-01-GOLD") {
        try {
          await prisma.variant.update({ where: { id: oldV.id }, data: {
            sku: "105-01-GOLD", variantNumber: "01", color: "Gold", pattern: "Medallion",
            stock: oldV.stock || 10, images: [IMG.pendant], isAvailable: true,
          }});
        } catch(e) { console.log("  Note: variant SKU already exists or conflict:", e.message); }
      }
    }
    console.log("  => Updated to pn=105-01, category=Pendants\n");
  } else {
    console.log("  Not found — will create fresh\n");
  }

  // Products
  console.log("[4/5] Products...");
  let created=0, updated=0, failed=0;
  for (const p of PRODUCTS) {
    const catId = catMap[p.catSlug];
    if (!catId) { console.error("  SKIP " + p.pn + ": no catId for " + p.catSlug); failed++; continue; }
    try {
      const exByPN   = await prisma.product.findFirst({ where: { productNumber: p.pn }, include: { variants: true } });
      const exBySlug = await prisma.product.findFirst({ where: { slug: p.slug },        include: { variants: true } });
      const ex = exByPN || exBySlug;
      if (ex) {
        await prisma.product.update({ where: { id: ex.id }, data: {
          productNumber: p.pn, name: p.name, slug: p.slug, description: p.desc,
          basePrice: p.price, images: [p.img], isActive: true, categoryId: catId,
        }});
        const exV = ex.variants.find(v => v.sku === p.vSku);
        if (exV) {
          await prisma.variant.update({ where: { id: exV.id }, data: {
            color: p.vColor, pattern: p.vPattern, stock: 10,
            additionalPrice: 0, images: [p.img], isAvailable: true,
          }});
        } else {
          await prisma.variant.create({ data: {
            sku: p.vSku, variantNumber: "01", color: p.vColor, pattern: p.vPattern, stock: 10,
            additionalPrice: 0, images: [p.img], isAvailable: true, productId: ex.id,
          }});
        }
        console.log("  UPDATED [" + p.pn + "] " + p.name); updated++;
      } else {
        await prisma.product.create({ data: {
          productNumber: p.pn, name: p.name, slug: p.slug, description: p.desc,
          basePrice: p.price, images: [p.img], isActive: true, categoryId: catId,
            variants: { create: [{ sku: p.vSku, variantNumber: "01", color: p.vColor, pattern: p.vPattern, stock: 10, additionalPrice: 0, images: [p.img], isAvailable: true }] },
        }});
        console.log("  CREATED [" + p.pn + "] " + p.name); created++;
      }
      await sleep(120);
    } catch(err) { console.error("  FAILED [" + p.pn + "] " + p.name + ": " + err.message); failed++; }
  }
  console.log("  => created:" + created + " updated:" + updated + " failed:" + failed + "\n");

  // Verify
  console.log("[5/5] Final Verification...");
  const cats = await prisma.category.findMany({ include: { products: { select: { id: true } } } });
  const prods = await prisma.product.findMany({ where: { isActive: true }, orderBy: { productNumber: "asc" } });
  console.log("\n--- Categories ---");
  for (const c of cats.sort((a,b)=>a.name.localeCompare(b.name))) {
    const num = (CATEGORIES.find(x=>x.slug===c.slug)||{}).catNum || "???";
    console.log("[" + num + "] " + c.name + " (slug:" + c.slug + ") products:" + c.products.length);
  }
  console.log("\n--- Products ---");
  for (const p of prods) {
    const fmt = p.productNumber ? (validPN(p.productNumber) ? "OK" : "BAD-FORMAT") : "NO-PN";
    console.log("[" + (p.productNumber||"---") + "] " + fmt + " " + p.name + " Rs." + p.basePrice);
  }
  const pns = prods.map(p=>p.productNumber).filter(Boolean);
  const dupes = pns.length - new Set(pns).size;
  const badFmt = pns.filter(pn=>!validPN(pn)).length;
  console.log("\n--- Integrity ---");
  console.log("Categories: " + cats.length + " | Active Products: " + prods.length);
  console.log("Products with PN: " + pns.length + " | Unique PNs: " + new Set(pns).size);
  console.log("Duplicates: " + (dupes===0?"NONE":"YES:"+dupes) + " | Bad format: " + (badFmt===0?"NONE":"YES:"+badFmt));
  console.log("\n=== Seed COMPLETE ===\n");
}

main().catch(e => { console.error("Seed FAILED:", e); process.exit(1); })
      .finally(async () => { await prisma.$disconnect(); await pool.end(); });
