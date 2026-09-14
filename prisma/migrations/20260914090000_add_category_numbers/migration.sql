ALTER TABLE "Category" ADD COLUMN "categoryNumber" TEXT;

UPDATE "Category"
SET "categoryNumber" = CASE "slug"
  WHEN 'ring' THEN '101'
  WHEN 'necklace' THEN '102'
  WHEN 'bracelet' THEN '103'
  WHEN 'earrings' THEN '104'
  WHEN 'pendant' THEN '105'
  ELSE NULL
END
WHERE "categoryNumber" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Category" WHERE "categoryNumber" IS NULL) THEN
    RAISE EXCEPTION 'Cannot make Category.categoryNumber required: unmapped categories exist';
  END IF;
END $$;

ALTER TABLE "Category" ALTER COLUMN "categoryNumber" SET NOT NULL;
CREATE UNIQUE INDEX "Category_categoryNumber_key" ON "Category"("categoryNumber");