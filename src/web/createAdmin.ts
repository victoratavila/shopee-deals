import { loadEnv } from "../config/env.js";
import { getPrismaClient } from "../db/prismaClient.js";
import { createAdminAuthService } from "./adminAuth.js";

/**
 * Uso: npm run admin:create -- admin@exemplo.com "senha-forte-aqui"
 * Necessário rodar uma vez antes do primeiro login no painel.
 */
async function main() {
  loadEnv();
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.error('Uso: npm run admin:create -- "email@exemplo.com" "senha"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("A senha deve ter pelo menos 8 caracteres.");
    process.exit(1);
  }

  const prisma = getPrismaClient();
  const authService = createAdminAuthService(prisma);

  try {
    const admin = await authService.createAdmin(email, password);
    console.log(`Administrador criado: ${admin.email} (id: ${admin.id})`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
