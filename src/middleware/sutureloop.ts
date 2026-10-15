import { Request, Response, NextFunction } from 'express';

export interface SutureLoopMiddlewareOptions {
  serviceName: string;
  sutureLoopIngestUrl?: string;
  reportUncaughtExceptions?: boolean;
}

/**
 * Express Error Middleware that catches unhandled exceptions, extracts stack coordinates,
 * and notifies SutureLoop for autonomous triage and remediation.
 */
export function sutureLoopMiddleware(options: SutureLoopMiddlewareOptions) {
  const ingestUrl = options.sutureLoopIngestUrl || process.env.SUTURELOOP_INGEST_URL || 'http://localhost:3000/api/v1/incidents/ingest';

  // The ingest endpoint requires `x-sutureloop-secret` (or a Bearer token)
  // whenever a secret is configured. This middleware used to send only
  // Content-Type and never checked the response status, so the first time an
  // operator set a secret every forwarded crash was rejected with 401 and the
  // middleware reported nothing -- telemetry simply stopped arriving.
  const configuredSecret = process.env.SUTURELOOP_WEBHOOK_SECRET || process.env.API_SECRET;

  return (err: any, req: Request, _res: Response, next: NextFunction) => {
    const traceId = `trace_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Extract file path and line number from stack frame
    let filePath = 'unknown';
    let lineNumber = 0;
    if (err.stack) {
      const match = err.stack.match(/at\s+(?:.*?)\s+\((.*?):(\d+):(\d+)\)/) || err.stack.match(/at\s+(.*?):(\d+):(\d+)/);
      if (match) {
        filePath = match[1];
        lineNumber = parseInt(match[2], 10);
      }
    }

    const payload = {
      traceId,
      service: options.serviceName,
      errorMessage: err.message || String(err),
      errorStack: err.stack,
      filePath,
      lineNumber,
      endpoint: req.originalUrl || req.url,
      method: req.method,
      timestamp: Date.now()
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (configuredSecret) {
      headers['x-sutureloop-secret'] = configuredSecret;
    }

    // Asynchronously notify SutureLoop ingestion endpoint without blocking client error response
    fetch(ingestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    })
      .then(async (res) => {
        if (res.ok) return;
        const detail = await res.text().catch(() => '');
        console.warn(
          `[SutureLoop Middleware] Ingest endpoint rejected ${traceId}: HTTP ${res.status} ${detail}`
        );
      })
      .catch(postErr => {
        console.warn(`[SutureLoop Middleware] Could not reach ingest endpoint ${ingestUrl}: ${postErr.message}`);
      });

    next(err);
  };
}
