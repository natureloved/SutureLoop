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

    // Asynchronously notify SutureLoop ingestion endpoint without blocking client error response
    fetch(ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(postErr => {
      console.warn(`[SutureLoop Middleware] Could not reach ingest endpoint ${ingestUrl}: ${postErr.message}`);
    });

    next(err);
  };
}
