import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleInvoiceBilling, processInvoice } from './routes/billing.js';
import { TelemetryService } from '../../src/telemetry/neatlogs_client.js';
import { SutureLoopOrchestrator } from '../../src/core/orchestrator.js';
import { assertValidTargetFile } from '../../src/core/invariants.js';
import * as neatlogs from 'neatlogs';
import { config } from '../../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.resolve(__dirname, '../../public');

const app = express();
app.use(express.json());

function requireWebhookAuth(req: Request, res: Response, next: NextFunction): void {
  const configuredSecret = process.env.SUTURELOOP_WEBHOOK_SECRET || process.env.API_SECRET;
  if (!configuredSecret) {
    // If no secret configured in environment, allow local loopback calls only for security
    const ip = req.ip || req.socket.remoteAddress || '';
    const isLocal = ip.includes('127.0.0.1') || ip === '::1' || ip.includes('localhost') || ip.includes('::ffff:127.0.0.1');
    if (isLocal) {
      return next();
    }
    res.status(401).json({ error: 'Unauthorized: SUTURELOOP_WEBHOOK_SECRET required for remote access.' });
    return;
  }
  const authHeader = req.headers['authorization'] || req.headers['x-sutureloop-secret'];
  const token = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (token === configuredSecret || token === `Bearer ${configuredSecret}`) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized: Invalid authentication credentials.' });
}

// Canonical clean URL routing
app.get('/dashboard.html', (_req: Request, res: Response) => {
  res.redirect(301, '/dashboard');
});
app.get('/dashboard', (_req: Request, res: Response) => {
  const dashPath = fs.existsSync(path.join(publicPath, 'dashboard', 'index.html'))
    ? path.join(publicPath, 'dashboard', 'index.html')
    : path.join(publicPath, 'dashboard.html');
  res.sendFile(dashPath);
});

app.use(express.static(publicPath));

const telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);

// Initialize neatlogs SDK if API key is provided
if (config.neatlogsApiKey) {
  try {
    await neatlogs.init({
      apiKey: config.neatlogsApiKey,
      workflowName: 'sutureloop-demo-service'
    });
    console.log('[Neatlogs] Initialized cloud telemetry SDK.');
  } catch (err: any) {
    console.warn(`[Neatlogs] Cloud SDK initialization warning: ${err.message}`);
  }
}

app.post('/api/billing/invoice', async (req: Request, res: Response) => {
  const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const startTime = Date.now();

  try {
    let city: string;
    if (config.neatlogsApiKey) {
      city = await neatlogs.trace({ name: 'processInvoice', input: req.body }, async () => {
        return processInvoice(req.body);
      });
      await neatlogs.flush();
    } else {
      city = processInvoice(req.body);
    }
    const duration = Date.now() - startTime;

    // Record success span
    await telemetry.recordLocalFailureSpan({
      traceId,
      spanId: `span_${Date.now()}`,
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: '',
      filePath: 'demo/service/routes/billing.ts',
      lineNumber: 16
    });

    res.json({
      success: true,
      traceId,
      durationMs: duration,
      data: { city }
    });
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`[Server Error] In /api/billing/invoice: ${error.message}`);

    if (config.neatlogsApiKey) {
      try {
        await neatlogs.flush();
      } catch {}
    }

    // Capture failure in telemetry
    const failureSpan = {
      traceId,
      spanId: `span_${Date.now()}`,
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: error.message,
      errorStack: error.stack,
      filePath: 'demo/service/routes/billing.ts',
      lineNumber: 16
    };

    await telemetry.recordLocalFailureSpan(failureSpan);

    res.status(500).json({
      success: false,
      traceId,
      durationMs: duration,
      error: error.message,
      stack: error.stack
    });
  }
});

let latestSessionResult: any = null;

