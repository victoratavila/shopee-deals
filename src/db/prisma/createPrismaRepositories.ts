import type { PrismaClient } from "@prisma/client";
import type { Repositories } from "../repositories.js";
import { PrismaProductRepository } from "./PrismaProductRepository.js";
import { PrismaPriceHistoryRepository } from "./PrismaPriceHistoryRepository.js";
import { PrismaPublishedDealRepository } from "./PrismaPublishedDealRepository.js";
import { PrismaRejectedOfferRepository } from "./PrismaRejectedOfferRepository.js";
import { PrismaErrorLogRepository } from "./PrismaErrorLogRepository.js";
import { PrismaRunRepository } from "./PrismaRunRepository.js";
import { PrismaSettingsRepository } from "./PrismaSettingsRepository.js";

export function createPrismaRepositories(prisma: PrismaClient): Repositories {
  return {
    product: new PrismaProductRepository(prisma),
    priceHistory: new PrismaPriceHistoryRepository(prisma),
    publishedDeal: new PrismaPublishedDealRepository(prisma),
    rejectedOffer: new PrismaRejectedOfferRepository(prisma),
    errorLog: new PrismaErrorLogRepository(prisma),
    run: new PrismaRunRepository(prisma),
    settings: new PrismaSettingsRepository(prisma),
  };
}
