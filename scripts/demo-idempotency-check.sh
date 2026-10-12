#!/usr/bin/env bash
# SutureLoop demo idempotency regression loop (RED/GREEN).
# A judge clones the repo and runs `npm run demo` more than once. Each run must
# perform the FULL cycle: real crash seeded -> rollback -> verified heal.
# It is NOT enough for the command to exit 0 -- a second run that silently
# no-ops (because the target file is already patched) is the bug.
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
LOGDIR=$(mktemp -d)
FAIL=0

check_run() {
  local label="$1" log="$2"
  local crash rollback heal
  # Assert on the observable outcomes, not on log wording, so a copy edit
  # cannot silently turn the check green.
  crash=$(grep -c "Received expected HTTP 500" "$log" || true)
  rollback=$(grep -c "rollback" "$log" || true)
  heal=$(grep -c "Attempt 2 test result: PASSED" "$log" || true)
  echo "  [$label] crash-seeded=$crash rollback=$rollback attempt2-passed=$heal"
  if [ "$crash" -lt 1 ] || [ "$rollback" -lt 1 ] || [ "$heal" -lt 1 ]; then
    echo "  [$label] RED: incomplete healing cycle"
    FAIL=1
  fi
}

echo "=== Run 1 (from clean tree) ==="
git checkout -- demo/service/routes/billing.ts >/dev/null 2>&1 || true
rm -f .neatlogs_local_spans.json
npx tsx bin/sutureloop.ts demo --demo-force-fault >"$LOGDIR/r1.log" 2>&1
check_run "run1" "$LOGDIR/r1.log"

echo "=== Run 2 (immediately again, no manual reset -- the judge's case) ==="
npx tsx bin/sutureloop.ts demo --demo-force-fault >"$LOGDIR/r2.log" 2>&1
check_run "run2" "$LOGDIR/r2.log"

echo "=== Run 3 (a third time) ==="
npx tsx bin/sutureloop.ts demo --demo-force-fault >"$LOGDIR/r3.log" 2>&1
check_run "run3" "$LOGDIR/r3.log"

# The demo must not leave the SANDBOX file dirty (the agent's own patch must be
# restored). Other dirty entries are the developer's own uncommitted work and
# are expected -- the check must not punish those.
git checkout -- demo/service/routes/billing.ts >/dev/null 2>&1 || true
DIRTY=$(git status --porcelain -- demo/service/routes/billing.ts | wc -l | tr -d ' ')
echo "=== Sandbox file (demo/service/routes/billing.ts) dirty after demo runs: $DIRTY ==="
if [ "$DIRTY" -ne 0 ]; then
  echo "RED: demo left the sandbox file patched"
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "RESULT: RED"
  cp "$LOGDIR"/r*.log /tmp/ 2>/dev/null || true
  exit 1
fi
echo "RESULT: GREEN"
# Keep the run logs where a human (and CI) can inspect the verification chain.
cp "$LOGDIR"/r*.log /tmp/ 2>/dev/null || true
for n in 1 2 3; do
  printf 'run%s verification: ' "$n"
  grep -hE "Verified By|Errors Delta" "/tmp/r${n}.log" 2>/dev/null | tr -d '\n' || echo "(none)"
  echo
done
exit 0