app.get('/api/dashboard/stats', (_req: Request, res: Response) => {
  const spansFile = path.resolve('.neatlogs_local_spans.json');
  let spans = [];
  if (fs.existsSync(spansFile)) {
    try { spans = JSON.parse(fs.readFileSync(spansFile, 'utf-8')); } catch { spans = []; }
  }
  const billingPath = path.resolve(__dirname, 'routes/billing.ts');
  const billingContent = fs.existsSync(billingPath) ? fs.readFileSync(billingPath, 'utf-8') : '';
  const isPatched = billingContent.includes('??') || billingContent.includes('?.');

  // Dynamic measured metrics from the actual healing run
  const measuredMttr = latestSessionResult ? Number((latestSessionResult.durationMs / 1000).toFixed(2)) : 0;
  const measuredRollback = latestSessionResult?.attempts?.find((a: any) => a.rollbackOccurred)?.rollbackDurationMs || 0;
  const measuredCost = latestSessionResult?.economicMetrics?.measuredTokenCostUSD || 0;
  const measuredMargin = latestSessionResult?.economicMetrics?.grossMarginPercent || 0;

  // Dynamic blast radius calculation based on callers
  const callerCount = latestSessionResult?.blastRadius?.callers?.length || 0;
  const declaredFunctions = (billingContent.match(/function\s+\w+/g) || []).length || 2;
  const blastRadiusPct = latestSessionResult
    ? Number(((callerCount / Math.max(declaredFunctions, 1)) * 100).toFixed(2))
    : 0;

  const incidents = latestSessionResult ? [
    {
      id: latestSessionResult.sessionId || 'INC-LIVE',
      service: 'billing-service',
      target: `${latestSessionResult.targetFile}:${latestSessionResult.blastRadius?.targetLine || 16}`,
      status: isPatched ? 'VERIFIED HEALED' : 'CRASH PENDING',
      duration: `${measuredMttr}s`,
      costUSD: measuredCost,
      rollbackOccurred: Boolean(latestSessionResult?.attempts?.some((a: any) => a.rollbackOccurred))
    }
  ] : [];

  res.json({
    status: 'ok',
    service: 'billing-service',
    isPatched,
    state: isPatched ? 'HEALTHY_PATCHED' : 'SEEDED_CRASH_ACTIVE',
    spansCount: spans.length,
    recentSpans: spans.slice(-5).reverse(),
    incidents,
    kpis: {
      medianMttrSec: measuredMttr,
      blastRadiusPct,
      rollbackLatencyMs: measuredRollback,
      measuredCostUSD: measuredCost,
      grossMarginPct: measuredMargin
    }
  });
});

app.post('/api/demo/trigger-crash', requireWebhookAuth, async (_req: Request, res: Response) => {
  const billingPath = path.resolve(__dirname, 'routes/billing.ts');
  const crashLineCode = `export interface InvoiceRequest {
  id?: string;
  amount?: number;
  customer?: {
    name?: string;
    address?: {
      city?: string;
      postalCode?: string;
    };
  };
}

export function processInvoice(invoice: any): string {
  // CRASH LINE:
  return invoice.customer.address.city;
}

export function handleInvoiceBilling(req: any, res: any): void {
  try {
    const city = processInvoice(req.body);
    res.json({ success: true, city });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
}
`;
  try {
    fs.writeFileSync(billingPath, crashLineCode, 'utf-8');
  } catch (err: any) {
    console.warn(`[Reset Warning] ${err.message}`);
  }

  const traceId = `trace_crash_${Date.now()}`;
  const failureSpan = {
    traceId,
    spanId: `span_${Date.now()}`,
    name: 'processInvoice',
    service: 'billing-service',
    timestamp: Date.now(),
    errorMessage: "TypeError: Cannot read properties of undefined (reading 'address')",
    errorStack: "TypeError: Cannot read properties of undefined (reading 'address')\n    at processInvoice (demo/service/routes/billing.ts:20:27)\n    at handleInvoiceBilling (demo/service/routes/billing.ts:25:18)",
    filePath: 'demo/service/routes/billing.ts',
    lineNumber: 20
  };
  await telemetry.recordLocalFailureSpan(failureSpan);

  res.json({
    success: true,
    incidentId: 'INC-8644',
    traceId,
    status: 'CRASH_RECORDED',
    error: failureSpan.errorMessage
  });
});

