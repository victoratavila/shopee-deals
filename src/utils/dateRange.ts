/**
 * Início do dia de calendário de N dias atrás (incluindo hoje), no fuso
 * horário do processo Node - o mesmo padrão já usado em runPipeline.ts e
 * approveRejectedOffer.ts para calcular "início de hoje" (`new Date();
 * setHours(0,0,0,0)`). Não existe uma configuração de timezone separada no
 * sistema; o fuso "configurado" é o do próprio processo/servidor, que é
 * exatamente essa mesma convenção já usada em todo o resto do código.
 *
 * daysAgo=1 -> hoje
 * daysAgo=3 -> hoje + 2 dias anteriores (3 dias de calendário, não 72h)
 *
 * Exemplo: se hoje é 20/09/2026 e daysAgo=3, retorna 18/09/2026 00:00:00.
 */
export function startOfDaysAgo(daysAgo: number, now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (daysAgo - 1));
  return start;
}

/**
 * Período máximo permitido para consultar ofertas rejeitadas: 3 dias
 * corridos, incluindo hoje. Definido num só lugar para não haver dois
 * números "mágicos" diferentes entre frontend e backend.
 */
export const MAX_REJECTIONS_PERIOD_DAYS = 3;

/**
 * Garante que o período solicitado nunca ultrapasse o máximo permitido -
 * aplicado no BACKEND, não apenas escondido no frontend. Qualquer valor
 * inválido, ausente ou maior que o máximo é reduzido ao máximo (nunca
 * lança erro, nunca deixa passar um período maior).
 */
export function clampPeriodDays(requestedDays: number | undefined, maxDays: number = MAX_REJECTIONS_PERIOD_DAYS): number {
  if (requestedDays === undefined || !Number.isInteger(requestedDays) || requestedDays < 1) {
    return maxDays;
  }
  return Math.min(requestedDays, maxDays);
}
