/**
 * neatlogs session tracing for a SutureLoop healing run.
 *
 * Wraps each pipeline stage in a `neatlogs.span()` so a single trace in the
 * neatlogs dashboard shows the agent's whole reasoning chain:
 *
 *   sutureloop-heal (WORKFLOW)
 *     ├─ ingest-failure-span        (CHAIN)
 *     ├─ resolve-blast-radius       (CHAIN)
 *     ├─ healing-loop               (AGENT)
 *     │    ├─ attempt-1-synthesis   (CHAIN)
 *     │    ├─ rollback              (TOOL)
 *     │    └─ attempt-2-synthesis   (CHAIN)
 *     ├─ comparative-eval           (EVALUATOR)
 *     └─ unit-economics             (CHAIN)
 *
 * Design constraints:
 *  - The SDK is loaded dynamically so this module never hard-depends on
 *    neatlogs being installed, and so `import` cost is paid only when tracing
 *    is actually used.
 *  - Every span is fail-open. Telemetry must never break the agent: if the SDK
 *    is missing, init fails, or export is disabled, the wrapped function still
 *    runs and the session still completes.
 *  - When no NEATLOGS_API_KEY is configured the SDK runs with
 *    `disableExport: true`, so nothing leaves the machine. The trace is then
 *    only visible locally and the dashboard URL is a link, not a claim.
 */
type SpanFn<T> = (span: any) => T | Promise<T>;

interface NeatlogsModule {
  init: (options?: Record<string, unknown>) => Promise<void>;
  trace: <T>(options: Record<string, unknown>, fn: SpanFn<T>) => Promise<T>;
  span: <TArgs extends unknown[], TReturn>(
    options: Record<string, unknown>,
    fn: (...args: TArgs) => TReturn
  ) => (...args: TArgs) => TReturn;
  flush: () => Promise<boolean>;
  shutdown: (reason?: string, timeoutMs?: number) => Promise<boolean>;
}

let modulePromise: Promise<NeatlogsModule | null> | null = null;
/**
 * The key the SDK was initialised with. `neatlogs.init` is process-global and
 * was previously called only once, so a process whose first run had no API key
 * stayed pinned to `disableExport: true` and silently dropped telemetry for
 * every later run, even after a key became available.
 */
let initializedWithKey: string | null | undefined;

/** Lazily import the neatlogs SDK. Returns null when it is not installed. */
function loadSdk(): Promise<NeatlogsModule | null> {
  if (!modulePromise) {
    modulePromise = import('neatlogs')
      .then((mod: any) => {
        const sdk = (mod?.default ?? mod) as NeatlogsModule;
        if (typeof sdk?.trace !== 'function') {
          console.warn('[Neatlogs] SDK loaded but exposes no trace(); tracing disabled.');
          return null;
        }
        return sdk;
      })
      .catch((err: any) => {
        console.warn(`[Neatlogs] SDK unavailable (${err?.message || err}); tracing disabled.`);
        return null;
      });
  }
  return modulePromise;
}

export interface TracingOptions {
  /** Session id, used as the neatlogs sessionId so the trace is addressable. */
  sessionId: string;
  /** neatlogs API key. When absent, export is disabled and nothing leaves the host. */
  apiKey?: string;
  /** Incident being remediated. */
  incidentTraceId?: string;
  targetFile?: string;
  targetFunction?: string;
  /** Extra attributes stamped on the root span. */
  attributes?: Record<string, unknown>;
}

/**
 * Runs `fn` inside a neatlogs trace covering the whole healing session.
 *
 * Always resolves to `fn`'s result. Tracing failures are logged and ignored --
 * the agent must never be blocked by telemetry.
 */
export async function withHealingTrace<T>(
  options: TracingOptions,
  fn: () => Promise<T>
): Promise<T> {
  const sdk = await loadSdk();
  if (!sdk) {
    return fn();
  }

  const apiKey = options.apiKey ?? process.env.NEATLOGS_API_KEY ?? null;
  if (initializedWithKey !== apiKey) {
    try {
      await sdk.init({
        apiKey: apiKey ?? undefined,
        workflowName: 'sutureloop-autonomous-healer',
        // Without a key, keep spans local so the demo never silently uploads.
        disableExport: !apiKey
      });
      initializedWithKey = apiKey;
    } catch (err: any) {
      // Leave initializedWithKey unset so the next run retries init.
      console.warn(`[Neatlogs] init() failed (${err?.message || err}); continuing without cloud export.`);
    }
  }

  try {
    return await sdk.trace(
      {
        name: 'sutureloop-heal',
        kind: 'WORKFLOW',
        sessionId: options.sessionId,
        input: {
          incidentTraceId: options.incidentTraceId,
          targetFile: options.targetFile,
          targetFunction: options.targetFunction
        },
        attributes: {
          'sutureloop.session_id': options.sessionId,
          'sutureloop.incident_trace_id': options.incidentTraceId ?? '',
          'sutureloop.target_file': options.targetFile ?? '',
          'sutureloop.target_function': options.targetFunction ?? '',
          ...(options.attributes ?? {})
        }
      },
      fn
    );
  } finally {
    // Flush so the trace is visible in the dashboard as soon as the run ends.
    try {
      await sdk.flush();
    } catch {
      // Flushing is best-effort.
    }
  }
}

/**
 * Wraps one pipeline stage in a neatlogs span nested under the active trace.
 *
 * Returns the original function when the SDK is unavailable or when no trace is
 * active, so callers can use it unconditionally.
 */
export async function stageSpan<TArgs extends unknown[], TReturn>(
  name: string,
  kind: 'CHAIN' | 'AGENT' | 'TOOL' | 'EVALUATOR',
  fn: (...args: TArgs) => TReturn,
  attributes: Record<string, unknown> = {}
): Promise<(...args: TArgs) => TReturn> {
  const sdk = await loadSdk();
  if (!sdk || typeof sdk.span !== 'function') {
    return fn;
  }
  try {
    return sdk.span({ name, kind, attributes }, fn);
  } catch {
    return fn;
  }
}

/** Best-effort shutdown, for CLI exit paths. */
export async function shutdownTracing(): Promise<void> {
  const sdk = await loadSdk();
  if (!sdk) return;
  try {
    await sdk.shutdown('sutureloop-session-complete', 2000);
  } catch {
    // Shutdown is best-effort.
  }
}
