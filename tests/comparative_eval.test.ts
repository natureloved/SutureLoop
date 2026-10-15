import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../src/telemetry/neatlogs_client.js';
import * as fs from 'fs';
import * as path from 'path';

const queueFile = path.resolve('.neatlogs_local_spans.json');

describe('comparative evaluation verdicts', () => {
  let telemetry: TelemetryService;
  let backup: string | null = null;

  beforeEach(() => {
    backup = fs.existsSync(queueFile) ? fs.readFileSync(queueFile, 'utf-8') : null;
    fs.rmSync(queueFile, { force: true });
    telemetry = new TelemetryService();
  });

  afterEach(() => {
    if (backup === null) fs.rmSync(queueFile, { force: true });
    else fs.writeFileSync(queueFile, backup, 'utf-8');
  });

  const record = (traceId: string, errorMessage: string) =>
    telemetry.recordLocalFailureSpan({ traceId, errorMessage, timestamp: Date.now() });

  it('reports VERIFIED_PASS only with a clean healed span AND a live replay', async () => {
    await record('trace_bad', "TypeError: Cannot read properties of undefined (reading 'address')");
    await record('trace_good', '');

    const result = await telemetry.runComparativeEval('trace_bad', 'trace_good', true);

    expect(result.status).toBe('VERIFIED_PASS');
    expect(result.baselineErrors).toBe(1);
    expect(result.healedErrors).toBe(0);
    expect(result.deltaErrors).toBe(1);
    expect(result.verifiedBy).toBe('local-spans+live-replay');
  });

  it('does not call an unverified clean heal a regression', async () => {
    // CLI `auto-heal` with no service listening: the healed span is clean but
    // no live replay happened. Nothing regressed -- the verdict is incomplete.
    await record('trace_bad', "TypeError: Cannot read properties of undefined (reading 'address')");
    await record('trace_good', '');

    const result = await telemetry.runComparativeEval('trace_bad', 'trace_good', false);

    expect(result.status).toBe('VERIFICATION_INCOMPLETE');
    expect(result.status).not.toBe('REGRESSION_DETECTED');
    expect(result.verifiedBy).toBe('local-spans');
  });

  it('reports REGRESSION_DETECTED when the healed trace still errors', async () => {
    await record('trace_bad', 'TypeError');
    await record('trace_still_bad', 'TypeError');

    const result = await telemetry.runComparativeEval('trace_bad', 'trace_still_bad', true);

    expect(result.status).toBe('REGRESSION_DETECTED');
  });

  it('counts baseline errors from the recorded spans rather than assuming one', async () => {
    await record('trace_bad', 'TypeError');
    await record('trace_bad', 'TypeError');
    await record('trace_good', '');

    const result = await telemetry.runComparativeEval('trace_bad', 'trace_good', true);

    expect(result.baselineErrors).toBe(2);
    expect(result.deltaErrors).toBe(2);
  });

  it('falls back to manual verification when the healed trace is absent', async () => {
    await record('trace_bad', 'TypeError');

    const result = await telemetry.runComparativeEval('trace_bad', 'trace_never_seen', true);

    expect(result.mode).toBe('DASHBOARD_SIDE_BY_SIDE');
    expect(result.status).toBe('MANUAL_VERIFICATION_REQUIRED');
  });
});