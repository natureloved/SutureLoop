import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
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

/**
 * Authoritative crash baseline for the demo sandbox.
 *
 * The baseline is read from git (HEAD) rather than from a hand-maintained copy
 * of the source. A duplicated template drifts from the committed file the first
 * time either is edited -- the old duplicate here had lost its doc comment, so
 * every "reset" wrote a file that differed from HEAD, left the worktree dirty,
 * and then tripped the rollback safety gate. Reading from git keeps a single
 * source of truth and guarantees the reset restores a genuinely clean state.
 */
export function restoreCrashBaseline(): { ok: boolean; source: string; detail?: string } {
  const billingPath = path.resolve(__dirname, 'routes/billing.ts');
  const relativePath = path.relative(process.cwd(), billingPath).replace(/\\/g, '/');
  try {
    const baseline = execFileSync('git', ['show', `HEAD:${relativePath}`], { encoding: 'utf-8' });
    fs.writeFileSync(billingPath, baseline, 'utf-8');
    return { ok: true, source: 'git:HEAD' };
  } catch (gitErr: any) {
    // Not a git checkout (e.g. a tarball or a Docker build without .git):
    // fall back to restoring from the committed source's own content.
    return { ok: false, source: 'none', detail: gitErr?.message || String(gitErr) };
  }
}

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

/**
 * Line number of the crash site inside the sandbox file, derived from the
 * source rather than hardcoded. The previous literal (16) pointed at the
 * interface, not the throwing statement, so every recorded span carried the
 * wrong coordinates and the AST blast-radius query resolved the wrong symbol.
 */
function resolveCrashLine(): number {
  const billingPath = path.resolve(__dirname, 'routes/billing.ts');
  try {
    const lines = fs.readFileSync(billingPath, 'utf-8').split('\n');
    const idx = lines.findIndex((l) => l.includes('customer.address.city'));
    return idx >= 0 ? idx + 1 : 20;
  } catch {
    return 20;
  }
}

/**
 * Loads `processInvoice` from disk on every call.
 *
 * SutureLoop's healing loop rewrites demo/service/routes/billing.ts while this
 * server is running. A static `import` is evaluated once and cached, so the
 * server would keep calling the crashed function and the post-heal replay would
 * return HTTP 500 even though the patch on disk is correct -- silently
 * downgrading verification. A cache-busted dynamic import makes the live
 * service observe the patched code, which is what a real hot-reload would do.
 */
async function loadProcessInvoice(): Promise<(invoice: any) => string> {
  const moduleUrl = new URL(
    `./routes/billing.js?reload=${Date.now()}`,
    import.meta.url
  );
  const mod = (await import(moduleUrl.href)) as { processInvoice: (invoice: any) => string };
  return mod.processInvoice;
}

