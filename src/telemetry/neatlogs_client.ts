import { TraceFetchFailed } from '../core/errors.js';
import { FailureSpan, ComparativeEvalResult } from '../core/types.js';
import { TraceInterceptor } from './trace_interceptor.js';
import * as fs from 'fs';
import * as path from 'path';

export class TelemetryService {
  private client: any = null;
  private seenTraceIds = new Set<string>();
  private lastPolledTimestamp = Date.now();
  private traceUrlTemplate: string;
  private apiKey?: string;
  private localTelemetryQueueFile: string;

  constructor(apiKey?: string, traceUrlTemplate?: string) {
    this.apiKey = apiKey || process.env.NEATLOGS_API_KEY;
    this.traceUrlTemplate = traceUrlTemplate || process.env.TRACE_URL_TEMPLATE || 'https://app.neatlogs.com/traces/${id}';
    this.localTelemetryQueueFile = path.resolve('.neatlogs_local_spans.json');
  }

  async init(): Promise<void> {
    if (this.apiKey) {
      try {
        const neatlogsModule = await import('neatlogs');
        const ClientClass = (neatlogsModule as any).Client || (neatlogsModule as any).default?.Client;
        if (ClientClass) {
          this.client = new ClientClass({ apiKey: this.apiKey });
        }
      } catch (err: any) {
        console.warn(`[Neatlogs] Remote client init notice: ${err.message}. Operating in hybrid mode.`);
      }
    }
  }

  /**
   * Records an error span to the local telemetry queue (used by the instrumented demo server).
   */
  async recordLocalFailureSpan(span: FailureSpan): Promise<void> {
    let existing: FailureSpan[] = [];
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      try {
        existing = JSON.parse(fs.readFileSync(this.localTelemetryQueueFile, 'utf-8'));
      } catch {
        existing = [];
      }
    }
    existing.push(span);
    fs.writeFileSync(this.localTelemetryQueueFile, JSON.stringify(existing, null, 2), 'utf-8');
  }

  /**
   * Retrieves the latest unhandled failure span.
   */
  async getLatestFailureSpan(): Promise<FailureSpan | null> {
    // 1. Try remote Neatlogs if client is available
    if (this.client && typeof this.client.getSpans === 'function') {
      try {
        const spans = await this.client.getSpans({
          status: 'error',
          since: this.lastPolledTimestamp,
          limit: 1
        });
        if (spans && spans.length > 0) {
          const rawSpan = spans[0];
          if (!this.seenTraceIds.has(rawSpan.traceId)) {
            this.seenTraceIds.add(rawSpan.traceId);
            this.lastPolledTimestamp = Date.now();
            return TraceInterceptor.extractFailureContext({
              traceId: rawSpan.traceId,
              spanId: rawSpan.spanId || rawSpan.id,
              name: rawSpan.name,
              errorMessage: rawSpan.error || rawSpan.message,
              errorStack: rawSpan.stack || rawSpan.errorStack,
              timestamp: rawSpan.timestamp || Date.now(),
              rawAttributes: rawSpan
            });
          }
        }
      } catch (err: any) {
        console.warn(`[Neatlogs] Remote span query failed: ${err.message}. Falling back to local queue.`);
      }
    }

    // 2. Inspect local telemetry buffer from the instrumented app
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      try {
        const fileContent = fs.readFileSync(this.localTelemetryQueueFile, 'utf-8');
        const spans: FailureSpan[] = JSON.parse(fileContent);
        for (let i = spans.length - 1; i >= 0; i--) {
          const s = spans[i];
          if (!this.seenTraceIds.has(s.traceId)) {
            this.seenTraceIds.add(s.traceId);
            this.lastPolledTimestamp = Date.now();
            return TraceInterceptor.extractFailureContext(s);
          }
        }
      } catch (err: any) {
        throw new TraceFetchFailed(`Failed to read local telemetry queue: ${err.message}`);
      }
    }

    return null;
  }

  /**
   * Runs comparative evaluation between the failure baseline trace and the post-fix trace.
   */
  async runComparativeEval(baselineTraceId: string, healedTraceId: string): Promise<ComparativeEvalResult> {
    const baselineUrl = this.traceUrlTemplate.replace('${id}', baselineTraceId);
    const healedUrl = this.traceUrlTemplate.replace('${id}', healedTraceId);

    // If remote client is available, attempt to get real metrics
    if (this.client && typeof this.client.getTrace === 'function') {
      try {
        const baseline = await this.client.getTrace(baselineTraceId);
        const healed = await this.client.getTrace(healedTraceId);

        if (baseline?.errorCount !== undefined && healed?.errorCount !== undefined) {
          return {
            mode: 'PROGRAMMATIC_EVAL',
            baselineTraceId,
            healedTraceId,
            baselineTraceUrl: baselineUrl,
            healedTraceUrl: healedUrl,
            baselineErrors: baseline.errorCount,
            healedErrors: healed.errorCount,
            deltaErrors: baseline.errorCount - healed.errorCount,
            durationMs: healed.duration,
            tokenCostUSD: healed.tokenCost,
            status: healed.errorCount === 0 ? 'VERIFIED_PASS' : 'REGRESSION_DETECTED'
          };
        }
      } catch (err: any) {
        console.warn(`[Neatlogs] Programmatic eval failed: ${err.message}`);
      }
    }

    // Check local recorded traces
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      try {
        const spans: FailureSpan[] = JSON.parse(
          fs.readFileSync(this.localTelemetryQueueFile, 'utf-8')
        );
        const baselineSpan = spans.find((s) => s.traceId === baselineTraceId);
        const healedSpan = spans.find((s) => s.traceId === healedTraceId);

        if (baselineSpan && healedSpan) {
          const baselineErrors = 1;
          const healedErrors = healedSpan.errorMessage ? 1 : 0;
          return {
            mode: 'PROGRAMMATIC_EVAL',
            baselineTraceId,
            healedTraceId,
            baselineTraceUrl: baselineUrl,
            healedTraceUrl: healedUrl,
            baselineErrors,
            healedErrors,
            deltaErrors: baselineErrors - healedErrors,
            status: healedErrors === 0 ? 'VERIFIED_PASS' : 'REGRESSION_DETECTED',
            note: 'Verified from local instrumented telemetry trace log.'
          };
        }
      } catch {
        // Fallback below
      }
    }

    // Honest fallback: output dashboard URLs for camera verification
    return {
      mode: 'DASHBOARD_SIDE_BY_SIDE',
      baselineTraceId,
      healedTraceId,
      baselineTraceUrl: baselineUrl,
      healedTraceUrl: healedUrl,
      status: 'MANUAL_VERIFICATION_REQUIRED',
      note: 'Read error delta and duration directly from neatlogs dashboard.'
    };
  }

  clearLocalQueue(): void {
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      fs.unlinkSync(this.localTelemetryQueueFile);
    }
    this.seenTraceIds.clear();
  }
}
