import { TelemetryService } from '../telemetry/neatlogs_client.js';
import { CheckpointManager } from '../state/checkpoint_manager.js';
import { GitSandbox } from '../state/git_sandbox.js';
import { analyzeBlastRadius } from '../context/blast_radius.js';
import { RetryController } from '../synthesis/retry_controller.js';
import { calculateIncidentEconomics, generateBusinessModel } from '../economics/unit_economics.js';
import { FailureSpan, SelfHealingSessionResult } from './types.js';
import { InvariantViolationError } from './errors.js';
import { config } from '../config/env.js';

export class SutureLoopOrchestrator {
  private telemetry: TelemetryService;
  private checkpointManager: CheckpointManager;
  private retryController: RetryController;

  constructor() {
    this.telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);
    this.checkpointManager = new CheckpointManager();
    this.retryController = new RetryController(this.checkpointManager);
  }

  async run(customSpan?: FailureSpan, forceFault = false): Promise<SelfHealingSessionResult> {
    const startTime = Date.now();
    const sessionId = `suture_${Date.now()}`;

    console.log(`\n======================================================`);
    console.log(`🩺 SutureLoop: Autonomous Self-Healing Session [${sessionId}]`);
    console.log(`======================================================`);

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

    const targetFile = span.filePath || 'demo/service/routes/billing.ts';
    const targetLine = span.lineNumber || 16;

    // 2. Pre-flight Check: Ensure Worktree is Pristine
    console.log(`\n[Step 2] Verifying Git worktree cleanliness...`);
    const isPristine = await GitSandbox.isPristine('demo');
    if (!isPristine) {
      console.warn(`  ⚠ Warning: Workspace has uncommitted changes. Proceeding within demo/ sandbox.`);
    } else {
      console.log(`  ✓ Worktree is verified clean.`);
    }

    // 3. Resolve AST Blast Radius using Entire Graph
    console.log(`\n[Step 3] Analyzing AST Blast Radius with Entire Graph...`);
    const impact = await analyzeBlastRadius(targetFile, targetLine);
    console.log(`  ✓ Target Function : ${impact.report.targetFunction}`);
    console.log(`  ✓ Direct Callers  : ${impact.report.callers.length}`);
    impact.report.callers.forEach((c) => {
      console.log(`    - ${c.filePath}:${c.lineNumber} (${c.functionName})`);
    });
    console.log(`  ✓ Resolution Method: ${impact.report.resolvedVia}`);

    // 4. Save Base Checkpoint & Execute Bounded Healing Loop
    console.log(`\n[Step 4] Starting Bounded Retry & Rollback Loop...`);
    const loopResult = await this.retryController.executeHealingLoop(
      targetFile,
      span,
      impact.report,
      forceFault
    );

    // 5. Run Comparative Trace Evaluation
    console.log(`\n[Step 5] Running Comparative Trace Evaluation...`);
    const healedTraceId = `trace_healed_${Date.now()}`;
    const evalResult = await this.telemetry.runComparativeEval(span.traceId, healedTraceId);
    console.log(`  ✓ Evaluation Mode : ${evalResult.mode}`);
    console.log(`  ✓ Baseline Trace  : ${evalResult.baselineTraceUrl}`);
    console.log(`  ✓ Healed Trace    : ${evalResult.healedTraceUrl}`);
    if (evalResult.mode === 'PROGRAMMATIC_EVAL') {
      console.log(`  ✓ Errors Delta    : ${evalResult.baselineErrors} -> ${evalResult.healedErrors} (${evalResult.status})`);
    }

    // 6. Calculate Unit Economics
    console.log(`\n[Step 6] Computing Unit Economics for cfo.ai...`);
    const econ = calculateIncidentEconomics({
      measuredTokenCostUSD: loopResult.totalTokenCostUSD,
      mttrMinutesSaved: config.defaultIncidentMttrMinutes,
      hourlyEngineerRateUSD: config.defaultEngineerHourlyRate
    });

    console.log(`  ✓ Measured Token Cost    : $${econ.measuredTokenCostUSD}`);
    console.log(`  ✓ MTTR Hours Saved       : ${econ.mttrHoursSaved} hrs`);
    console.log(`  ✓ Gross Value Created    : $${econ.grossSavingsUSD}`);
    console.log(`  ✓ Net Value per Incident : $${econ.netSavingsUSD}`);
    console.log(`  ✓ Gross Margin           : ${econ.grossMarginPercent}%`);

    const totalDuration = Date.now() - startTime;
    console.log(`\n✅ Session Complete in ${totalDuration}ms. Status: ${loopResult.success ? 'HEALED' : 'FAILED'}\n`);

    return {
      sessionId,
      incidentTraceId: span.traceId,
      healedTraceId,
      targetFile,
      targetFunction: impact.report.targetFunction,
      blastRadius: impact.report,
      checkpointId: 'cp_latest',
      attempts: loopResult.attempts,
      evalResult,
      economicMetrics: econ,
      durationMs: totalDuration,
      finalStatus: loopResult.success ? 'HEALED' : 'FAILED'
    };
  }
}