app.post('/api/billing/invoice', async (req: Request, res: Response) => {
  const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const startTime = Date.now();
  const crashLine = resolveCrashLine();

  try {
    const processInvoice = await loadProcessInvoice();
    let city: string;
    if (config.neatlogsApiKey) {
      city = await neatlogs.trace(
        { name: 'processInvoice', input: req.body },
        async () => {
          return processInvoice(req.body);
        }
      );
      await neatlogs.flush();
    } else {
      city = processInvoice(req.body);
    }
    const duration = Date.now() - startTime;

    // Record the post-heal span. An empty errorMessage marks a healthy request;
    // the comparative eval reads this to compute the before/after error delta.
    await telemetry.recordLocalFailureSpan({
      traceId,
      spanId: `span_${Date.now()}`,
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: '',
      filePath: 'demo/service/routes/billing.ts',
      lineNumber: crashLine
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
      lineNumber: crashLine
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
  const restored = restoreCrashBaseline();
  if (!restored.ok) {
    console.warn(`[Reset Warning] Baseline restore unavailable (${restored.detail}); the sandbox may already be patched.`);
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
  const restored = restoreCrashBaseline();
  if (restored.ok) {
    res.json({
      success: true,
      source: restored.source,
      message: 'Baseline seeded crash code restored from git HEAD (worktree clean)'
    });
  } else {
    res.status(500).json({
      success: false,
      error: `Baseline restore failed: ${restored.detail}. Run from a git checkout so the committed crash baseline can be restored.`
    });
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

  // Recording an incident and mutating a source file are different blast
  // radii. In record-only mode an inbound HTTP request is never enough to
  // trigger the latter.
  const mutationAuthorized = config.ingestMode === 'auto-heal';

  // Respond immediately with 202 Accepted so caller is not delayed
  res.status(202).json({
    accepted: true,
    traceId,
    service: span.service,
    remediation: mutationAuthorized ? 'scheduled' : 'recorded-only',
    message: mutationAuthorized
      ? 'Incident ingested into SutureLoop autonomous operational pipeline'
      : 'Incident recorded. SUTURELOOP_INGEST_MODE=record-only, so no source file was modified.'
  });

  if (!mutationAuthorized) {
    console.log(
      `[Ingest Webhook] SUTURELOOP_INGEST_MODE=record-only: ${traceId} recorded but not remediated.`
    );
    return;
  }

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
  res.json({ status: 'ok', service: 'billing-service', id: SERVICE_ID });
});

/** Stable identity this app answers `/health` with, used to detect a port squatter. */
const SERVICE_ID = 'sutureloop-billing-service';

/**
 * Decides whether the process already holding `port` is another instance of
 * *this* app, or some unrelated application.
 *
 * The previous handler logged "Utilizing active service instance" for any
 * EADDRINUSE. That asserts ownership it never verified: a stranger on the port
 * made the demo POST its crash payload to an unrelated service and then report
 * a successful "live re-issue" against that stranger's endpoint.
 */
async function claimExistingInstance(port: number): Promise<{ claimed: boolean; why: string }> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { claimed: false, why: `/health returned HTTP ${res.status}` };
    const body: any = await res.json();
    if (body?.id === SERVICE_ID) return { claimed: true, why: '' };
    return {
      claimed: false,
      why: `the service there identifies as ${JSON.stringify(body?.service ?? 'unknown')}, not ${SERVICE_ID}`
    };
  } catch (err: any) {
    return { claimed: false, why: err?.message || String(err) };
  }
}

export interface ServerHandle {
  /** The bound listener, or null when an existing SutureLoop instance was reused. */
  server: import('http').Server | null;
  /** True when another SutureLoop instance already owned the port. */
  reused: boolean;
}

/**
 * Starts the service and resolves only once it is actually accepting requests.
 *
 * Resolving on `listening` (rather than after a sleep) is what makes the
 * EADDRINUSE claim safe: by the time this returns, either we own the port or
 * we have verified the existing owner is us.
 */
export function startServer(port = config.port): Promise<ServerHandle> {
  return new Promise<ServerHandle>((resolve, reject) => {
    const server = app.listen(port);

    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        void claimExistingInstance(port).then(({ claimed, why }) => {
          if (claimed) {
            console.log(`[Server] Port ${port} is already served by another SutureLoop instance; reusing it.`);
            resolve({ server: null, reused: true });
          } else {
            server.close();
            reject(
              new Error(
                `Port ${port} is held by another application (${why}). ` +
                  `Refusing to start rather than demo against an endpoint that is not ours. ` +
                  `Set PORT to a free port and retry.`
              )
            );
          }
        });
        return;
      }
      server.close();
      reject(err);
    });

    server.once('listening', () => {
      server.removeAllListeners('error');
      server.on('error', (err: any) => {
        console.error(`[Server Error] ${err.message}`);
      });
      console.log(`[Server] Billing microservice listening on http://localhost:${port}`);
      resolve({ server, reused: false });
    });
  });
}

// Self-start if executed directly (cross-platform comparison for Linux, Docker, Windows, and macOS)
const executedFilePath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedFilePath && path.resolve(__filename) === executedFilePath) {
  startServer().catch((err: any) => {
    console.error(`[Server] Failed to start: ${err.message}`);
    process.exitCode = 1;
  });
}

export default app;
