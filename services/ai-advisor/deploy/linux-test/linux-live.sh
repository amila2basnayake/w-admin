#!/usr/bin/env bash
# Batch 2: start the sidecar inside the container, prove /health, then run the suites that need a live server.
set -uo pipefail
cd /app
set -a; . /app/.env; set +a
mkdir -p /app/test-logs

echo "== start sidecar"
pkill -f 'tsx src/server.ts' 2>/dev/null || true
nohup npm run -s start > /app/test-logs/sidecar.log 2>&1 &
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:3100/health > /app/test-logs/health.json 2>/dev/null; then echo "health OK after ${i}s"; break; fi
  sleep 1
done
head -c 400 /app/test-logs/health.json; echo
grep -iE 'error|warn|listening' /app/test-logs/sidecar.log | head -8

echo "== /me with a minted token (Stuart 119063)"
TOKEN=$(npm run -s mint -- 119063 "Stuart Peevor" 2 2>/dev/null | tail -1)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3100/me | head -c 300; echo

echo "== live suites"
bash /run-suites.sh live 900 "$@"
echo "== sidecar log tail"
tail -n 15 /app/test-logs/sidecar.log
