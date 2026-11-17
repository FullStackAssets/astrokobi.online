#!/bin/bash
# astrokobi.online publisher run - mirrors .github/workflows/generate.yml (cron 0 * * * *)
# Triggered by systemd timer publishers-astrokobionline.timer.
set -euo pipefail

REPO_DIR="/home/ubuntu/products/publishers/astrokobi.online"
LOG_DIR="$REPO_DIR/.publish-logs"
export PATH="/opt/node24/bin:$PATH"

mkdir -p "$LOG_DIR"
exec >>"$LOG_DIR/run-$(date -u +%Y-%m-%dT%H%M%SZ).log" 2>&1

echo "=== run-publish start: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

cd "$REPO_DIR"

# Secrets: read from $REPO_DIR/.env (chmod 600, NOT committed).
if [ -f "$REPO_DIR/.env" ]; then
  set -a; . "$REPO_DIR/.env"; set +a
fi

if [ -z "${GROQ_API_KEY:-}" ]; then
  echo "BLOCKED: GROQ_API_KEY not set in $REPO_DIR/.env. Refusing template-mode generation on live main." >&2
  exit 1
fi

git pull --ff-only

if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "node_modules missing - running npm ci"
  npm ci --no-audit --no-fund
fi

export NEXT_PUBLIC_SITE_VARIANT="astrokobi-online"
echo "--- generation: npx tsx scripts/run-local.ts ---"
npx tsx scripts/run-local.ts

git config user.name "trendblog-bot"
git config user.email "bot@trendblog.dev"
git config merge.topiclog.name "union topic log entries"
git config merge.topiclog.driver "node scripts/merge-topic-log.mjs %O %A %B"

git add content/
if git diff --cached --quiet; then
  echo "No new content generated - nothing to do."
  exit 0
fi

git commit -m "post: $(date -u +%Y-%m-%dT%H:00Z) hourly dispatch"
branch="${GIT_BRANCH:-main}"

for attempt in 1 2 3 4 5; do
  if git push origin "HEAD:${branch}"; then
    echo "Pushed on attempt ${attempt}; the Pages workflow will publish the commit."
    echo "=== run-publish done: $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}); rebasing onto origin/${branch}."
  git fetch origin "${branch}"
  if ! git rebase "origin/${branch}"; then
    git rebase --abort || true
    echo "Rebase failed on attempt ${attempt}." >&2
  fi
done

echo "Failed to push generated content after five attempts." >&2
exit 1
