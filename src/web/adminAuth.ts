import argon2 from "argon2";
import type { PrismaClient } from "@prisma/client";

export interface AdminAuthService {
  /** Cria o primeiro admin, ou falha se o e-mail já existir. Usado só no setup inicial. */
  createAdmin(email: string, password: string): Promise<{ id: string; email: string }>;
  verifyCredentials(email: string, password: string): Promise<{ id: string; email: string } | null>;
}

export function createAdminAuthService(prisma: PrismaClient): AdminAuthService {
  return {
    async createAdmin(email, password) {
      const existing = await prisma.adminUser.findUnique({ where: { email } });
      if (existing) {
        throw new Error(`Já existe um administrador com o e-mail ${email}`);
      }
      const passwordHash = await argon2.hash(password);
      const user = await prisma.adminUser.create({ data: { email, passwordHash } });
      return { id: user.id, email: user.email };
    },

    async verifyCredentials(email, password) {
      const user = await prisma.adminUser.findUnique({ where: { email } });
      if (!user) return null;

      const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
      if (!valid) return null;

      await prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
      return { id: user.id, email: user.email };
    },
  };
}
