-- AlterEnum
ALTER TYPE "RejectionReason" ADD VALUE 'MANUALLY_REJECTED';

-- AlterTable
ALTER TABLE "RejectedOffer" ALTER COLUMN "runId" DROP NOT NULL;
