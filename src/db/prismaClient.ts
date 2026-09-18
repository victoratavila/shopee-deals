import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

/** Singleton simples - evita múltiplas conexões em dev com hot-reload. */
export function getPrismaClient(): PrismaClient {
  if (!client) {
    client = new PrismaClient();
  }
  return client;
}
