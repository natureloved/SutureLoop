#!/usr/bin/env node

/**
 * SutureLoop CLI — Autonomous Self-Healing Operational Agent
 * 
 * Commands:
 *   auto-heal [--demo-force-fault] : Perform one-shot healing on detected or simulated failure
 *   watch                          : Continuously poll neatlogs and auto-heal on runtime crashes
 *   demo [--demo-force-fault]      : Run full end-to-end demo (seed crash -> heal -> verify)
 */

import { SutureLoopOrchestrator } from '../src/core/orchestrator.js';
import { TelemetryService } from '../src/telemetry/neatlogs_client.js';
import { generateBusinessModel } from '../src/economics/unit_economics.js';
import { readMeasurements, summarizeMeasurements, describeBasis } from '../src/economics/measurements.js';
import { config } from '../src/config/env.js';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const args = process.argv.slice(2);
const command = args[0] || 'auto-heal';
const forceFault = args.includes('--demo-force-fault') || args.includes('-f') || config.demoForceFault;

function printBanner() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║   🩺  S U T U R E L O O P  ::  Autonomous Self-Healing Agent   ║
║   neatHack 2026  |  neatlogs  •  Entire  •  cfo.ai            ║
╚═══════════════════════════════════════════════════════════════╝
`);
}

function printHelp() {
  printBanner();
  console.log(`Usage:
  npx tsx bin/sutureloop.ts [command] [options]

Commands:
  auto-heal           Run one-shot remediation on the latest failure span
  watch               Poll neatlogs telemetry stream and auto-remediate live crashes
  demo                Execute end-to-end live demo (seed crash -> heal -> verify)
  model               Print the cfo.ai financial model from locally measured remediations
  model --measure     Run one real remediation first, so the model has a measurement

Options:
  --measure, -m             (model only) produce a measurement before printing
  --demo-force-fault, -f   Force Attempt 1 to use the trace-blind strategy so the
                            rollback path is exercised, even when caller context is available
  --help, -h               Show this help message
