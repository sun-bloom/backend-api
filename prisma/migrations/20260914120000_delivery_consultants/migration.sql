ALTER TABLE "DeliveryRegion" ADD COLUMN IF NOT EXISTS "pincodeStart" TEXT;
ALTER TABLE "DeliveryRegion" ADD COLUMN IF NOT EXISTS "pincodeEnd" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "deliveryRegionId" TEXT;

CREATE TABLE IF NOT EXISTS "OrderConsultantRequest" (
  "id" TEXT NOT NULL,
  "customerId" TEXT,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "whatsappNumber" TEXT,
  "email" TEXT NOT NULL,
  "address" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "pincode" TEXT NOT NULL,
  "cartItems" JSONB,
  "subtotal" DOUBLE PRECISION,
  "requestedRegion" TEXT,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderConsultantRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OrderConsultantRequest_status_idx" ON "OrderConsultantRequest"("status");
CREATE INDEX IF NOT EXISTS "OrderConsultantRequest_createdAt_idx" ON "OrderConsultantRequest"("createdAt");
CREATE INDEX IF NOT EXISTS "OrderConsultantRequest_pincode_idx" ON "OrderConsultantRequest"("pincode");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_deliveryRegionId_fkey') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_deliveryRegionId_fkey" FOREIGN KEY ("deliveryRegionId") REFERENCES "DeliveryRegion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'OrderConsultantRequest_customerId_fkey') THEN
    ALTER TABLE "OrderConsultantRequest" ADD CONSTRAINT "OrderConsultantRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
