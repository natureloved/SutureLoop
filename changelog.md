# SutureLoop — Build in Public Log

Append-only log of what was built, in order. Each entry records what actually
happened, including the corrections. Nothing here is a projection.

Format: date (UTC) · phase · what changed · measured result.

---

## 2026-10-11 · Kickoff

- Repo created at zero pre-written code. Decided the pitch around one measurable
  claim: a production crash span becomes a verified patch without speculative
  modifications.
- Chose the three sponsor surfaces to integrate against: `neatlogs`
  (telemetry + comparative evaluation), `entire` CLI (AST blast radius),
  `cfo.ai` (financial governance).
- Adopted a rule up front that shaped everything after it: **no unmeasured
  success values**. If a number cannot be produced by running the code, it does
  not go in the README.

## 2026-10-11 · Phase 1 — Core skeleton

- Defined the invariant layer (`src/core/invariants.ts`) first, before any
  healing logic: target-file validation against traversal, injection and
  self-mutation, and a worktree cleanliness gate.
- Error taxonomy in `src/core/errors.ts` so failures are typed rather than
  strings.

## 2026-10-11 · Phase 2 — Telemetry + code graph

- `src/telemetry/neatlogs_client.ts` with loop prevention (`seenTraceIds`) and a
  local span buffer (`.neatlogs_local_spans.json`).
- Instrumented `demo/service/server.ts` to capture deep stack traces on the
  seeded crash.
- `src/context/entire_graph.ts` to shell out to `entire graph impact`.
- **Correction, later resolved (logged 2026-10-13):** the `entire` CLI was
  missing on the Linux host, so every `entire graph impact` call failed with
  `spawn entire ENOENT`. The original Phase 2 notes quoted "653 relations in
  1,011ms" — never measured here, now withdrawn. Added
  `isEntireCliAvailable()` so the run reports a missing CLI up front instead of
  failing mid-run, and relabelled the fallback from `regex-fallback` (it was a
  naive text scan, not a parser) to `text-scan-fallback` with every caller
  marked `CALLS_UNVERIFIED`.
- **2026-10-13 — `entire` CLI installed on this host.** Downloaded the
  v0.11.4 `entire_linux_amd64` release binary, **verified its SHA-256 against
  the published checksums**, installed to `~/.local/bin`, and installed the
  `entire-graph` plugin v0.4.0. The AST path is now the live path.
  - `entire --version` -> `Entire CLI 0.11.4` (go1.27.1, linux/amd64)
  - Measured: **5 verified callers**, **1,206 relations**, **1,403 ms**
  - SutureLoop now reports `Resolution Method: entire-graph` with no fallback
    warning.

## 2026-10-11 · Phase 3 — Bounded retry loop + rollback

- `RetryController` synthesises a `vitest` reproduction test, then runs
  attempt 1 → rollback → attempt 2.
- Checkpoints are a scoped in-memory file snapshot plus a git ref under
  `refs/sutureloop/checkpoints/*`, fenced to the remediation target.
- **Correction (logged 2026-10-13):** Attempt 1's failure was originally
  *planted* — the generator comment read "(deliberate or blind)" and the loop
  logged `FAILED (Expected)` and "Attempt 1 surprisingly passed". The
  trace-blind strategy is now a real strategy with a real blind spot (it guards
  the immediate receiver and misses the root-null case), so the failure and the
  rollback are both earned. The loop also exits early when attempt 1 genuinely
  satisfies every regression case instead of manufacturing a second pass.
- Rollback measured at **<1 ms** (in-memory write). The 228 ms in the original
  notes was not reproducible.

## 2026-10-11 · Phase 4 — Comparative evaluation

- `runComparativeEval` compares the failure span against the healed span and
  emits dashboard URLs.
- **Correction (logged 2026-10-13):** the evaluation was not actually passing.
  Two separate defects:
  1. `TelemetryService` called `client.getSpans()` and `client.getTrace()` —
     neither exists on the neatlogs `Client` class, so both branches were dead
     and every call silently fell through to the local buffer.
  2. The demo's own live replay was broken. `demo/service/server.ts` statically
     imported `processInvoice`, so after SutureLoop rewrote the file the server
     kept calling the *crashed* function and the replay returned HTTP 500,
     downgrading verification to `MANUAL_VERIFICATION_REQUIRED` even though the
     patch on disk was correct. Fixed with a cache-busted dynamic import.
- A `VERIFIED_PASS` now requires **both** a clean healed span **and** a
  confirmed live replay, and reports which layer produced the verdict
  (`verifiedBy`). Measured: `PROGRAMMATIC_EVAL`, Errors Delta 1 → 0,
  `Verified By: local-spans+live-replay`.

## 2026-10-11 · Phase 5 — Unit economics

- `src/economics/unit_economics.ts` computes measured token cost against
  engineering hours saved.
