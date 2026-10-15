import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { CheckpointManager } from '../state/checkpoint_manager.js';
import { PatchGenerator } from './patch_generator.js';
import { TestSynthesizer } from './test_synthesizer.js';
import { PatchSynthesisFailed } from '../core/errors.js';
import { config } from '../config/env.js';
import { SynthesisMode } from '../economics/measurements.js';
import { FailureSpan, BlastRadiusReport, PatchAttemptResult } from '../core/types.js';

const execFileAsync = promisify(execFile);

export interface HealingLoopResult {
  attempts: PatchAttemptResult[];
  totalTokenCostUSD: number;
  success: boolean;
  /** Real id of the checkpoint that captured the healed state (or baseline). */
  checkpointId: string;
  /**
   * Whether this session spent LLM tokens. A session is 'llm' if *any* attempt
   * went through a provider; the offline transformer spends none.
   */
  synthesisMode: SynthesisMode;
}

export class RetryController {
  private checkpointManager: CheckpointManager;
  private reproTestPath: string | null = null;

  constructor(checkpointManager: CheckpointManager) {
    this.checkpointManager = checkpointManager;
  }

  /**
   * Runs the synthesized regression suite with Vitest.
   *
   * Uses an argument array (no shell) and a hard timeout: a test run that hangs
   * must not be able to hang the autonomous loop, because the bounded-retry
   * guarantee is only real if a stuck attempt still returns.
   */
  async runTests(testPath?: string): Promise<{ passed: boolean; output: string }> {
    const target = testPath || this.reproTestPath;
    if (!target) {
      return {
        passed: false,
        output: 'No reproduction test was synthesized for this incident; refusing to report a pass.'
      };
    }
    if (!fs.existsSync(target)) {
      return { passed: false, output: `Reproduction test ${target} is missing; cannot verify the patch.` };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        'npx',
        ['vitest', 'run', target, '--no-color'],
        {
          timeout: config.regressionTestTimeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          cwd: process.cwd()
        }
      );
      return {
        passed: true,
        output: (stdout + '\n' + stderr).trim()
      };
    } catch (err: any) {
      const reason = err.killed || err.signal === 'SIGTERM'
        ? `Test run exceeded ${config.regressionTestTimeoutMs}ms and was terminated.`
        : '';
      return {
        passed: false,
        output: [reason, (err.stdout || '') + '\n' + (err.stderr || err.message)].filter(Boolean).join('\n')
      };
    }
  }

  /**
   * Execute the bounded healing loop.
   *
   * Attempt 1 uses whatever strategy the blast radius supports (trace-blind
   * when forced or when there is no caller context, informed otherwise).
   * Attempts 2..retryLimit always get full AST + trace context.
   */
  async executeHealingLoop(
    targetFile: string,
    span: FailureSpan,
    blastRadius: BlastRadiusReport,
    forceFault = false,
    retryLimit = config.retryLimit
  ): Promise<HealingLoopResult> {
    const attempts: PatchAttemptResult[] = [];
    let totalTokenCostUSD = 0;
    let synthesisMode: SynthesisMode = 'offline-transformer';

    // Normalise the budget: NaN from a malformed RETRY_LIMIT must not silently
    // become "unbounded" or "zero". At least one attempt always runs.
    const parsedLimit = Number.isFinite(retryLimit) ? Math.floor(retryLimit) : 2;
    const maxAttempts = Math.max(1, parsedLimit);
    let checkpointId = '';

    // Step 1: Synthesize the reproduction test from the actual incident.
    const synthesized = TestSynthesizer.generateReproductionTest(span);
    this.reproTestPath = synthesized?.filePath ?? null;
    if (this.reproTestPath) {
      console.log(
        `[RetryController] Synthesized regression test ${this.reproTestPath} ` +
          `for ${synthesized!.functionName}() imported from ${synthesized!.importSpecifier}.`
      );
    } else {
      console.warn(
        '[RetryController] No reproduction test could be synthesized from this span; ' +
          'the loop will report FAILED rather than claim an unverified pass.'
      );
    }

    // Step 2: Baseline checkpoint scoped to the target file.
    const initialCheckpoint = await this.checkpointManager.save('baseline-pre-heal', targetFile);
    checkpointId = initialCheckpoint;
    console.log(`[RetryController] Initial state saved to checkpoint: ${initialCheckpoint} (fenced to: ${targetFile})`);

    const hasRegressionSuite = Boolean(this.reproTestPath);

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const isFirst = attempt === 1;
        console.log(`\n================== ATTEMPT ${attempt} ==================`);
        console.log(
          isFirst
            ? `[RetryController] Attempt 1: synthesis strategy selected from blast radius ` +
                `(${blastRadius.callers.length} caller(s), forceFault=${forceFault})...`
            : `[RetryController] Attempt ${attempt}: full context synthesis (stack trace + AST blast radius)...`
        );

        let patch;
        try {
          patch = await PatchGenerator.generatePatch(targetFile, span, blastRadius, attempt, forceFault);
        } catch (err: any) {
          if (err instanceof PatchSynthesisFailed) {
            attempts.push({
              attempt,
              blindPrompt: isFirst,
              patchApplied: false,
              testPassed: false,
              rollbackOccurred: false,
              testOutput: `Synthesis failed: ${err.message}`,
              error: err.message
            });
            console.warn(`[RetryController] Attempt ${attempt} synthesis failed: ${err.message}`);
            await this.checkpointManager.restore(initialCheckpoint, targetFile);
            await this.checkpointManager.clearAppliedPatch(targetFile);
            await this.checkpointManager.pruneAll();
            return { attempts, totalTokenCostUSD, success: false, checkpointId: initialCheckpoint, synthesisMode };
          }
          throw err;
        }
        totalTokenCostUSD += patch.costUSD;
        if (patch.synthesisMode === 'llm') synthesisMode = 'llm';

        // Apply patch.
        fs.writeFileSync(path.resolve(targetFile), patch.patchCode, 'utf-8');
        console.log(`[RetryController] Applied Attempt ${attempt} patch.`);

        // Run the regression suite (or report honestly that there is none).
        const test = await this.runTests();
        const attemptPassed = hasRegressionSuite && test.passed;
        console.log(`[RetryController] Attempt ${attempt} test result: ${attemptPassed ? 'PASSED' : 'FAILED'}`);

        let rollbackTime = 0;
        if (!attemptPassed) {
          console.log(
            `[RetryController] Attempt ${attempt} did not satisfy the regression suite: ` +
              `triggering atomic rollback via scoped checkpoint...`
          );
          rollbackTime = await this.checkpointManager.restore(initialCheckpoint, targetFile);
          await this.checkpointManager.clearAppliedPatch(targetFile);

          const isClean = await this.checkpointManager.isTreePristine(targetFile);
          console.log(`[RetryController] Verification: Target file pristine? ${isClean}`);
        }

        attempts.push({
          attempt,
          blindPrompt: isFirst && (forceFault || blastRadius.callers.length === 0),
          patchApplied: true,
          testPassed: attemptPassed,
          rollbackOccurred: !attemptPassed,
          rollbackDurationMs: rollbackTime,
          testOutput: test.output,
          patchDiff: patch.patchCode
        });

        if (attemptPassed) {
          // A fix that satisfies every regression case needs no further pass --
          // stop rather than burning another synthesis for theatre.
          console.log(`[RetryController] Attempt ${attempt} satisfied all regression cases; no further synthesis needed.`);
          // Record the patch as agent-authored so a later session can tell it
          // apart from a developer's uncommitted work (see state/applied_patches.ts).
          this.checkpointManager.recordAppliedPatch(targetFile, patch.patchCode);
          const healedCheckpoint = await this.checkpointManager.save('healed-verified', targetFile);
          checkpointId = healedCheckpoint;
          console.log(`[RetryController] Healed state captured as checkpoint: ${healedCheckpoint}`);
          await this.checkpointManager.pruneAll();
          return { attempts, totalTokenCostUSD, success: true, checkpointId: healedCheckpoint, synthesisMode };
        }

        if (attempt < maxAttempts) {
          console.log(`[RetryController] Rolling back before the next attempt...`);
        }
      }

      // Attempt budget exhausted: report the failure honestly, tree at baseline.
      console.log(
        `[RetryController] retryLimit=${maxAttempts}: attempt budget exhausted ` +
          `with no passing regression suite.`
      );
      await this.checkpointManager.restore(initialCheckpoint, targetFile);
      await this.checkpointManager.clearAppliedPatch(targetFile);
      await this.checkpointManager.pruneAll();
      return { attempts, totalTokenCostUSD, success: false, checkpointId: initialCheckpoint, synthesisMode };
    } catch (err: any) {
      // Guarantee rollback on unhandled synthesis exceptions.
      console.error(`[RetryController] Unhandled error during healing: ${err.message}. Performing emergency rollback...`);
      try {
        await this.checkpointManager.restore(initialCheckpoint, targetFile);
        await this.checkpointManager.clearAppliedPatch(targetFile);
      } catch (restoreErr: any) {
        console.error(`[Emergency Rollback Error] ${restoreErr.message}`);
      }
      await this.checkpointManager.pruneAll();
      throw err;
    } finally {
      // Clean up ephemeral reproduction test if present.
      if (this.reproTestPath && fs.existsSync(this.reproTestPath)) {
        try { fs.unlinkSync(this.reproTestPath); } catch {}
      }
      this.reproTestPath = null;
    }
  }
}