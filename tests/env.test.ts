import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

/** Carrega o módulo de env do zero (ele faz cache interno da configuração). */
async function loadEnvFresh() {
  vi.resetModules();
  const mod = await import("../src/config/env.js");
  return mod.loadEnv() as unknown as Record<string, unknown>;
}

beforeEach(() => {
  process.env = {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/shopee_deals",
    ADMIN_SESSION_SECRET: "uma-chave-bem-longa-de-teste",
    RUN_MODE: "TEST",
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadEnv", () => {
  it("aceita variáveis opcionais como string vazia, tratando-as como ausentes", async () => {
    // É exatamente assim que o .env.example vem preenchido.
    process.env["CRON_SECRET"] = "";
    process.env["SHOPEE_API_ENDPOINT"] = "";
    process.env["SHOPEE_APP_ID"] = "";
    process.env["SHOPEE_APP_SECRET"] = "";

    const env = await loadEnvFresh();

    expect(env["CRON_SECRET"]).toBeUndefined();
    expect(env["SHOPEE_API_ENDPOINT"]).toBeUndefined();
    expect(env["SHOPEE_APP_ID"]).toBeUndefined();
  });

  it("aceita as variáveis opcionais ausentes por completo", async () => {
    const env = await loadEnvFresh();
    expect(env["CRON_SECRET"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toContain("postgresql://");
  });

  it("aceita valores reais quando preenchidos", async () => {
    process.env["CRON_SECRET"] = "um-segredo-de-cron-bem-longo";
    process.env["SHOPEE_API_ENDPOINT"] = "https://open-api.affiliate.shopee.com.br/graphql";

    const env = await loadEnvFresh();

    expect(env["CRON_SECRET"]).toBe("um-segredo-de-cron-bem-longo");
    expect(env["SHOPEE_API_ENDPOINT"]).toContain("shopee.com.br");
  });

  it("ainda rejeita valores inválidos de verdade (não vazios)", async () => {
    process.env["SHOPEE_API_ENDPOINT"] = "isso-nao-e-uma-url";
    await expect(loadEnvFresh()).rejects.toThrow(/Variáveis de ambiente inválidas/);
  });

  it("exige DATABASE_URL", async () => {
    delete process.env["DATABASE_URL"];
    await expect(loadEnvFresh()).rejects.toThrow(/DATABASE_URL/);
  });
});
