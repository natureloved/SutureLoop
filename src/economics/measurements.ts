import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * How a remediation's cost was actually incurred.
 *
 * This distinction matters more than the number itself. A session synthesised
 * by the local AST-guided transformer spends no LLM tokens at all, so its cost
 * is roughly two orders of magnitude below a session backed by a real provider.
 * Quoting either figure as "cost per fix" without saying which produced it
 * would be the kind of number this project refuses to publish.
 */
export type SynthesisMode = 'llm' | 'offline-transformer';

export interface Measurement {
  sessionId: string;
  measuredTokenCostUSD: number;
  durationMs: number;
  mode: SynthesisMode;
  /** Short commit SHA at the time of the run, when available. */
  commit?: string;
  recordedAt: number;
}

export interface MeasurementSummary {
  count: number;
  medianUSD: number;
  p95USD: number;
  minUSD: number;
  maxUSD: number;
  byMode: Record<SynthesisMode, number>;
  firstRecordedAt: number;
  lastRecordedAt: number;
  lastCommit?: string;
}

/** Keeps the ledger bounded; a long watch-mode host would otherwise grow forever. */
const MAX_MEASUREMENTS = 200;

function ledgerFile(): string {
  return path.resolve(process.cwd(), '.git', 'sutureloop', 'measurements.json');
}

/**
 * Appends one session's measured figures.
 *
 * Kept under `.git/` so the ledger never becomes project state that a future
 * reader mistakes for current. A committed measurement file goes stale the
 * moment the code changes; this one is local and obviously so.
 */
export function recordMeasurement(
  entry: Omit<Measurement, 'recordedAt' | 'commit'> & { commit?: string }
): Measurement {
  const measurement: Measurement = {
    sessionId: entry.sessionId,
    measuredTokenCostUSD: entry.measuredTokenCostUSD,
    durationMs: entry.durationMs,
    mode: entry.mode,
    commit: entry.commit ?? currentCommit(),
    recordedAt: Date.now()
  };

  const existing = readMeasurements();
  const merged = [...existing, measurement].slice(-MAX_MEASUREMENTS);
  writeMeasurements(merged);
  return measurement;
}

export function readMeasurements(): Measurement[] {
  try {
    const file = ledgerFile();
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as Measurement[]) : [];
  } catch {
    return [];
  }
}

export function writeMeasurements(measurements: Measurement[]): void {
  const file = ledgerFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(measurements, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn(`[Measurements] Could not write ledger: ${err.message}`);
  }
}

export function clearMeasurements(): void {
  try {
    fs.rmSync(ledgerFile(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

function currentCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    // Not a git checkout, or git unavailable: provenance is best-effort.
    return undefined;
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (sortedAsc.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAsc[low];
  return sortedAsc[low] + (sortedAsc[high] - sortedAsc[low]) * (rank - low);
}

/**
 * Summarises the ledger across every recorded session.
 *
 * Median rather than mean: a single expensive LLM-backed run inside a set of
 * cheap offline ones should not redefine the typical cost, and the mean would
 * quietly do exactly that.
 */
export function summarizeMeasurements(measurements: Measurement[]): MeasurementSummary | null {
  const usable = measurements.filter(
    (m) => Number.isFinite(m.measuredTokenCostUSD) && m.measuredTokenCostUSD >= 0
  );
  if (usable.length === 0) return null;

  const costs = usable.map((m) => m.measuredTokenCostUSD).sort((a, b) => a - b);
  const byMode: Record<SynthesisMode, number> = { llm: 0, 'offline-transformer': 0 };
  for (const m of usable) {
    byMode[m.mode === 'llm' ? 'llm' : 'offline-transformer'] += 1;
  }

  return {
    count: usable.length,
    medianUSD: percentile(costs, 0.5),
    p95USD: percentile(costs, 0.95),
    minUSD: costs[0],
    maxUSD: costs[costs.length - 1],
    byMode,
    firstRecordedAt: usable[0].recordedAt,
    lastRecordedAt: usable[usable.length - 1].recordedAt,
    lastCommit: usable[usable.length - 1].commit
  };
}

/** One-line description of what the recorded figures do and do not cover. */
export function describeBasis(summary: MeasurementSummary): string {
  const parts: string[] = [];
  if (summary.byMode['offline-transformer'] > 0) {
    parts.push(
      `${summary.byMode['offline-transformer']} offline-transformer session(s) ` +
        `(local AST-guided rewrite, no LLM tokens)`
    );
  }
  if (summary.byMode.llm > 0) {
    parts.push(`${summary.byMode.llm} LLM-backed session(s)`);
  }
  if (summary.byMode.llm === 0) {
    parts.push(
      'No LLM-backed session is on record, so this figure excludes provider token cost entirely.'
    );
  }
  return parts.join('; ');
}