app.post('/api/demo/trigger-heal', requireWebhookAuth, async (_req: Request, res: Response) => {
  try {
    const orchestrator = new SutureLoopOrchestrator();
    const result = await orchestrator.run(undefined, false);
    latestSessionResult = result;
    res.json({
      success: true,
      incidentId: result.sessionId,
      status: result.finalStatus,
      durationMs: result.durationMs,
      economicMetrics: result.economicMetrics,
      session: result
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/demo/reset-baseline', requireWebhookAuth, (_req: Request, res: Response) => {
  const billingPath = path.resolve(__dirname, 'routes/billing.ts');
  const baselineCode = `export interface InvoiceRequest {
  id?: string;
  amount?: number;
  customer?: {
    name?: string;
    address?: {
      city?: string;
      postalCode?: string;
    };
  };
}

export function processInvoice(invoice: any): string {
  // CRASH LINE:
  return invoice.customer.address.city;
}

export function handleInvoiceBilling(req: any, res: any): void {
  try {
    const city = processInvoice(req.body);
    res.json({ success: true, city });
  } catch (error: any) {
    res.status(500).json({
      error: error.message,
      stack: error.stack
    });
  }
}
`;
  try {
    fs.writeFileSync(billingPath, baselineCode, 'utf-8');
    res.json({ success: true, message: 'Baseline seeded crash code restored' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Universal Inbound Crash Webhook for Production Services:
 * Receives runtime crashes from external microservices / Neatlogs webhooks / Sentry alerts,
 * validates boundaries, and triggers SutureLoop autonomous remediation!
 */
app.post('/api/v1/incidents/ingest', requireWebhookAuth, async (req: Request, res: Response) => {
  const { service, errorMessage, errorStack, filePath, lineNumber, traceId: incomingTraceId } = req.body;

  if (!filePath || typeof filePath !== 'string' || filePath.trim() === '') {
    res.status(400).json({
      accepted: false,
      error: 'Validation failed: filePath must be provided as a non-empty string.'
    });
    return;
  }
  if (!lineNumber || typeof lineNumber !== 'number' || lineNumber <= 0) {
    res.status(400).json({
      accepted: false,
      error: 'Validation failed: lineNumber must be provided as a positive integer.'
    });
    return;
  }

  try {
    assertValidTargetFile(filePath);
  } catch (err: any) {
    res.status(403).json({
      accepted: false,
      error: `Security boundary violation: ${err.message}`
    });
    return;
  }

  const traceId = incomingTraceId || `trace_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const span = {
    traceId,
    spanId: `span_${Date.now()}`,
    name: 'runtimeException',
    service: service || 'billing-service',
    timestamp: Date.now(),
    errorMessage: errorMessage || 'Unhandled Runtime Error',
    errorStack: errorStack || '',
    filePath,
    lineNumber
  };

  await telemetry.recordLocalFailureSpan(span);
  console.log(`[Ingest Webhook] Intercepted runtime exception from ${span.service} (Trace: ${traceId})`);

  // Respond immediately with 202 Accepted so caller is not delayed
  res.status(202).json({
    accepted: true,
    traceId,
    service: span.service,
    message: 'Incident ingested into SutureLoop autonomous operational pipeline'
  });

  // Run healing asynchronously in the background
  (async () => {
    try {
      const orchestrator = new SutureLoopOrchestrator();
      const result = await orchestrator.run(span, false);
      latestSessionResult = result;
      console.log(`[Ingest Webhook] Autonomous healing finished for ${traceId}: Status ${result.finalStatus}`);
    } catch (err: any) {
      console.error(`[Ingest Webhook Error] Remediation failed for ${traceId}: ${err.message}`);
    }
  })();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'billing-service' });
});

export function startServer(port = config.port) {
  const server = app.listen(port, () => {
    console.log(`[Server] Billing microservice listening on http://localhost:${port}`);
  });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Server] Port ${port} is already active. Utilizing active service instance.`);
    } else {
      console.error(`[Server Error] ${err.message}`);
    }
  });
  return server;
}

// Self-start if executed directly (cross-platform comparison for Linux, Docker, Windows, and macOS)
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedFilePath && path.resolve(__filename) === executedFilePath) {
  startServer();
}

export default app;
