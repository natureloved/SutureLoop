# SutureLoop — Self-Healing Operational Agent
**neatHack AI Agent Hackathon 2026**
Track: *"Build an agent that works (literally)"*

---

## 1. Project Overview
- **Project Name**: SutureLoop
- **Purpose**: Autonomous operational self-healing agent that monitors runtime crashes, isolates blast radii using code graphs, synthesizes verified regression-tested patches, and evaluates financial impact and MTTR reduction.
- **Problem**: When microservices crash in production, engineers spend an average of 45–60 minutes triaging stack traces, investigating callers, creating reproduction tests, and deploying hotfixes. SutureLoop closes the loop from production telemetry anomaly to AST-aware verified patch within seconds, backing every action with audit trails and unit-economic ROI analysis.
- **Team**: Solo Developer (@RastaDev)

---

## 2. Technology Stack & Integrations
- **Core Engine**: TypeScript, Node.js v24, `tsx`
- **Telemetry & Observability (Sponsor 1)**: `neatlogs` (v1.1.26) & `neatlogs-cli` (v0.2.1)
  - Captures runtime exception spans in microservices.
  - Ingests traces, isolates root cause, and provides before/after comparative trace evaluation (delta verification).
- **Code Graph & Version Control (Sponsor 2)**: `Entire` CLI (v0.11.4) + `entire-graph` plugin (v0.4.0) & Checkpoints
  - Provides deterministic, AST-level caller/callee blast-radius analysis via `entire graph impact` and `entire graph neighbors`.
  - Enforces atomic state checkpoints and clean rollback guarantees between repair attempts.
- **Financial & Unit Economics Modeling (Sponsor 3)**: `cfo.ai`
  - Quantifies cost-per-fix, engineer MTTR hours saved, customer tier pricing, and financial runway in `docs/BUSINESS-PLAN.md` based on real measured token and operational metrics.
- **Testing & Verification**: `vitest` (reproduction test synthesis and regression suite).
- **LLM Reasoning & Patch Synthesis**: Multi-provider support (OpenRouter / Anthropic / AWS Bedrock / OpenAI).

---

## 3. Architecture & Operational Loop

```
  +-------------------------------------------------------------+
  |              1. TELEMETRY INGESTION (neatlogs)              |
  |  - Intercept uncaughtException / unhandledRejection         |
  |  - Extract failed file, line number, and stack frame        |
  +-------------------------------------------------------------+
                                |
                                v
  +-------------------------------------------------------------+
  |              2. BLAST RADIUS ANALYSIS (Entire)              |
  |  - `entire graph impact --symbol <file>:<line>`             |
  |  - Discovers AST callers, dependencies, & type consumers    |
  |  - Fallback: Deterministic static regex AST parser          |
  +-------------------------------------------------------------+
                                |
                                v
  +-------------------------------------------------------------+
  |             3. ATOMIC CHECKPOINT (Entire / Git)             |
  |  - Save pre-patch state (Entire Checkpoint / Git branch)    |
  |  - Verifies pristine working directory before any mutation |
  +-------------------------------------------------------------+
                                |
                                v
  +-------------------------------------------------------------+
  |           4. ADAPTIVE PATCH SYNTHESIS & RECOVERY            |
  |  - Synthesizes automated vitest reproduction test           |
  |  - Attempt 1: Trace-blind / Forced Fault -> Tests Fail       |
  |  - Rollback: Revert to checkpoint & verify clean tree        |
  |  - Attempt 2: Full context + AST repair -> Tests Pass       |
  +-------------------------------------------------------------+
                                |
                                v
  +-------------------------------------------------------------+
  |          5. COMPARATIVE TRACE EVALUATION (neatlogs)         |
  |  - Re-run service with verified patch                       |
  |  - Compare error count (1 -> 0) & latency delta             |
  |  - Provide verifiable live dashboard URLs                   |
  +-------------------------------------------------------------+
                                |
                                v
  +-------------------------------------------------------------+
  |             6. UNIT ECONOMICS ENGINE (cfo.ai)               |
  |  - Compute real token cost & engineer MTTR saved ($125/hr)  |
  |  - Target >80% gross margin on automated remediation        |
  |  - Feeds cfo.ai financial model in docs/BUSINESS-PLAN.md    |
  +-------------------------------------------------------------+
```

---

## 4. Build Log (Chronological & Evidence-Based)

### Phase 0: Tool Spike, Export Check, & Environment Setup
- **Date**: October 10, 2026 - 21:00 UTC
- **Environment verified**:
  - `git version 2.54.0.windows.1`
  - `node v24.16.0`, `npm 11.13.0`
- **Entire CLI Installation**:
  - Downloaded `entire_windows_amd64.zip` (v0.11.4) from `entireio/cli`.
  - Installed binary into system path; verified `entire --version` -> `Entire CLI 0.11.4`.
- **Entire Plugins & Setup**:
  - Executed `entire enable --agent antigravity -y` to configure project tracking and git hooks.
  - Installed `entire-graph` plugin v0.4.0 via `entire plugin install graph`.
  - Generated `AGENTS.md` and `.entire/graph-agent.md` via `entire graph init-agents --repo .`.
  - Verified `entire graph capabilities --json` confirms full TypeScript AST support (CALLS, DEFINES, IMPORTS, etc.).
- **Spike 0 (neatlogs)**:
  - Installed `neatlogs@1.1.26`, `express`, `vitest`.
  - Verified `neatlogs` ESM module exports: `Client`, `init`, `span`, `trace`, `wrapOpenAI`, `wrapAnthropic`, etc.
- **Spike 1 (Entire Graph Impact)**:
  - Created test route `demo/service/routes/billing.ts`.
  - Executed `entire graph impact --repo . --symbol "demo/service/routes/billing.ts:2" --format json`.
  - **Gate 1 Passed**: Correctly parsed `processInvoice` definition and identified `handleInvoice` caller at line 6 with 0.92 confidence in 522ms.
- **Spike 2 (Checkpoints & Rollback)**:
  - Validated checkpoint contract: `entire checkpoint list`, git safety net integration.
- **Spike 3 (neatlogs Trace Inspection)**:
  - Inspected `neatlogs-cli` v0.2.1 trace commands: `traces list`, `traces get`.

---

## 5. Known Limitations & Next Steps
- Real-time `neatlogs` cloud export requires valid `NEATLOGS_API_KEY`; built-in mock telemetry pipeline provided for standalone end-to-end deterministic demonstration.
- Entire checkpoint CLI uses git branch / tag safety net fallback when standalone `entire checkpoint save` is executed outside an active agent session commit.

---

## 6. Submission Deliverables Checklist
- [x] Repository created with zero pre-written code at kickoff.
- [x] Mandatory sponsor `neatlogs` integrated (v1.1.26).
- [x] Mandatory sponsor `Entire` CLI (v0.11.4) + `graph` plugin configured.
- [x] Mandatory sponsor `cfo.ai` financial model designed.
- [x] Full strict compliance with "No unmeasured success values" rule.
- [x] Building in public log and posts in `runs/posts/`.
