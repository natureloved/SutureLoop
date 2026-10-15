import { TelemetryService } from '../telemetry/neatlogs_client.js';
import { withHealingTrace, stageSpan, shutdownTracing } from '../telemetry/session_tracer.js';
import { CheckpointManager } from '../state/checkpoint_manager.js';
import { analyzeBlastRadius } from '../context/blast_radius.js';
import { RetryController } from '../synthesis/retry_controller.js';
import { calculateIncidentEconomics } from '../economics/unit_economics.js';
import { FailureSpan, SelfHealingSessionResult } from './types.js';
import { InvariantViolationError } from './errors.js';
import { Mutex } from './mutex.js';
import { assertValidTargetFile, assertMeasuredMetric, assertCleanWorktree } from './invariants.js';
import { GitHubPRClient } from '../github/pr_client.js';
import { config } from '../config/env.js';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the last measured run is recorded.
 *
 * `sutureloop model` used to print a hardcoded `$0.0007` "measured" cost that
 * never came from a run. The number is now written here by every completed
 * session and read back by that command, so the financial model is anchored to
 * a real measurement or says it has none.
 */
function measuredRunFile(): string {
  return path.resolve(process.cwd(), '.git', 'sutureloop', 'last-run.json');
}

export function persistMeasuredRun(run: {
  sessionId: string;
  measuredTokenCostUSD: number;
  durationMs: number;
}): void {
  const file = measuredRunFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ ...run, recordedAt: Date.now() }, null, 2),
      'utf-8'
    );
  } catch (err: any) {
    console.warn(`[SutureLoop] Could not persist measured run metrics: ${err.message}`);
  }
}

