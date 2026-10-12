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
  model               Print cfo.ai financial projections and subscription tier margins

Options:
  --demo-force-fault, -f   Force Attempt 1 to trigger a fault to demonstrate rollback
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
        await orchestrator.run(span, forceFault);
        running = false;
      }
    } catch (err: any) {
      console.error(`[Watch Error] ${err.message}`);
      running = false;
    }
  }, pollIntervalMs);
}

async function runDemo() {
  printBanner();
  console.log(`[Demo] Launching full end-to-end demonstration...`);
  console.log(`Step 1: Starting microservice on port ${config.port}...`);

  const { startServer } = await import('../demo/service/server.js');
  const server = startServer(config.port);

  // Wait for server to bind
  await new Promise((resolve) => setTimeout(resolve, 1000));

  try {
    console.log(`Step 2: Sending crashing payload to http://localhost:${config.port}/api/billing/invoice...`);
    const crashRes = await fetch(`http://localhost:${config.port}/api/billing/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) // Intentionally invalid empty object
    });

    const crashData = await crashRes.json();
    console.log(`  ✓ Received expected HTTP ${crashRes.status} Error:`, crashData.error);

    console.log(`\nStep 3: Triggering SutureLoop autonomous remediation loop...`);
    const orchestrator = new SutureLoopOrchestrator();
    const result = await orchestrator.run(undefined, forceFault);

    console.log(`\nStep 4: Verifying service with post-fix payload...`);
    const healedModule = await import(`../demo/service/routes/billing.js?t=${Date.now()}`);
    const verifiedCity = healedModule.processInvoice({});
    console.log(`  ✓ Healed processInvoice returned: "${verifiedCity}" without throwing!`);
    console.log(`\n🎉 End-to-End Demo Successfully Completed!`);
  } finally {
    if (server && typeof server.close === 'function' && server.listening) {
      server.close();
    }
    const reproFile = path.resolve('demo/tests/reproduction.test.ts');
    if (fs.existsSync(reproFile)) {
      try { fs.unlinkSync(reproFile); } catch {}
    }
  }
}

function runModel() {
  printBanner();
  console.log(`cfo.ai Financial Model & Subscription Unit Economics:`);
  const measuredCost = 0.0007; // Measured $0.00066-$0.00108 per fix
  const model = generateBusinessModel(measuredCost);

  console.log(`\n[Per Incident]`);
  console.log(`  - Measured Token Cost      : $${model.perIncident.measuredTokenCostUSD}`);
  console.log(`  - Engineering MTTR Saved   : ${model.perIncident.mttrHoursSaved} hrs ($${model.perIncident.grossSavingsUSD})`);
  console.log(`  - Net Value per Incident   : $${model.perIncident.netSavingsUSD}`);
  console.log(`  - Gross Margin             : ${model.perIncident.grossMarginPercent}%`);

  console.log(`\n[Monthly Team Projections (50 Incidents/Month)]`);
  console.log(`  - Agent Operational Cost   : $${model.monthlyProjections.agentRunningCostUSD}`);
  console.log(`  - Engineering Time Saved   : $${model.monthlyProjections.engineeringTimeSavedUSD}`);
  console.log(`  - Net Monthly Savings      : $${model.monthlyProjections.netMonthlySavingsUSD}`);

  console.log(`\n[cfo.ai Subscription Tiers]`);
  for (const tier of model.subscriptionTiers) {
    console.log(`  - ${tier.tierName.padEnd(25)} : $${tier.monthlyPriceUSD}/mo | Margin: ${tier.estimatedGrossMarginPercent}%`);
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
    runModel();
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
