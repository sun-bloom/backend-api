-- Create CustomerQuery and CustomerQueryMessage tables
CREATE TABLE IF NOT EXISTS "CustomerQuery" (
  "id" TEXT NOT NULL,
  "queryNumber" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "orderId" TEXT,
  "category" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),

  CONSTRAINT "CustomerQuery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerQuery_queryNumber_key" ON "CustomerQuery"("queryNumber");
CREATE INDEX IF NOT EXISTS "CustomerQuery_customerId_idx" ON "CustomerQuery"("customerId");
CREATE INDEX IF NOT EXISTS "CustomerQuery_status_idx" ON "CustomerQuery"("status");
CREATE INDEX IF NOT EXISTS "CustomerQuery_category_idx" ON "CustomerQuery"("category");
CREATE INDEX IF NOT EXISTS "CustomerQuery_priority_idx" ON "CustomerQuery"("priority");
CREATE INDEX IF NOT EXISTS "CustomerQuery_createdAt_idx" ON "CustomerQuery"("createdAt");

CREATE TABLE IF NOT EXISTS "CustomerQueryMessage" (
  "id" TEXT NOT NULL,
  "queryId" TEXT NOT NULL,
  "senderType" TEXT NOT NULL,
  "senderId" TEXT,
  "senderName" TEXT,
  "message" TEXT NOT NULL,
  "attachment" TEXT,
  "isInternal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CustomerQueryMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomerQueryMessage_queryId_idx" ON "CustomerQueryMessage"("queryId");
CREATE INDEX IF NOT EXISTS "CustomerQueryMessage_createdAt_idx" ON "CustomerQueryMessage"("createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerQuery_customerId_fkey') THEN
    ALTER TABLE "CustomerQuery" ADD CONSTRAINT "CustomerQuery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerQuery_orderId_fkey') THEN
    ALTER TABLE "CustomerQuery" ADD CONSTRAINT "CustomerQuery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CustomerQueryMessage_queryId_fkey') THEN
    ALTER TABLE "CustomerQueryMessage" ADD CONSTRAINT "CustomerQueryMessage_queryId_fkey" FOREIGN KEY ("queryId") REFERENCES "CustomerQuery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
