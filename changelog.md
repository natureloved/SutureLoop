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
- **Correction (logged 2026-10-13):** the `entire` CLI is not installed on the
  Linux host, so every `entire graph impact` call failed with
  `spawn entire ENOENT`. The original Phase 2 notes quoted "653 relations in
  1,011ms" — never measured here, now withdrawn. Added
  `isEntireCliAvailable()` so the run reports the missing CLI up front instead
  of failing mid-run, and relabelled the fallback from `regex-fallback` (it was
  a naive text scan, not a parser) to `text-scan-fallback` with every caller
  marked `CALLS_UNVERIFIED`. Measured on this host: 7 candidate callers.

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
| Blast radius | `text-scan-fallback`, 7 unverified callers (`entire` CLI absent) |
| Rollback | < 1 ms, scoped to target file |
| End-to-end session | ~1,700 ms |
| `npm audit` | 14 (0 critical, 4 high) |