`);
}

async function runAutoHeal() {
  printBanner();
  const orchestrator = new SutureLoopOrchestrator();
  const telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);

  // If no failure is currently pending, seed a realistic telemetry span
  let pendingSpan = await telemetry.getLatestFailureSpan();
  if (!pendingSpan) {
    console.log(`[Telemetry] No pending failure in queue. Seeding active billing service crash span...`);
    const seededTraceId = `trace_seed_${Date.now()}`;
    const seededSpan = {
      traceId: seededTraceId,
      spanId: `span_${Date.now()}`,
      name: 'processInvoice',
      service: 'billing-service',
      timestamp: Date.now(),
      errorMessage: "TypeError: Cannot read properties of undefined (reading 'address')",
      errorStack: "TypeError: Cannot read properties of undefined (reading 'address')\n    at processInvoice (demo/service/routes/billing.ts:20:27)\n    at handleInvoiceBilling (demo/service/routes/billing.ts:25:18)",
      filePath: 'demo/service/routes/billing.ts',
      lineNumber: 20
    };
    await telemetry.recordLocalFailureSpan(seededSpan);
    pendingSpan = seededSpan;
  }

  const result = await orchestrator.run(pendingSpan, forceFault);

  // Print Executive Summary
  console.log(`╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║                    EXECUTIVE HEALING REPORT                   ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  const healedTrace = result.healedTraceId || 'N/A';
  const econ = result.economicMetrics || {
    measuredTokenCostUSD: 0,
    mttrHoursSaved: 0,
    grossSavingsUSD: 0,
    netSavingsUSD: 0,
    grossMarginPercent: 0
  };

  console.log(`║ Session ID     : ${result.sessionId.padEnd(44)} ║`);
  console.log(`║ Incident Trace : ${result.incidentTraceId.padEnd(44)} ║`);
  console.log(`║ Healed Trace   : ${healedTrace.padEnd(44)} ║`);
  console.log(`║ Status         : ${result.finalStatus === 'HEALED' ? 'VERIFIED HEALED ✅' : 'FAILED ❌'}                          ║`);
  console.log(`║ Duration       : ${(result.durationMs + ' ms').padEnd(44)} ║`);
  console.log(`║ Rollback Count : ${(result.attempts.filter(a => a.rollbackOccurred).length.toString()).padEnd(44)} ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║                    cfo.ai FINANCIAL AUDIT                     ║`);
  console.log(`╠═══════════════════════════════════════════════════════════════╣`);
  console.log(`║ Measured Cost  : $${econ.measuredTokenCostUSD.toFixed(4).padEnd(43)} ║`);
  console.log(`║ MTTR Saved     : ${(econ.mttrHoursSaved + ' hrs ($' + econ.grossSavingsUSD + ')').padEnd(44)} ║`);
  console.log(`║ Net ROI/Fix    : $${econ.netSavingsUSD.toFixed(2).padEnd(43)} ║`);
  console.log(`║ Gross Margin   : ${(econ.grossMarginPercent + '%').padEnd(44)} ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  if (result.evalResult) {
    console.log(`\nTelemetry Verification:`);
    console.log(`  • Baseline Trace URL : ${result.evalResult.baselineTraceUrl}`);
    console.log(`  • Healed Trace URL   : ${result.evalResult.healedTraceUrl}`);
    if (result.evalResult.baselineErrors !== undefined) {
      console.log(`  • Error Count Delta  : ${result.evalResult.baselineErrors} -> ${result.evalResult.healedErrors}`);
    }
  }

  return result;
}

async function runWatch() {
  printBanner();
  console.log(`[Watch Mode] Monitoring neatlogs stream on interval (Press Ctrl+C to stop)...`);
  const orchestrator = new SutureLoopOrchestrator();
  const telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);

  const pollIntervalMs = 3000;
  let running = false;

  setInterval(async () => {
    if (running) return;
    try {
      const span = await telemetry.getLatestFailureSpan();
      if (span) {
        running = true;
        console.log(`\n🚨 Intercepted runtime crash from ${span.service || 'service'}!`);
        const result = await orchestrator.run(span, forceFault);
        console.log(`[Watch] Remediation ${result.finalStatus} for ${span.traceId}.`);
        running = false;
      }
    } catch (err: any) {
      // A remediation that refuses to start (e.g. the target has uncommitted
      // work) must not spin the watcher at full speed on the same span.
      console.error(`[Watch Error] ${err.message}`);
      running = false;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }, pollIntervalMs);
}

async function runDemo() {
  printBanner();
  console.log(`[Demo] Launching full end-to-end demonstration...`);
  console.log(`Step 1: Starting microservice on port ${config.port}...`);

  const telemetry = new TelemetryService(config.neatlogsApiKey, config.traceUrlTemplate);
  const { startServer } = await import('../demo/service/server.js');
  // Resolves only once the port is ours and accepting requests. It rejects
  // rather than proceeding if some unrelated application holds the port.
  const { server, reused } = await startServer(config.port);
  if (reused) {
    console.log(`  ✓ Reusing the SutureLoop instance already serving port ${config.port}.`);
  }

  try {
    // Step 2a: ALWAYS restore the crashing baseline first.
    //
    // The demo writes a patch into demo/service/routes/billing.ts as its output.
    // Without this reset, a second run of `npm run demo` starts from an already
    // healed file: the seeded crash no longer throws, no failure span is
    // recorded, and the healing loop has nothing to do. The demo must be
    // runnable repeatedly without manual intervention.
    console.log(`\nStep 2: Restoring seeded-crash baseline (idempotent demo reset)...`);
    const resetRes = await fetch(`http://localhost:${config.port}/api/demo/reset-baseline`, {
      method: 'POST'
    });
    if (resetRes.ok) {
      console.log(`  ✓ Baseline crash code restored.`);
    } else {
      console.warn(`  ! Baseline reset returned HTTP ${resetRes.status}; continuing.`);
    }

    // Clear the local telemetry queue so the run reads only spans it produces.
    telemetry.clearLocalQueue();

    console.log(`\nStep 3: Sending crashing payload to http://localhost:${config.port}/api/billing/invoice...`);
    const crashRes = await fetch(`http://localhost:${config.port}/api/billing/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Intentionally invalid empty object
    });

    const crashData = await crashRes.json();
    if (crashRes.status !== 500) {
      throw new Error(
        `Demo precondition failed: expected the seeded crash to return HTTP 500, got ${crashRes.status}. ` +
        `The crash baseline was not restored correctly.`
      );
    }
    console.log(`  ✓ Received expected HTTP ${crashRes.status} Error:`, crashData.error);

    console.log(`\nStep 4: Triggering SutureLoop autonomous remediation loop...`);
    const orchestrator = new SutureLoopOrchestrator();
    const result = await orchestrator.run(undefined, forceFault);

    if (result.finalStatus !== 'HEALED') {
      if (forceFault) {
        // `--demo-force-fault` pins attempt 1 to the trace-blind strategy so
        // the rollback path is exercised. A failed run here is the expected
        // demonstration, not a broken demo.
        console.log(
          `\n  ! Remediation ended in ${result.finalStatus}, which is the expected outcome for ` +
            `--demo-force-fault: the trace-blind attempt is rolled back and the context-informed ` +
            `attempt did not reach the service. Re-run without -f for the plain path.`
        );
      } else {
        throw new Error(`Demo healing loop did not reach a verified HEALED state (got: ${result.finalStatus}).`);
      }
    }

    console.log(`\nStep 5: Verifying service with post-fix payload...`);
    const healedModule = await import(`../demo/service/routes/billing.js?t=${Date.now()}`);
    const verifiedCity = healedModule.processInvoice({});
    console.log(`  ✓ Healed processInvoice returned: "${verifiedCity}" without throwing!`);

    if (typeof verifiedCity !== 'string' || verifiedCity.length === 0) {
      throw new Error(`Healed processInvoice returned an unusable value: ${String(verifiedCity)}`);
    }

    console.log(`\n🎉 End-to-End Demo Successfully Completed!`);
  } finally {
    if (server && typeof server.close === 'function' && server.listening) {
      server.close();
    }
    const reproFile = path.resolve('demo/tests/reproduction.test.ts');
    if (fs.existsSync(reproFile)) {
      try { fs.unlinkSync(reproFile); } catch {}
    }

    // Leave the working tree clean. The demo's output IS a patch written into
    // the sandbox file; without this restore the next run starts from an
    // already-healed file and the healing loop has nothing to do.
    try {
      const { restoreCrashBaseline } = await import('../demo/service/server.js');
      const restored = restoreCrashBaseline();
      if (restored.ok) {
        console.log(`\n[Cleanup] Sandbox restored to committed crash baseline (${restored.source}); working tree clean.`);
      } else {
        console.warn(`\n[Cleanup] Could not restore sandbox baseline: ${restored.detail}`);
      }
    } catch (cleanupErr: any) {
      console.warn(`[Cleanup] Sandbox restore skipped: ${cleanupErr?.message || cleanupErr}`);
    }
  }
}

/**
 * cfo.ai financial model.
 *
 * The rule this command exists to enforce: never print a cost figure that was
 * not measured on this host. But withholding the *whole* model over one missing
 * number made the cfo.ai surface look broken on a fresh clone, so the output is
 * split instead:
 *
 *   - plan inputs (tier prices, included fixes, engineering value returned)
 *     are business decisions and always print;
 *   - anything derived from the agent's own cost stays null and is labelled
 *     pending until a real remediation has been measured.
 *
 * `--measure` runs one real remediation first, so the command is self-contained
 * for someone who has never run the agent.
 */
async function runModel(args: string[]) {
  printBanner();

  const wantsMeasurement = args.includes('--measure') || args.includes('-m');
  let summary = summarizeMeasurements(readMeasurements());

  if (!summary && wantsMeasurement) {
    console.log(
      `[Model] No remediation has been measured on this host. Running one now to ` +
        `produce a real measurement...`
    );
    try {
      await runAutoHeal();
    } catch (err: any) {
      console.warn(`[Model] The measurement run failed: ${err.message}`);
    }
    console.log('');
    summary = summarizeMeasurements(readMeasurements());
  }

  const model = generateBusinessModel(summary ? summary.medianUSD : null);

  console.log(`cfo.ai Financial Model & Subscription Unit Economics:`);

  console.log(`\n[Measurement basis]`);
  if (summary) {
    const fmt = (n: number) => `$${n.toFixed(4)}`;
    console.log(`  Sessions recorded     : ${summary.count}`);
    console.log(`  Cost per fix (median) : ${fmt(summary.medianUSD)}`);
    console.log(`  Cost per fix (p95)    : ${fmt(summary.p95USD)}`);
    console.log(`  Range observed        : ${fmt(summary.minUSD)} - ${fmt(summary.maxUSD)}`);
    console.log(`  Window                : ${new Date(summary.firstRecordedAt).toISOString()} .. ` +
      `${new Date(summary.lastRecordedAt).toISOString()}`);
    if (summary.lastCommit) console.log(`  Last run at commit    : ${summary.lastCommit}`);
    console.log(`  Composition           : ${describeBasis(summary)}`);
    if (summary.byMode.llm === 0) {
      console.log(
        `  ! Every recorded session used the local AST-guided transformer, which spends no\n` +
        `    provider tokens. Margins below therefore exclude LLM cost entirely; they are\n` +
        `    an upper bound, not the cost of an LLM-backed deployment.`
      );
    }
  } else {
    console.log(`  ! No remediation has been measured on this host yet.`);
    console.log(`    Tier margins are shown as pending rather than estimated from an assumed cost.`);
    console.log(`    Run 'npx tsx bin/sutureloop.ts model --measure' to produce a real one.`);
  }

  console.log(`\n[Per Incident]`);
  if (model.perIncident) {
    const per = model.perIncident;
    console.log(`  - Measured Token Cost      : $${per.measuredTokenCostUSD}`);
    console.log(`  - Engineering MTTR Saved   : ${per.mttrHoursSaved} hrs ($${per.grossSavingsUSD})`);
    console.log(`  - Net Value per Incident   : $${per.netSavingsUSD}`);
    console.log(`  - Gross Margin             : ${per.grossMarginPercent}%`);
  } else {
    console.log(`  - Engineering MTTR Saved   : 0.75 hrs ($93.75)  [plan input, not a measurement]`);
    console.log(`  - Net Value per Incident   : pending measurement`);
  }

  console.log(`\n[Monthly Team Projections (${model.monthlyProjections.incidentsPerMonth} Incidents/Month)]`);
  console.log(`  - Engineering Time Saved   : $${model.monthlyProjections.engineeringTimeSavedUSD}`);
  console.log(`  - Agent Operational Cost   : ${model.monthlyProjections.agentRunningCostUSD === null ? 'pending measurement' : `$${model.monthlyProjections.agentRunningCostUSD}`}`);
  console.log(`  - Net Monthly Savings      : ${model.monthlyProjections.netMonthlySavingsUSD === null ? 'pending measurement' : `$${model.monthlyProjections.netMonthlySavingsUSD}`}`);

  console.log(`\n[cfo.ai Subscription Tiers]`);
  for (const tier of model.subscriptionTiers) {
    const margin = tier.estimatedGrossMarginPercent === null
      ? 'margin: pending measurement'
      : `margin: ${tier.estimatedGrossMarginPercent}%`;
    console.log(`  - ${tier.tierName.padEnd(25)} : $${tier.monthlyPriceUSD}/mo | ${margin}`);
  }
}

switch (command) {
  case 'auto-heal':
    await runAutoHeal();
    break;
  case 'watch':
    await runWatch();
    break;
  case 'demo':
    await runDemo();
    break;
  case 'model':
    await runModel(args);
    break;
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
