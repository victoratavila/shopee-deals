-- Persist the configured search category separately from Shopee's product category.
ALTER TABLE "PublishedDeal"
  ADD COLUMN "searchCategoryId" TEXT,
  ADD COLUMN "searchCategoryName" TEXT;
