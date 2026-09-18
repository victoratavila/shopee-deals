-- CreateEnum
CREATE TYPE "PublishChannel" AS ENUM ('DRY_RUN', 'TEST', 'TELEGRAM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('TEST', 'DRY_RUN', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "RejectionReason" AS ENUM ('DISCOUNT_BELOW_MINIMUM', 'RATING_BELOW_MINIMUM', 'REVIEWS_BELOW_MINIMUM', 'SALES_BELOW_MINIMUM', 'COMMISSION_BELOW_MINIMUM', 'PRICE_OUT_OF_RANGE', 'CATEGORY_BLOCKED', 'CATEGORY_NOT_ALLOWED', 'RECENTLY_PUBLISHED', 'SUSPICIOUS_PRICE', 'DUPLICATE', 'INVALID_DATA', 'DAILY_LIMIT_REACHED', 'ROUND_LIMIT_REACHED');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "shopId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "imageUrl" TEXT,
    "category" TEXT,
    "currentPrice" DECIMAL(12,2) NOT NULL,
    "previousPrice" DECIMAL(12,2),
    "discountPercent" DECIMAL(5,2),
    "rating" DECIMAL(3,2),
    "ratingCount" INTEGER,
    "salesCount" INTEGER,
    "commissionPercent" DECIMAL(5,2),
    "affiliateLink" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedDeal" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "priceAtPublish" DECIMAL(12,2) NOT NULL,
    "dealScore" DECIMAL(5,2) NOT NULL,
    "channel" "PublishChannel" NOT NULL,
    "externalRef" TEXT,
    "runId" TEXT,
    "approvedManually" BOOLEAN NOT NULL DEFAULT false,
    "approvedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishedDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "mode" "RunMode" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "productsFound" INTEGER NOT NULL DEFAULT 0,
    "productsFiltered" INTEGER NOT NULL DEFAULT 0,
    "dealsSelected" INTEGER NOT NULL DEFAULT 0,
    "dealsPublished" INTEGER NOT NULL DEFAULT 0,
    "errorsCount" INTEGER NOT NULL DEFAULT 0,
    "triggeredBy" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RejectedOffer" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shopeeItemId" TEXT NOT NULL,
    "productName" TEXT,
    "reason" "RejectionReason" NOT NULL,
    "details" TEXT,
    "offerSnapshot" TEXT,
    "manuallyApprovedAt" TIMESTAMP(3),
    "manuallyApprovedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RejectedOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT,
    "scope" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "context" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopeeItemId_key" ON "Product"("shopeeItemId");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE INDEX "Product_lastSeenAt_idx" ON "Product"("lastSeenAt");

-- CreateIndex
CREATE INDEX "Product_currentPrice_idx" ON "Product"("currentPrice");

-- CreateIndex
CREATE INDEX "PriceHistory_productId_recordedAt_idx" ON "PriceHistory"("productId", "recordedAt");

-- CreateIndex
CREATE INDEX "PublishedDeal_productId_publishedAt_idx" ON "PublishedDeal"("productId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublishedDeal_productId_channel_publishedAt_key" ON "PublishedDeal"("productId", "channel", "publishedAt");

-- CreateIndex
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

-- CreateIndex
CREATE INDEX "RejectedOffer_runId_idx" ON "RejectedOffer"("runId");

-- CreateIndex
CREATE INDEX "RejectedOffer_reason_idx" ON "RejectedOffer"("reason");

-- CreateIndex
CREATE INDEX "ErrorLog_scope_createdAt_idx" ON "ErrorLog"("scope", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedDeal" ADD CONSTRAINT "PublishedDeal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedDeal" ADD CONSTRAINT "PublishedDeal_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RejectedOffer" ADD CONSTRAINT "RejectedOffer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
