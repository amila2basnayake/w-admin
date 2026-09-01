#!/usr/bin/env bash
# Run a list of npm scripts inside /app, each under a timeout; write per-suite logs + a summary line each.
# Usage: linux-run-suites.sh <batch-name> <per-suite-timeout-seconds> script1 script2 ...
set -uo pipefail
BATCH="$1"; TMO="$2"; shift 2
cd /app
set -a; . /app/.env; set +a
export AIADVISOR_SPEND_LEDGER="${AIADVISOR_SPEND_LEDGER:-1}"
mkdir -p /app/test-logs
SUMMARY="/app/test-logs/${BATCH}.summary"
: > "$SUMMARY"
for s in "$@"; do
  log="/app/test-logs/${BATCH}__${s//:/_}.log"
  t0=$(date +%s)
  timeout --kill-after=15 "$TMO" npm run -s "$s" > "$log" 2>&1
  rc=$?
  dt=$(( $(date +%s) - t0 ))
  case $rc in 0) st=PASS;; 124|137) st=TIMEOUT;; *) st=FAIL;; esac
  printf '%-8s %-28s rc=%-3s %4ss  %s\n' "$st" "$s" "$rc" "$dt" "$(tail -n 1 "$log" | cut -c1-90)" | tee -a "$SUMMARY"
done
echo "== BATCH $BATCH DONE" | tee -a "$SUMMARY"
