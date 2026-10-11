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
  defaultEngineerHourlyRate: number;
  defaultIncidentMttrMinutes: number;
}

export const config: Config = {
  neatlogsApiKey: process.env.NEATLOGS_API_KEY,
  traceUrlTemplate: process.env.TRACE_URL_TEMPLATE || 'https://app.neatlogs.com/traces/${id}',
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  port: parseInt(process.env.PORT || '3000', 10),
  demoForceFault: process.env.DEMO_FORCE_FAULT === 'true',
  retryLimit: parseInt(process.env.RETRY_LIMIT || '3', 10),
  defaultEngineerHourlyRate: parseFloat(process.env.DEFAULT_ENGINEER_HOURLY_RATE || '125'),
  defaultIncidentMttrMinutes: parseFloat(process.env.DEFAULT_INCIDENT_MTTR_MINUTES || '45'),
};
