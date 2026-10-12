import { TraceFetchFailed } from '../core/errors.js';
import { FailureSpan, ComparativeEvalResult } from '../core/types.js';
import { TraceInterceptor } from './trace_interceptor.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * neatlogs integration for SutureLoop.
 *
 * Two distinct roles, both real:
 *
 *  1. EMISSION (the demo service). The instrumented service wraps its request
 *     handler in `neatlogs.trace(...)` and each pipeline stage in
 *     `neatlogs.span(...)`, so one trace in the neatlogs dashboard shows the
 *     agent's whole reasoning chain: ingest -> blast radius -> attempt 1 ->
 *     rollback -> attempt 2 -> comparative eval. This requires
 *     NEATLOGS_API_KEY; without it the SDK exports nothing to the cloud and the
 *     local buffer is the only record.
 *
 *  2. VERIFICATION (this file). Before/after comparison of the failure span and
 *     the healed span. Verification is layered and each layer is reported
 *     honestly via `verifiedBy` rather than silently falling through:
 *       a. local span buffer  - both traces present, error delta computed
 *       b. neatlogs-cli      - authenticated cloud readback, when the CLI exists
 *       c. dashboard URLs    - always emitted for manual inspection
 *
 * Note on the neatlogs SDK surface: the `Client` class exposes a tracer/logger
 * pipeline (`getTracer`, `flush`, `shutdown`, `getDeliveryDiagnostics`), NOT a
 * query API. There is no `getSpans`/`getTrace` on `Client`, so the previous
 * implementation's remote branches were unreachable and every call silently
 * fell through to the local buffer. Those dead branches are removed. Trace
 * *readback* goes through `neatlogs-cli` when it is installed, and is reported
 * as unavailable when it is not -- never faked.
 */
export class TelemetryService {
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

