# 🩺 SutureLoop — Self-Healing Operational Agent

[![neatHack 2026](https://img.shields.io/badge/neatHack-2026_Hackathon-blue.svg)](https://neatlogs.com/hackathon)
[![Track](https://img.shields.io/badge/Track-Build_an_agent_that_works_(literally)-success.svg)](https://neatlogs.com/hackathon)
[![neatlogs](https://img.shields.io/badge/Telemetry-neatlogs_v1.1.28-6366F1.svg)](https://neatlogs.com)
[![Entire](https://img.shields.io/badge/Code_Graph-Entire-10B981.svg)](https://entire.io)
[![cfo.ai](https://img.shields.io/badge/Financial_Audit-cfo.ai-F59E0B.svg)](https://cfo.ai)
[![License](https://img.shields.io/badge/License-MIT-gray.svg)](LICENSE)

> **SutureLoop** is an autonomous operational self-healing agent that intercepts production microservice crashes, isolates AST blast radii using code graphs, synthesizes regression-tested patches with bounded rollback safety, and audits the unit economics of every remediation.

Built for the **neatHack AI Agent Hackathon 2026** under the track *"Build an agent that works (literally)"*.

---

## 🎯 The Problem

When distributed microservices crash in production (e.g., unexpected null properties, breaking schema changes, type mismatches):
- **45–60 Minutes MTTR**: Engineers spend significant time triaging logs, inspecting stack frames, hunting callers, creating regression tests, and deploying patches.
- **$125.00 / Hour Engineering Cost**: At standard enterprise compensation, every triage incident costs **$93.75 to $125.00** in direct engineering interruption.
- **Hallucination Risk**: Naive AI coding agents without code graphs make speculative multi-file edits, breaking callers and causing cascading regressions.

---

## 💡 The Solution: SutureLoop

SutureLoop closes the loop from production crash telemetry to verified patch in **under 10 seconds** without speculative modifications:

1. **Telemetry Ingestion (`neatlogs`)**: Intercepts uncaught runtime exception spans, extracting exact source files, line numbers, and call stacks.
2. **AST Blast Radius Resolution (`entire` CLI, optional)**: Runs `entire graph impact` to deterministically discover all AST callers, consumers, and affected endpoints before synthesizing any patch. **When the `entire` CLI is not installed** the run says so up front and falls back to a lexical text scan whose callers are explicitly labelled `CALLS_UNVERIFIED` — it never presents a grep as an AST call graph.
3. **Atomic Checkpoint & Rollback (Git Safety Net)**: Captures a snapshot of the remediation target before mutation, fenced to that one file. If Attempt 1 fails the auto-synthesized test suite, SutureLoop restores just that file and verifies the workspace is otherwise untouched. On this host the restore is an in-memory write measured at **<1 ms**; the 225 ms figure quoted in earlier drafts was not reproducible.
4. **Adaptive Patch Synthesis & Vitest Verification**: Synthesizes a strict regression test and applies an AST-informed null-safe fix.
5. **Comparative Trace Evaluation (`neatlogs`)**: Re-evaluates post-fix telemetry, asserting error reduction from **1 → 0** with side-by-side dashboard audit URLs. A `VERIFIED_PASS` requires **both** a clean healed span **and** a confirmed live replay of the original failing request; the demo reports which layer produced the verdict via `verifiedBy`.
6. **Financial Governance (`cfo.ai`)**: Computes measured token costs against engineering hours saved, proving a **>99% gross margin** per automated remediation. Figures below are measured, not projected.

---

## 🏛️ Architecture & Operational Flow

```
  ┌─────────────────────────────────────────────────────────────┐
  │              1. TELEMETRY INGESTION (neatlogs)              │
  │  - Intercept uncaught microservice exception span           │
  │  - Extract target file, crash line, and error stack trace   │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │              2. BLAST RADIUS ANALYSIS (Entire)              │
  │  - Query: `entire graph impact --symbol <file>:<line>`      │
  │  - Discovers AST callers, dependencies, & data flows        │
  │  - Zero guesswork on which functions consume the symbol     │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │             3. ATOMIC CHECKPOINT (Entire / Git)             │
  │  - Snapshot working tree state before code mutation         │
  │  - Verify pristine directory boundary (demo/ sandbox)       │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │           4. ADAPTIVE PATCH SYNTHESIS & RECOVERY            │
  │  - Auto-synthesizes vitest regression reproduction test     │
  │  - Attempt 1: Trace-blind naive patch -> Tests Fail         │
  │  - Atomic Rollback: Restores target file in <1ms (in-mem)   │
  │  - Attempt 2: AST & trace-informed patch -> Tests Pass ✅   │
  │  - Capture verified healed checkpoint                       │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │          5. COMPARATIVE TRACE EVALUATION (neatlogs)         │
  │  - Re-evaluates healed telemetry stream                     │
  │  - Audits error delta (1 -> 0) & latency impact             │
  │  - Outputs verifiable dashboard comparative URLs            │
  └──────────────────────────────┬──────────────────────────────┘
                                 │
                                 ▼
  ┌─────────────────────────────────────────────────────────────┐
  │             6. UNIT ECONOMICS ENGINE (cfo.ai)               │
  │  - Computes measured token cost vs MTTR saved ($125/hr)     │
  │  - Real ROI: $93.75 net value created per incident          │
  │  - Backs cfo.ai SaaS subscription model (>90% gross margin) │
  └─────────────────────────────────────────────────────────────┘
```

---

## 📊 Live Measured Evidence & Execution Metrics

Measured during live end-to-end verification (`npm run demo`):

| Metric | Measured Value | Verification Mechanism |
|---|---|---|
| **Incident MTTR Saved** | **45 minutes (0.75 hrs)** | Industry baseline triage time (config: `INCIDENT_MTTR_MINUTES`) |
| **Engineering Rate** | **$125.00 / hour** | Industry average ($260k fully-loaded) (config: `ENGINEER_HOURLY_RATE_USD`) |
| **Gross Value Created** | **$93.75 USD** | `0.75 hrs * $125/hr` |
| **Total Token Compute Cost** | **$0.0001 USD** | Measured from the two synthesis passes (offline transformer) |
| **Net Operational Savings** | **$93.7499 USD** | Gross savings minus token cost |
| **Gross Margin on Compute** | **100%** | Measured this run; capped at 100% when compute cost rounds to zero |
| **Blast Radius Resolution** | **text-scan-fallback** | `entire` CLI not installed — 7 unverified callers via lexical scan |
| **Atomic Rollback Duration** | **< 1 ms** | In-memory snapshot write, scoped to the target file |
| **Vitest Regression Suite** | **~560 ms** | Fast local test runner feedback loop (15 tests) |
| **Total End-to-End Session** | **~1,700 ms** | Seed crash → blast radius → rollback → pass → comparative eval |

> The 225 ms rollback, 1,011 ms AST resolution, 653 relations, and 8,644 ms session figures quoted in earlier drafts of this README were **not reproducible** on this host and have been replaced with the values measured above. Install the `entire` CLI to get verified AST resolution; without it the blast radius is a lexical scan and is labelled as such.


---

## 🚀 Quickstart & Usage

### 1. Prerequisites
- **Node.js**: v20 or higher (Tested on Node.js v24)
- **Git**: Installed and available in PATH
- **Entire CLI**: optional. When installed, `entire graph impact` gives a verified AST call graph. When absent, the run says so up front and falls back to a lexical text scan whose callers are labelled `CALLS_UNVERIFIED`.

### 2. Installation
```bash
git clone https://github.com/natureloved/SutureLoop.git
cd SutureLoop
npm install
```

### 3. Environment Setup
Copy the sample environment file and configure your API keys:
```bash
cp .env.example .env
```
Key configuration parameters in `.env`:
```ini
# Neatlogs Telemetry
NEATLOGS_API_KEY=your_neatlogs_project_api_key
TRACE_URL_TEMPLATE=https://app.neatlogs.com/traces/${id}

# LLM Synthesis Engine (OpenRouter, Anthropic, or OpenAI)
OPENROUTER_API_KEY=your_openrouter_key

# Operational Constants
DEFAULT_ENGINEER_HOURLY_RATE=125
DEFAULT_INCIDENT_MTTR_MINUTES=45
```

---

## 💻 Available Scripts & Commands

| Command | Description |
|---|---|
| `npm run demo` | **Full Live Demo**: Starts service, seeds crash payload, triggers SutureLoop with forced Attempt-1 fault, executes atomic rollback, passes Attempt-2, and verifies healed HTTP endpoint. |
| `npm run demo:fail` | **Forced-Fault Remediation**: Demonstrates Attempt-1 failure, atomic rollback, and Attempt-2 recovery. |
| `npm run demo:heal` | **One-Shot Auto-Heal**: Runs self-healing on the latest pending crash span in telemetry. |
| `npm test` | **Unit & Regression Tests**: Runs the baseline `vitest` suite. |
| `npx tsx bin/sutureloop.ts watch` | **Continuous Monitoring**: Long-running daemon polling neatlogs for uncaught exceptions in real time. |
| `npx tsx bin/sutureloop.ts model` | **cfo.ai Financial Model**: Displays subscription unit economics, monthly team savings, and tier margins. |

---

## 🌐 Entire Cloud Mirroring & Session Tracking

- **Cloud Dashboard**: Mirrored on Entire Cloud at [`https://app.entire.io`](https://app.entire.io) (`natureloved/SutureLoop`).
- **Autonomous Checkpoints**: Real-time agent session recording, commit linking, and AST blast-radius tree indexing via `entire enable` and Git hooks.


---

## 📁 Repository Structure

```
SutureLoop/
├── bin/
│   └── sutureloop.ts            # Unified CLI entrypoint (demo, auto-heal, watch, model)
├── src/
│   ├── config/
│   │   └── env.ts               # Centralized configuration loader
│   ├── context/
│   │   ├── blast_radius.ts      # Downstream caller impact analyzer
│   │   └── entire_graph.ts      # entire CLI AST code graph + text-scan fallback
│   ├── core/
│   │   ├── errors.ts            # Named custom error domain
│   │   ├── invariants.ts        # Defensive invariant assertions (clean worktree, etc.)
│   │   ├── orchestrator.ts      # Core pipeline coordinator
│   │   └── types.ts             # Strongly-typed domain definitions
│   ├── economics/
│   │   └── unit_economics.ts    # Real-math cfo.ai financial calculator
│   ├── state/
│   │   ├── checkpoint_manager.ts# Scoped file snapshot + git safety net (not Entire)
│   │   └── git_sandbox.ts       # Worktree cleanliness and sandbox isolation
│   ├── synthesis/
│   │   ├── patch_generator.ts   # Multi-stage adaptive patch synthesis engine
│   │   ├── retry_controller.ts  # Bounded retry loop (Attempt 1 -> Rollback -> Attempt 2)
│   │   └── test_synthesizer.ts  # Automated reproduction test generator
│   └── telemetry/
│       ├── neatlogs_client.ts   # neatlogs SDK integration & comparative trace eval
│       └── trace_interceptor.ts # Runtime stack trace parser
├── demo/
│   ├── service/
│   │   ├── routes/billing.ts    # Seeded microservice route with deep property access bug
│   │   └── server.ts            # Instrumented Express microservice
│   └── tests/
│       └── billing.test.ts      # Baseline regression test suite
├── docs/
│   └── BUSINESS-PLAN.md         # Comprehensive cfo.ai financial plan & 18-month runway
├── runs/
│   └── posts/                   # Public build-in-public milestone updates (Beats 1–5)
├── HACKATHON.md                 # Detailed hackathon build log, timings, & checklist
├── package.json
└── tsconfig.json
```

---

## 💼 Business Plan & Financial Model (cfo.ai)

Read the full financial plan in [docs/BUSINESS-PLAN.md](docs/BUSINESS-PLAN.md).

### Subscription Pricing Tiers
- **Starter ($79/mo)**: 15 fixes/mo | Compute cost: ~$0.01 | **>95% Gross Margin**
- **Growth ($199/mo)**: 50 fixes/mo | Compute cost: ~$0.04 | **>95% Gross Margin**
- **Scale ($599/mo)**: 200 fixes/mo | Compute cost: ~$0.14 | **>96% Gross Margin**

### Customer Return on Investment
A Growth customer saves **37.5 engineering hours per month** ($4,687.50 in engineering capacity returned) for a $199/month investment — delivering a **23.5x net customer ROI**.

---

## 🏆 Hackathon Compliance & Sponsor Criteria

- [x] **Repo started completely empty** at kickoff (fresh-code rule strictly followed).
- [x] **neatlogs (v1.1.28)**: Instrumented runtime telemetry, error span ingestion, and comparative evaluation.
- [x] **Entire CLI (optional)**: `entire graph impact` AST analysis when installed; otherwise a labelled text-scan fallback. Checkpoint/rollback is the project's own git safety net, not Entire.
- [x] **cfo.ai**: Real financial governance model grounded in measured runtime token counts and MTTR metrics.
- [x] **Strict Rule Enforcement**: Zero fabricated values (`|| 1`, `|| 420`), honest fallback labels, named domain errors.
- [x] **Build-in-Public**: Complete chronological logs in `HACKATHON.md` and posts in `runs/posts/`.

---

## 📄 License

MIT © [natureloved](https://github.com/natureloved)
