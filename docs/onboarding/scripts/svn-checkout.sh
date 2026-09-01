#!/usr/bin/env bash
# Waterfind AUS CRM — SVN checkout helper (Iteration45)
# Prereqs: SlikSVN installed; ~/.ssh/waterfind_svn.pem in place; ~/.ssh/config + %APPDATA%/Subversion/config set up.
# Fill SVN_USERNAME (and have the key passphrase ready) in the repo .env before running.
set -euo pipefail

ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/.env"
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a || { echo "No .env at $ENV_FILE"; exit 1; }

: "${SVN_USERNAME:?Set SVN_USERNAME in .env (the linux/SVN account username)}"
REPO="${SVN_REPO_URL:-svn+ssh://svn.nowmarketservices.com/svn/repo/WaterfindDev}"
BRANCH="${SVN_BRANCH:-Iteration45}"
DEST="${1:-$HOME/WaterfindWorkspace}"            # checkout target (Eclipse workspace, OUTSIDE this git repo)
URL="svn+ssh://${SVN_USERNAME}@${REPO#svn+ssh://}"

PROJECTS="dataimport datascraper MyobService NotificationService pbxapp waterfind.com.au waterfindServiceModel"

echo ">> Repo:   $URL"
echo ">> Branch: $BRANCH"
echo ">> Dest:   $DEST"
echo
echo ">> Step 1: inspect repo layout (confirms where Iteration45 lives per project)."
echo "   Run and read this before bulk checkout — the branch path pattern below is a GUESS:"
echo "     svn list \"$URL\""
echo "     svn list \"$URL/waterfind.com.au\""
echo
echo ">> Step 2: checkout. Adjust BRANCH_PATH to match the real layout from Step 1."
echo "   Common patterns:  <project>/branches/<branch>   OR   branches/<branch>/<project>"
mkdir -p "$DEST"
for p in $PROJECTS; do
  BRANCH_PATH="$URL/$p/branches/$BRANCH"          # <-- EDIT if Step 1 shows a different layout
  echo "---- $p ----"
  echo "svn checkout \"$BRANCH_PATH\" \"$DEST/$p\""
  # Uncomment to actually run once the layout is confirmed:
  # svn checkout "$BRANCH_PATH" "$DEST/$p"
done
echo
echo ">> After checkout: for dataimport, MyobService, pbxapp, waterfind.com.au,"
echo "   copy local-server-dev.properties.sample -> local-server-dev.properties and edit (see onboarding_log.md §4)."
