-- AlterTable
ALTER TABLE "PublishedDeal" ADD COLUMN     "sourceRejectedOfferId" TEXT;

-- CreateTable
CREATE TABLE "SchedulerLock" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "lockedAt" TIMESTAMP(3),
    "runId" TEXT,

    CONSTRAINT "SchedulerLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RejectedOffer_createdAt_idx" ON "RejectedOffer"("createdAt");
