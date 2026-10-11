import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleInvoiceBilling, processInvoice } from './routes/billing.js';
import { TelemetryService } from '../../src/telemetry/neatlogs_client.js';
import * as neatlogs from 'neatlogs';
import { config } from '../../src/config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.resolve(__dirname, '../../public');

const app = express();
app.use(express.json());
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
    const city = processInvoice(req.body);
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

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'billing-service' });
});

export function startServer(port = config.port) {
  return app.listen(port, () => {
    console.log(`[Server] Billing microservice listening on http://localhost:${port}`);
  });
}

// Self-start if executed directly
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  startServer();
}

export default app;
