import dotenv from 'dotenv';
dotenv.config();

export interface Config {
  neatlogsApiKey?: string;
  traceUrlTemplate: string;
  openRouterApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  port: number;
  demoForceFault: boolean;
  retryLimit: number;
  regressionTestTimeoutMs: number;
  defaultEngineerHourlyRate: number;
  defaultIncidentMttrMinutes: number;
  /**
   * What `/api/v1/incidents/ingest` is authorised to do with an incoming span.
   *
   * `auto-heal`   - record the span and immediately remediate (default; the
   *                 behaviour the README documents).
   * `record-only` - record the span and stop. The incident is visible in the
   *                 telemetry queue for an operator (or a separately gated
   *                 process) to act on, but an inbound HTTP request cannot
   *                 cause a source file to be rewritten.
   *
   * Monitoring and remediation have different blast radii, so they do not share
   * a switch by default in any deployment where the endpoint is reachable.
   */
  ingestMode: 'auto-heal' | 'record-only';
}

/**
 * Parses a numeric env var, falling back to `fallback` when it is absent or
 * malformed. A bad `RETRY_LIMIT` previously produced `NaN`, which propagated
 * into the attempt budget and silently disabled the bound.
 */
function num(name: string, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.warn(`[Config] ${name}="${raw}" is not a number; using ${fallback}.`);
    return fallback;
  }
  if (parsed < min) {
    console.warn(`[Config] ${name}=${parsed} is below the minimum ${min}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

export const config: Config = {
  neatlogsApiKey: process.env.NEATLOGS_API_KEY,
  traceUrlTemplate: process.env.TRACE_URL_TEMPLATE || 'https://app.neatlogs.com/traces/${id}',
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  port: num('PORT', 3000, 1),
  demoForceFault: process.env.DEMO_FORCE_FAULT === 'true',
  // Attempt budget. Attempt 1 is the strategy selected by the blast radius;
  // attempts 2..retryLimit are always context-informed. Default 2 preserves
  // the documented "Attempt 1 -> rollback -> Attempt 2" loop.
  retryLimit: num('RETRY_LIMIT', 2, 1),
  // A hung vitest run must fail the attempt, not freeze the agent.
  regressionTestTimeoutMs: num('REGRESSION_TEST_TIMEOUT_MS', 120_000, 1_000),
  defaultEngineerHourlyRate: num('DEFAULT_ENGINEER_HOURLY_RATE', 125, 0),
  defaultIncidentMttrMinutes: num('DEFAULT_INCIDENT_MTTR_MINUTES', 45, 0),
  ingestMode: process.env.SUTURELOOP_INGEST_MODE === 'record-only' ? 'record-only' : 'auto-heal',
};