- Measured this host: token cost **$0.0001**, MTTR saved 0.75 hrs, gross value
  $93.75, margin 100%. (The $0.0011 in the original notes was not measured
  here.)

## 2026-10-13 · Remediation pass

- **The demo was not idempotent.** `npm run demo` failed on a second run because
  the demo's output *is* a patch written into the sandbox file, so run 2 started
  from an already-healed file, got HTTP 200 instead of the seeded crash, and
  aborted with `No unhandled failure span available for remediation`. The demo
  now restores the baseline from `git show HEAD:<path>` first, asserts the crash
  returns 500, asserts the loop reached HEALED, and restores the baseline on
  exit.
- **The baseline reset itself was broken.** It restored from a hand-maintained
  duplicate of the source that had drifted from HEAD (it had lost a doc
  comment), so every reset wrote a file differing from the committed one and
  left the tree dirty.
- **The worktree gate blocked legitimate work.** `assertCleanWorktree()` gated
  the entire repo, so `npm install` rewriting `package-lock.json` — or any
  unrelated edit — aborted remediation. Now scoped to the remediation target,
  which is the only file a rollback can damage.
- **Added `scripts/demo-idempotency-check.sh`**, the RED/GREEN regression loop:
  runs the demo three times back to back with no manual reset and asserts each
  performs the full cycle (crash seeded → rollback → attempt 2 passed) and
  leaves the sandbox byte-identical to HEAD. It was RED on all three runs
  before the fix; GREEN after.
- **Dependency audit:** 17 advisories (2 critical, 4 high) → 14 (0 critical,
  4 high) by upgrading vitest 3 → 5 and neatlogs → 1.1.28. The remaining
  protobufjs high requires downgrading neatlogs below 1.1.18, which is worse.
- **`npm test` ran only 1 of 15 tests** (it targeted a single file while
  `test:all` ran the suite). Now runs the full suite.

## Current measured state

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 15/15 pass |
| `scripts/demo-idempotency-check.sh` | GREEN, 3 back-to-back runs |
| Comparative evaluation | `PROGRAMMATIC_EVAL`, Errors Delta 1 → 0 |
| Verification layer | `local-spans+live-replay` |
| Blast radius | `entire-graph`, 5 verified callers / 1,206 relations / 1,403 ms |
| Rollback | < 1 ms, scoped to target file |
| End-to-end session | ~1,800 ms |
| `npm audit` | 14 (0 critical, 4 high) |

## 2026-10-15 · Correctness review — 14 defects fixed

A review pass over the healing pipeline found fourteen real defects. The demo
still passed throughout; that is exactly the problem — none of these were
visible from the outside, and several of them could destroy a developer's work
or write broken code into a file. Test count went 15 → 40.

### Data loss / safety

- **`pruneAll()` force-deleted the user's own branches.** It swept
  `git branch --list 'cp_*'` and ran `git branch -D` on every match, so a branch
  named `cp-hotfix` was destroyed on the first successful heal. Cleanup is now
  scoped to refs this process actually minted.
- **Watch mode could heal exactly one incident per process.** A successful heal
  leaves the patched target uncommitted, which the safety gate then read as
  "uncommitted work at risk" and refused. Added `src/state/applied_patches.ts`:
  a content-addressed record of what the agent itself wrote, kept under `.git/`
  so it never appears as project state. The exemption dies the instant a
  developer edits on top of the patch, re-arming the gate. Verified by running
  `auto-heal` twice back to back: the second run previously refused, now heals.
- **The PR flow left the repo on the fix branch**, and since
  `restoreCrashBaseline()` reads `git show HEAD:<file>`, that made the *next*
  `npm run demo` seed a patched file and fail its own precondition. The branch
  is now captured before checkout and restored in a `finally`.

### Wrong code written

- **The AST-guided transformer corrupted any line that was not a single bare
  member chain.** `return invoice.rate * 1.5` became
  `return invoice?.rate ?? "Unknown City" * 1.5` — the fallback bound tighter
  than the multiplication, turning a null guard into a value substitution. The
  member regex also matched numeric literals, rewriting `1.5` to `1?.5`. Chains
  are now parenthesised, the fallback is applied once to the whole returned
  expression, the regex must start with an identifier, and chains inside string
  literals are left alone.
- **An LLM patch was accepted if the reply merely mentioned the target
  function name** — prose or a diff would overwrite the source file. It must now
  parse as TypeScript (`ts.createSourceFile` diagnostics) first.

### Verification honesty

- **A successful heal was reported as `REGRESSION_DETECTED`.** The verdict was
  `healedErrors === 0 && liveReplaySucceeded`, so a clean heal with no service
  listening (every CLI `auto-heal`) fell into the else branch. Added
  `VERIFICATION_INCOMPLETE`. The neatlogs-CLI layer also ignored the live-replay
  requirement entirely and disagreed with the local layer; both now use one rule.
