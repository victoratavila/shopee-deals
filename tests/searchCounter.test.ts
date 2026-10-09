import { describe, it, expect } from "vitest";
import { createInMemoryRepositories } from "./inMemoryRepositories.js";
import { startOfDaysAgo } from "../src/utils/dateRange.js";

describe("RunRepository.countRunsSince - contador de buscas", () => {
  it("conta separadamente buscas automáticas (scheduler) e manuais", async () => {
    const repos = createInMemoryRepositories();

    const r1 = await repos.run.create("TEST", "scheduler");
    await repos.run.finish(r1.id, {
      status: "SUCCESS",
      productsFound: 0,
      productsFiltered: 0,
      dealsSelected: 0,
      dealsPublished: 0,
      errorsCount: 0,
      durationMs: 1,
    });

    const r2 = await repos.run.create("TEST", "manual:admin-1");
    await repos.run.finish(r2.id, {
      status: "SUCCESS",
      productsFound: 0,
      productsFiltered: 0,
      dealsSelected: 0,
      dealsPublished: 0,
      errorsCount: 0,
      durationMs: 1,
    });

    const r3 = await repos.run.create("TEST", "scheduler");
    await repos.run.finish(r3.id, {
      status: "SUCCESS",
      productsFound: 0,
      productsFiltered: 0,
      dealsSelected: 0,
      dealsPublished: 0,
      errorsCount: 0,
      durationMs: 1,
    });

    const counts = await repos.run.countRunsSince(startOfDaysAgo(1));
    expect(counts.schedulerCount).toBe(2);
    expect(counts.manualCount).toBe(1);
    expect(counts.totalCount).toBe(3);
  });

  it("conta com base em execuções REAIS (Run), não na quantidade de ofertas encontradas", async () => {
    const repos = createInMemoryRepositories();
    // Uma única execução, independente de quantas ofertas ela encontrou.
    const run = await repos.run.create("TEST", "scheduler");
    await repos.run.finish(run.id, {
      status: "SUCCESS",
      productsFound: 500, // muitos produtos encontrados
      productsFiltered: 480,
      dealsSelected: 20,
      dealsPublished: 20,
      errorsCount: 0,
      durationMs: 1,
    });

    const counts = await repos.run.countRunsSince(startOfDaysAgo(1));
    // Continua sendo 1 execução, não 500 nem 20.
    expect(counts.totalCount).toBe(1);
    expect(counts.schedulerCount).toBe(1);
  });

  it("respeita o dia de calendário (execuções de dias anteriores não contam em 'hoje')", async () => {
    const repos = createInMemoryRepositories();
    const run = await repos.run.create("TEST", "scheduler");
    // Força a data da execução para 3 dias atrás.
    const runRow = repos.state.runs.find((r) => r.id === run.id)!;
    runRow.startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const counts = await repos.run.countRunsSince(startOfDaysAgo(1));
    expect(counts.totalCount).toBe(0);
  });

  it("não conta CLI nem outras origens como 'manual' nem 'scheduler', mas soma no total", async () => {
    const repos = createInMemoryRepositories();
    const run = await repos.run.create("TEST", "cli");
    await repos.run.finish(run.id, {
      status: "SUCCESS",
      productsFound: 0,
      productsFiltered: 0,
      dealsSelected: 0,
      dealsPublished: 0,
      errorsCount: 0,
      durationMs: 1,
    });

    const counts = await repos.run.countRunsSince(startOfDaysAgo(1));
    expect(counts.schedulerCount).toBe(0);
    expect(counts.manualCount).toBe(0);
    expect(counts.totalCount).toBe(1);
  });
});
