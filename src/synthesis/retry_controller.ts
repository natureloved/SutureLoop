import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { CheckpointManager } from '../state/checkpoint_manager.js';
import { PatchGenerator } from './patch_generator.js';
import { TestSynthesizer } from './test_synthesizer.js';
import { FailureSpan, BlastRadiusReport, PatchAttemptResult } from '../core/types.js';

const execAsync = promisify(exec);

export class RetryController {
  private checkpointManager: CheckpointManager;

  constructor(checkpointManager: CheckpointManager) {
    this.checkpointManager = checkpointManager;
  }

  /**
   * Run the test suite using Vitest.
   */
  async runTests(): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await execAsync('npx vitest run demo/tests/reproduction.test.ts --no-color');
      return {
        passed: true,
        output: (stdout + '\n' + stderr).trim()
      };
    } catch (err: any) {
      return {
        passed: false,
        output: (err.stdout || '') + '\n' + (err.stderr || err.message)
      };
    }
  }

  /**
   * Execute the bounded healing loop:
   * Attempt 1 (Naive / Fault) -> Fail -> Rollback -> Verify Pristine
   * Attempt 2 (Informed) -> Pass -> Checkpoint
   */
  async executeHealingLoop(
    targetFile: string,
    span: FailureSpan,
    blastRadius: BlastRadiusReport,
    forceFault = false,
    retryLimit = 2
  ): Promise<{ attempts: PatchAttemptResult[]; totalTokenCostUSD: number; success: boolean }> {
    const attempts: PatchAttemptResult[] = [];
    let totalTokenCostUSD = 0;
    // The loop is bounded by retryLimit (>= 1). Attempt 1 is always the
    // trace-blind pass; every attempt after it gets full AST + trace context.
    const maxAttempts = Math.max(1, Math.floor(retryLimit));

    // Step 1: Synthesize reproduction test
    console.log(`[RetryController] Synthesizing reproduction test in demo/tests/reproduction.test.ts...`);
    TestSynthesizer.generateReproductionTest(span);

    // Save baseline checkpoint with targetFile snapshot before touching code
    const initialCheckpoint = await this.checkpointManager.save('baseline-pre-heal', targetFile);
    console.log(`[RetryController] Initial state saved to checkpoint: ${initialCheckpoint} (fenced to: ${targetFile})`);

    try {
      // --- ATTEMPT 1: Trace-blind synthesis ---
      console.log(`\n================== ATTEMPT 1 ==================`);
      console.log(`[RetryController] Attempt 1: Trace-blind synthesis (stack trace only, no caller context)...`);
      const patch1 = await PatchGenerator.generatePatch(targetFile, span, blastRadius, 1, forceFault);
      totalTokenCostUSD += patch1.costUSD;

      // Apply patch 1
      fs.writeFileSync(path.resolve(targetFile), patch1.patchCode, 'utf-8');
      console.log(`[RetryController] Applied Attempt 1 patch.`);

      // Run tests
      const test1 = await this.runTests();
      const attempt1Passed = test1.passed;
      console.log(`[RetryController] Attempt 1 test result: ${attempt1Passed ? 'PASSED' : 'FAILED'}`);

      let rollbackTime1 = 0;
      if (!attempt1Passed) {
        console.log(`[RetryController] Attempt 1 was incomplete: triggering atomic rollback via scoped checkpoint...`);
        rollbackTime1 = await this.checkpointManager.restore(initialCheckpoint, targetFile);

        const isClean = await this.checkpointManager.isTreePristine(targetFile);
        console.log(`[RetryController] Verification: Target file pristine? ${isClean}`);
      }

      attempts.push({
        attempt: 1,
        blindPrompt: true,
        patchApplied: true,
        testPassed: attempt1Passed,
        rollbackOccurred: !attempt1Passed,
        rollbackDurationMs: rollbackTime1,
        testOutput: test1.output,
        patchDiff: patch1.patchCode
      });

      if (attempt1Passed) {
        // A trace-blind fix that passes every regression case needs no second
        // pass -- stop rather than burning a second synthesis for theatre.
        console.log(`[RetryController] Attempt 1 satisfied all regression cases; no further synthesis needed.`);
        await this.checkpointManager.pruneAll();
        return { attempts, totalTokenCostUSD, success: true };
      }

      // Honour the configured attempt budget. retryLimit = 1 means "one shot":
      // no context-informed retry, so the failure is reported honestly.
      if (maxAttempts < 2) {
        console.log(`[RetryController] retryLimit=${maxAttempts}: attempt budget exhausted, no context-informed retry.`);
        await this.checkpointManager.restore(initialCheckpoint, targetFile);
        await this.checkpointManager.pruneAll();
        return { attempts, totalTokenCostUSD, success: false };
      }

      // --- ATTEMPT 2: Full context + AST repair ---
      console.log(`\n================== ATTEMPT 2 ==================`);
      console.log(`[RetryController] Attempt 2: Full context synthesis (Stack trace + AST blast radius)...`);
      const patch2 = await PatchGenerator.generatePatch(targetFile, span, blastRadius, 2, false);
      totalTokenCostUSD += patch2.costUSD;

      // Apply patch 2
      fs.writeFileSync(path.resolve(targetFile), patch2.patchCode, 'utf-8');
      console.log(`[RetryController] Applied Attempt 2 patch.`);

      // Ensure reproduction test exists
      TestSynthesizer.generateReproductionTest(span);

      // Run tests again
      const test2 = await this.runTests();
      console.log(`[RetryController] Attempt 2 test result: ${test2.passed ? 'PASSED ✅' : 'FAILED ❌'}`);
      if (!test2.passed) {
        console.log(`[RetryController] Attempt 2 test failure output:\n${test2.output}`);
      }

      attempts.push({
        attempt: 2,
        blindPrompt: false,
        patchApplied: true,
        testPassed: test2.passed,
        rollbackOccurred: false,
        testOutput: test2.output,
        patchDiff: patch2.patchCode
      });

      if (test2.passed) {
        // Save healed checkpoint
        const healedCheckpoint = await this.checkpointManager.save('healed-verified', targetFile);
        console.log(`[RetryController] Healed state captured as checkpoint: ${healedCheckpoint}`);
        await this.checkpointManager.pruneAll();
        return { attempts, totalTokenCostUSD, success: true };
      }

      // If still failed, rollback accurately to baseline state
      console.log(`[RetryController] Attempt 2 failed: rolling back to baseline state...`);
      await this.checkpointManager.restore(initialCheckpoint, targetFile);
      await this.checkpointManager.pruneAll();
      return { attempts, totalTokenCostUSD, success: false };
    } catch (err: any) {
      // Guarantee rollback on unhandled synthesis exceptions
      console.error(`[RetryController] Unhandled error during healing: ${err.message}. Performing emergency rollback...`);
      try {
        await this.checkpointManager.restore(initialCheckpoint, targetFile);
      } catch (restoreErr: any) {
        console.error(`[Emergency Rollback Error] ${restoreErr.message}`);
      }
      await this.checkpointManager.pruneAll();
      throw err;
    } finally {
      // Clean up ephemeral reproduction test if present
      const reproTestPath = path.resolve('demo/tests/reproduction.test.ts');
      if (fs.existsSync(reproTestPath)) {
        try { fs.unlinkSync(reproTestPath); } catch {}
      }
    }
  }
}
