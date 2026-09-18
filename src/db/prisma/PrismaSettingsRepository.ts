import type { PrismaClient } from "@prisma/client";
import type { SettingsRepository } from "../repositories.js";
import {
  OperationalSettingsSchema,
  defaultOperationalSettings,
  SETTINGS_KEY,
  type OperationalSettings,
} from "../../config/operationalSettings.js";

export class PrismaSettingsRepository implements SettingsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getOperationalSettings(): Promise<OperationalSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
    if (!row) return defaultOperationalSettings();

    try {
      return OperationalSettingsSchema.parse(JSON.parse(row.value));
    } catch {
      // Configuração corrompida/inválida no banco -> preferimos os padrões
      // seguros a travar o sistema (seção 33: na dúvida, não publicar errado).
      return defaultOperationalSettings();
    }
  }

  async saveOperationalSettings(settings: OperationalSettings, updatedBy?: string): Promise<void> {
    const value = JSON.stringify(OperationalSettingsSchema.parse(settings));
    await this.prisma.setting.upsert({
      where: { key: SETTINGS_KEY },
      create: { key: SETTINGS_KEY, value, updatedBy: updatedBy ?? null },
      update: { value, updatedBy: updatedBy ?? null },
    });
  }
}