- **The regression test was a fixed template** that always imported
  `processInvoice` from `demo/service/routes/billing.ts` regardless of the span,
  so a suite for any other incident tested the wrong module. It is now derived
  from the incident, and declines to synthesize (reporting FAILED rather than a
  false pass) when the span names no exported symbol or the module has
  import-time side effects.
- **`checkpointId` was the literal string `'cp_latest'`** in every result,
  violating the project's own no-fabricated-values rule. The real id is
  returned now.
- **`sutureloop model` printed a hardcoded `$0.0007` "measured" cost.** Every
  session now persists its measured figures and the command reads them back,
  refusing to print a model when no run is on record.

### Concurrency, timeouts, dead code

- Concurrent remediations (CLI + watch + the background webhook) rewrote the
  same file and raced on the telemetry queue, whose read-append-write lost
  spans. Added `src/core/mutex.ts`; sessions and queue writes are serialised.
- **`runTests` had no timeout** — a hung vitest run froze the autonomous loop,
  defeating the bounded-retry guarantee. Now `execFile` with a hard timeout;
  a killed run fails the attempt like any other failure.
- **`--demo-force-fault` was a no-op.** Its code sat after an unconditional
  `return`, so it was unreachable. Attempt 1 is now blind when forced *or* when
  there is genuinely no caller context, and informed otherwise — so a normal run
  no longer stages a failure it did not need to stage.
- `RETRY_LIMIT=5` silently meant 2; a malformed value produced `NaN` and
  disabled the bound. Numeric env vars are now validated with a documented
  fallback, and the default is 2 (matching the documented loop).
- `neatlogs.init` was called once per process, so a server whose first run had
  no API key stayed pinned to `disableExport: true` and silently dropped
  telemetry for every later run.
- `stageSpan` was exported and never called; the orchestrator now actually
  emits the stage chain the README documents. Unused `GitSandbox` /
  `generateBusinessModel` imports removed.
- Boundary check used a bare `startsWith('demo')`, which also admitted a sibling
  directory such as `demo-secrets/`; now matched on whole path segments.
- The telemetry queue grew without bound; capped at 500 spans.
- The failing property name is interpolated into a `RegExp` from an error
  message — untrusted input — and is now escaped.

### Current measured state

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 40/40 pass |
| `npm run demo` | HEALED, Errors Delta 1 → 0, `local-spans+live-replay` |
| End-to-end session | 1,976 ms |
| Sandbox after demo | byte-identical to HEAD; no `cp_*` branches or refs left behind |

## 2026-10-15 · Hardening — three claims the code could not back

A follow-up pass on the two areas flagged during the review, plus one latent
bug found while checking them. Test count 40 → 46.

- **The demo could run against a service that was not ours.** On `EADDRINUSE`
  the server logged `"Utilizing active service instance"` and carried on,
  asserting an ownership it never checked. With any other process on the port
  the demo POSTed its crash payload to a stranger's API, then reported
  `✓ Live Re-issue Succeeded` against that stranger's endpoint. `startServer`
  now probes `/health` and refuses to start unless the existing owner
  identifies as `sutureloop-billing-service`. Verified live: with a foreign
  server on :3000 the demo aborts with the reason and the sandbox is untouched;
  with a second SutureLoop instance it correctly reuses it.
- **`startServer` resolved on a `setTimeout(1000)` instead of on `listening`.**
  It now returns a promise that settles when the port is genuinely ours, which
  is what makes the ownership claim above safe.
- **The path was fenced; the push was not.** `pr_client` received `targetFile`
  as a payload field and `git add`-ed it without re-checking it. With
  `ENABLE_REMOTE_PR=true` a span that reached that client by any route could be
  staged and pushed to origin. The boundary is now re-asserted immediately
  before staging, and the client refuses with `TARGET_OUTSIDE_REMEDIATION_BOUNDARY`.
- **Recording an incident and mutating a source file shared one switch.**
  `/api/v1/incidents/ingest` now honours `SUTURELOOP_INGEST_MODE`. In
  `record-only` an inbound HTTP request is recorded and nothing else happens —
  verified live: the span is accepted, `remediation: "recorded-only"` is
  returned, and `demo/service/routes/billing.ts` is byte-identical afterwards.
  Default stays `auto-heal`, which is the documented behaviour.
- **The bundled middleware could not authenticate.** It posted to the ingest
  endpoint with only `Content-Type`, never sending `x-sutureloop-secret`, and
  never checked the response status. The first time an operator configured a
  secret, every forwarded crash was rejected with 401 and nothing was logged —
  telemetry simply stopped. It now forwards the configured secret and reports
  the status code and body of a rejected ingest.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 46/46 pass |
| `scripts/demo-idempotency-check.sh` | GREEN, 3 back-to-back runs |
| Foreign process on the demo port | refused, with the reason; sandbox untouched |
| `SUTURELOOP_INGEST_MODE=record-only` | span recorded, no file written |