export function readMeasuredRun(): { sessionId: string; measuredTokenCostUSD: number; durationMs: number; recordedAt: number } | null {
  const file = measuredRunFile();
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export class SutureLoopOrchestrator {
  private telemetry: TelemetryService;
  private checkpointManager: CheckpointManager;
  private retryController: RetryController;

  /**
   * One remediation at a time.
   *
   * The CLI, watch mode and the server's `/api/v1/incidents/ingest` webhook can
   * all start sessions, and the webhook deliberately does not block its
   * response. Without this lock two sessions would snapshot, rewrite and roll
   * back the same file at once -- clobbering each other's checkpoints and
   * attributing a failing test to the wrong patch.
   */
  private sessionMutex = new Mutex();

  constructor() {
    this.telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);
    this.checkpointManager = new CheckpointManager();
    this.retryController = new RetryController(this.checkpointManager);
  }

  async run(customSpan?: FailureSpan, forceFault = false): Promise<SelfHealingSessionResult> {
    if (this.sessionMutex.pending) {
      console.log('[SutureLoop] Another remediation session is in progress; queueing this one.');
    }
    return this.sessionMutex.runExclusive(() => this.runExclusiveSession(customSpan, forceFault));
  }

  private async runExclusiveSession(customSpan?: FailureSpan, forceFault = false): Promise<SelfHealingSessionResult> {
    const startTime = Date.now();
    const sessionId = `suture_${Date.now()}`;

    console.log(`\n======================================================`);
    console.log(`🩺 SutureLoop: Autonomous Self-Healing Session [${sessionId}]`);
    console.log(`======================================================`);

    if (!this.telemetry.isCloudEnabled) {
      console.log(`[Neatlogs] No NEATLOGS_API_KEY configured: spans stay local and nothing is uploaded.`);
    }

    // The whole run is one neatlogs trace so the dashboard shows the agent's
    // reasoning chain. Tracing is fail-open: without the SDK or a key the
    // session still runs, it just is not exported.
    return withHealingTrace(
      {
        sessionId,
        apiKey: config.neatlogsApiKey,
        incidentTraceId: customSpan?.traceId,
        targetFile: customSpan?.filePath,
        targetFunction: customSpan?.name,
        attributes: { 'sutureloop.force_fault': forceFault }
      },
      async () => this.runSession(sessionId, customSpan, forceFault, startTime)
    ).finally(async () => {
      await shutdownTracing();
    });
  }

  private async runSession(
    sessionId: string,
    customSpan: FailureSpan | undefined,
    forceFault: boolean,
    startTime: number
  ): Promise<SelfHealingSessionResult> {
    // 1. Ingest Failure Telemetry
    console.log(`\n[Step 1] Ingesting telemetry from neatlogs...`);
    let span = customSpan || (await this.telemetry.getLatestFailureSpan());
    if (!span) {
      throw new InvariantViolationError('No unhandled failure span available for remediation.');
    }

    console.log(`  ✓ Failure Span Detected:`);
    console.log(`    - Trace ID : ${span.traceId}`);
    console.log(`    - Service  : ${span.service || 'billing-service'}`);
    console.log(`    - Error    : ${span.errorMessage}`);
    console.log(`    - Location : ${span.filePath}:${span.lineNumber}`);

    if (!span.filePath || typeof span.filePath !== 'string' || span.filePath.trim() === '') {
      throw new InvariantViolationError('Failure span is missing required filePath property.');
    }
    if (!span.lineNumber || typeof span.lineNumber !== 'number' || span.lineNumber <= 0) {
      throw new InvariantViolationError('Failure span is missing required positive lineNumber property.');
    }

    const targetFile = span.filePath;
    const targetLine = span.lineNumber;

    // Validate target file against boundary traversal, injection, and self-mutation
    assertValidTargetFile(targetFile);

    // 2. Pre-flight Check: Ensure the remediation target carries no uncommitted work
    // that an atomic rollback would destroy. Scoped to the target file only --
    // unrelated edits elsewhere in the repo must not block remediation.
    console.log(`\n[Step 2] Verifying remediation target is safe to mutate...`);
    assertCleanWorktree(targetFile);
    console.log(`  ✓ Target file is safe to mutate (no uncommitted work at risk).`);

    // 3. Resolve AST Blast Radius using Entire Graph
    console.log(`\n[Step 3] Analyzing AST Blast Radius with Entire Graph...`);
    const impact = await (await stageSpan('resolve-blast-radius', 'CHAIN', analyzeBlastRadius))(targetFile, targetLine);
    console.log(`  ✓ Target Function : ${impact.report.targetFunction}`);
    console.log(`  ✓ Direct Callers  : ${impact.report.callers.length}`);
    impact.report.callers.forEach((c) => {
      console.log(`    - ${c.filePath}:${c.lineNumber} (${c.functionName})`);
    });
    console.log(`  ✓ Resolution Method: ${impact.report.resolvedVia}`);
    if (impact.report.resolvedVia !== 'entire-graph') {
      console.warn(
        `  ! Callers above are UNVERIFIED (lexical scan, not an AST call graph). ` +
          `Install the 'entire' CLI for verified resolution.`
      );
    }

    // 4. Save Base Checkpoint & Execute Bounded Healing Loop
    console.log(`\n[Step 4] Starting Bounded Retry & Rollback Loop...`);
    const loopResult = await (
      await stageSpan('healing-loop', 'AGENT', () =>
        this.retryController.executeHealingLoop(
          targetFile,
          span,
          impact.report,
          forceFault,
          config.retryLimit
        )
      )
    )();

    // 5. Run Comparative Trace Evaluation
    console.log(`\n[Step 5] Running Comparative Trace Evaluation...`);
    let healedTraceId: string | undefined = undefined;
    let liveReplaySucceeded = false;

    if (loopResult.success) {
      // Re-issue the failing request against the running service to verify real resolution
      try {
        const replayRes = await fetch(`http://localhost:${config.port}/api/billing/invoice`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(span.rawAttributes?.payload || {})
        });
        if (replayRes.ok) {
          const replayData = (await replayRes.json()) as any;
          healedTraceId = replayData?.traceId;
          liveReplaySucceeded = true;
          console.log(`  ✓ Live Re-issue Succeeded: Service responded 200 OK (Trace: ${healedTraceId})`);
        } else {
          console.warn(`  ! Live re-issue returned HTTP ${replayRes.status}; verification will be downgraded.`);
        }
      } catch {
        // Live server not running or not reachable in standalone CLI mode
        console.warn(`  ! Live service not reachable; verification will be downgraded to telemetry-only.`);
      }
    }

    const evalResult = await (
      await stageSpan('comparative-eval', 'EVALUATOR', () =>
        this.telemetry.runComparativeEval(
          span.traceId,
          healedTraceId || `trace_unverified_${Date.now()}`,
          liveReplaySucceeded
        )
      )
    )();
    console.log(`  ✓ Evaluation Mode : ${evalResult.mode}`);
    console.log(`  ✓ Baseline Trace  : ${evalResult.baselineTraceUrl}`);
    console.log(`  ✓ Healed Trace    : ${evalResult.healedTraceUrl}`);
    if (evalResult.verifiedBy) {
      console.log(`  ✓ Verified By     : ${evalResult.verifiedBy}`);
    }
    if (evalResult.mode === 'PROGRAMMATIC_EVAL') {
      console.log(`  ✓ Errors Delta    : ${evalResult.baselineErrors} -> ${evalResult.healedErrors} (${evalResult.status})`);
    } else {
      console.log(`  ✓ Status          : ${evalResult.status} (${evalResult.note || 'Manual camera inspection'})`);
    }

    // 6. Calculate Unit Economics
    console.log(`\n[Step 6] Computing Unit Economics for cfo.ai...`);
    const econ = calculateIncidentEconomics({
      measuredTokenCostUSD: loopResult.totalTokenCostUSD,
      mttrMinutesSaved: config.defaultIncidentMttrMinutes,
      hourlyEngineerRateUSD: config.defaultEngineerHourlyRate
    });

    console.log(`  ✓ Measured Token Cost    : $${econ.measuredTokenCostUSD}`);
    console.log(`  ✓ MTTR Hours Saved       : $${econ.mttrHoursSaved} hrs`);
    console.log(`  ✓ Gross Value Created    : $${econ.grossSavingsUSD}`);
    console.log(`  ✓ Net Value per Incident : $${econ.netSavingsUSD}`);
    console.log(`  ✓ Gross Margin           : $${econ.grossMarginPercent}%`);

    // Persist this run's measured figures so `sutureloop model` reports what
    // was actually measured instead of a hardcoded constant.
    persistMeasuredRun({
      sessionId,
      measuredTokenCostUSD: econ.measuredTokenCostUSD,
      durationMs: Date.now() - startTime
    });

    // 7. Automated Production Pull Request (if enabled / GITHUB_TOKEN set)
    if (loopResult.success) {
      try {
        const prClient = new GitHubPRClient();
        await prClient.createRemediationPullRequest({
          sessionId,
          incidentTraceId: span.traceId,
          healedTraceId,
          targetFile,
          targetFunction: impact.report.targetFunction,
          economicMetrics: econ,
          baselineTraceUrl: evalResult.baselineTraceUrl,
          healedTraceUrl: evalResult.healedTraceUrl
        });
      } catch (prErr: any) {
        console.warn(`[GitHub Notice] ${prErr.message}`);
      }
    }

    const totalDuration = Date.now() - startTime;
    assertMeasuredMetric('durationMs', totalDuration);
    assertMeasuredMetric('measuredTokenCostUSD', econ.measuredTokenCostUSD);
    console.log(`\n✅ Session Complete in ${totalDuration}ms. Status: ${loopResult.success ? 'HEALED' : 'FAILED'}\n`);

    return {
      sessionId,
      incidentTraceId: span.traceId,
      healedTraceId,
      targetFile,
      targetFunction: impact.report.targetFunction,
      blastRadius: impact.report,
      checkpointId: loopResult.checkpointId,
      attempts: loopResult.attempts,
      evalResult,
      economicMetrics: econ,
      durationMs: totalDuration,
      finalStatus: loopResult.success ? 'HEALED' : 'FAILED'
    };
  }
}
