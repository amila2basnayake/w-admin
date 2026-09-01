#!/usr/bin/env bash
# Provision the ai-advisor sidecar inside a clean Ubuntu container for a Linux test run.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== OS"; . /etc/os-release; echo "$PRETTY_NAME $(uname -m)"

echo "== apt"
apt-get update -qq
apt-get install -y -qq --no-install-recommends curl ca-certificates git gnupg rsync postgresql-client procps >/dev/null

echo "== node 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null
node -v; npm -v

echo "== copy sidecar (no node_modules / sandbox / logs)"
mkdir -p /app
rsync -a --exclude node_modules --exclude agent-workdir --exclude 'e2e/chrome-profile*' --exclude '*.log' --exclude .env /src/services/ai-advisor/ /app/ || true
mkdir -p /app/agent-workdir
cd /app

echo "== npm ci"
npm ci --no-audit --no-fund 2>&1 | tail -3
echo "sdk linux binary:"; ls node_modules/@anthropic-ai/ | tr '\n' ' '; echo

echo "== .env for the container"
# Start from the host .env, then repoint hosts at the Docker host gateway.
sed -E \
  -e 's#^PGHOST=.*#PGHOST=host.docker.internal#' \
  -e 's#^AIADVISOR_CRM_BASE=.*#AIADVISOR_CRM_BASE=http://host.docker.internal:81#' \
  -e 's#^AIADVISOR_PBX_BASE_URL=.*#AIADVISOR_PBX_BASE_URL=http://host.docker.internal:7866/#' \
  -e 's#^AIADVISOR_PBX_PROXY=.*#AIADVISOR_PBX_PROXY=#' \
  -e 's#^AIADVISOR_VOICE_ENABLED=.*#AIADVISOR_VOICE_ENABLED=0#' \
  /src/services/ai-advisor/.env > /app/.env
grep -E '^(PGHOST|PGDATABASE|PGUSER|PGRO_USER|AIADVISOR_CRM_BASE|AIADVISOR_PBX_SOURCE|TRAINER_ENABLED|KB_REFRESH|AIADVISOR_SPEND_LEDGER)=' /app/.env || true

echo "== DB reachability"
set -a; . /app/.env; set +a
psql -h host.docker.internal -U "${PGUSER}" -d "${PGDATABASE}" -tAc "select version(), current_user" | cut -c1-80
psql -h host.docker.internal -U "${PGRO_USER}" -d "${PGDATABASE}" -tAc "select current_user, count(*) from property"

echo "== CRM reachability"
curl -s -o /dev/null -w 'crm :81 -> HTTP %{http_code}\n' http://host.docker.internal:81/ || echo "crm :81 unreachable"

echo "== claude creds"
ls -la /root/.claude/ | tail -n +2

echo "== typecheck"
npm run -s typecheck && echo "typecheck OK"
echo "== SETUP DONE"
