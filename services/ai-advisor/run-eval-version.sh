#!/bin/bash
# Run the verbosity eval against one persona version, managing the sidecar lifecycle.
# usage: ./run-eval-version.sh <label> <persona-path>|default
# "default" = whatever advisor.ts loads when AIADVISOR_AGENT_FILE is unset.
set -u
cd "$(dirname "$0")"
LABEL="$1"; PERSONA="${2:-default}"
mkdir -p eval-results

# Make sure nothing is already on :3100 (stale sidecar = wrong persona under test).
OLD=$(netstat -ano | grep ":3100" | grep LISTEN | awk '{print $NF}' | head -1)
[ -n "${OLD:-}" ] && taskkill //PID "$OLD" //F //T >/dev/null 2>&1

if [ "$PERSONA" != "default" ]; then export AIADVISOR_AGENT_FILE="$PERSONA"; fi
npm start > "eval-results/sidecar-$LABEL.log" 2>&1 &

UP=""
for i in $(seq 1 30); do
  sleep 2
  curl -s -m 2 http://localhost:3100/health 2>/dev/null | grep -q '"ok":true' && UP=1 && break
done
if [ -z "$UP" ]; then echo "sidecar failed to start — see eval-results/sidecar-$LABEL.log"; exit 3; fi

node eval-verbosity.mjs "$LABEL"
RC=$?

PID=$(netstat -ano | grep ":3100" | grep LISTEN | awk '{print $NF}' | head -1)
[ -n "${PID:-}" ] && taskkill //PID "$PID" //F //T >/dev/null 2>&1
echo "run-eval-version $LABEL done rc=$RC"
exit $RC