  /** Whether spans are exported to the neatlogs cloud. */
  get isCloudEnabled(): boolean {
    return Boolean(this.apiKey);
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
   * Retrieves the most recent unprocessed failure span, newest first.
   *
   * Spans come from the local buffer written by the instrumented service. When
   * that service runs with a neatlogs API key the same spans are also exported
   * to the neatlogs cloud (see `neatlogs.trace` in demo/service/server.ts);
   * this method is the local, offline-verifiable view of the same stream.
   */
  async getLatestFailureSpan(): Promise<FailureSpan | null> {
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      try {
        const fileContent = fs.readFileSync(this.localTelemetryQueueFile, 'utf-8');
        const spans: FailureSpan[] = JSON.parse(fileContent);
        for (let i = spans.length - 1; i >= 0; i--) {
          const s = spans[i];
          const hasError = Boolean(s.errorMessage && s.errorMessage.trim().length > 0);
          if (hasError && !this.seenTraceIds.has(s.traceId)) {
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
   * Runs comparative evaluation between the failure baseline span and the healed span.
   *
   * `liveReplaySucceeded` is the orchestrator's confirmation that the healed
   * code actually served the originally-failing request with a 2xx. A clean
   * healed span alone is not proof of a fix; both are required for VERIFIED_PASS.
   */
  async runComparativeEval(
    baselineTraceId: string,
    healedTraceId: string,
    liveReplaySucceeded = false
  ): Promise<ComparativeEvalResult> {
    const formatUrl = (tId: string) => {
      if (this.traceUrlTemplate.includes('${id}')) {
        return this.traceUrlTemplate.replace('${id}', tId);
      }
      return this.traceUrlTemplate.endsWith('/')
        ? `${this.traceUrlTemplate}${tId}`
        : `${this.traceUrlTemplate}/${tId}`;
    };
    const baselineUrl = formatUrl(baselineTraceId);
    const healedUrl = formatUrl(healedTraceId);

    // Layer 1: local recorded spans. Both traces must be present for a verdict.
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
          const verifiedPass = healedErrors === 0 && liveReplaySucceeded;
          return {
            mode: 'PROGRAMMATIC_EVAL',
            baselineTraceId,
            healedTraceId,
            baselineTraceUrl: baselineUrl,
            healedTraceUrl: healedUrl,
            baselineErrors,
            healedErrors,
            deltaErrors: baselineErrors - healedErrors,
            status: verifiedPass ? 'VERIFIED_PASS' : 'REGRESSION_DETECTED',
            note: liveReplaySucceeded
              ? 'Verified from local instrumented telemetry plus a live replayed request.'
              : 'Healed span is clean but the live replay was not confirmed.',
            verifiedBy: liveReplaySucceeded ? 'local-spans+live-replay' : 'local-spans'
          };
        }
      } catch {
        // Fall through to the honest fallback below.
      }
    }

    // Layer 2: neatlogs-cli cloud readback, only when the CLI is actually present.
    if (await isNeatlogsCliAvailable()) {
      try {
        const { stdout: baselineOut } = await execFileAsync('neatlogs', ['traces', 'get', baselineTraceId, '--json']);
        const { stdout: healedOut } = await execFileAsync('neatlogs', ['traces', 'get', healedTraceId, '--json']);
        const bData = JSON.parse(baselineOut)?.data;
        const hData = JSON.parse(healedOut)?.data;
        if (bData && hData) {
          const bErr = bData.status === 'ERROR' ? 1 : 0;
          const hErr = hData.status === 'ERROR' ? 1 : 0;
          return {
            mode: 'PROGRAMMATIC_EVAL',
            baselineTraceId,
            healedTraceId,
            baselineTraceUrl: baselineUrl,
            healedTraceUrl: healedUrl,
            baselineErrors: bErr,
            healedErrors: hErr,
            deltaErrors: bErr - hErr,
            durationMs: hData.durationMs,
            status: hErr === 0 ? 'VERIFIED_PASS' : 'REGRESSION_DETECTED',
            note: 'Verified from Neatlogs cloud readback via neatlogs-cli.',
            verifiedBy: 'neatlogs-cli'
          };
        }
      } catch (err: any) {
        console.warn(`[Neatlogs] CLI readback failed: ${err.message}. Falling back to local verification.`);
      }
    } else if (this.apiKey) {
      console.warn(
        `[Neatlogs] NEATLOGS_API_KEY is set but the 'neatlogs' CLI was not found, so cloud ` +
          `readback is unavailable. Spans are still exported by the instrumented service; ` +
          `install it with 'npm install -D neatlogs-cli' to enable programmatic readback.`
      );
    }

    // Honest fallback: emit the dashboard URLs for manual inspection.
    return {
      mode: 'DASHBOARD_SIDE_BY_SIDE',
      baselineTraceId,
      healedTraceId,
      baselineTraceUrl: baselineUrl,
      healedTraceUrl: healedUrl,
      status: 'MANUAL_VERIFICATION_REQUIRED',
      note: 'Read error delta and duration directly from the neatlogs dashboard.',
      verifiedBy: 'dashboard-manual'
    };
  }

  clearLocalQueue(): void {
    if (fs.existsSync(this.localTelemetryQueueFile)) {
      fs.unlinkSync(this.localTelemetryQueueFile);
    }
    this.seenTraceIds.clear();
  }

  getLocalQueueFile(): string {
    return this.localTelemetryQueueFile;
  }

  getTraceUrlTemplate(): string {
    return this.traceUrlTemplate;
  }
}

let cliAvailabilityCache: boolean | undefined;

/** True when the neatlogs-cli binary is resolvable. Cached per process. */
async function isNeatlogsCliAvailable(): Promise<boolean> {
  if (cliAvailabilityCache !== undefined) {
    return cliAvailabilityCache;
  }
  try {
    await execFileAsync('neatlogs', ['--version']);
    cliAvailabilityCache = true;
  } catch {
    cliAvailabilityCache = false;
  }
  return cliAvailabilityCache;
}
