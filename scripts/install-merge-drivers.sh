#!/usr/bin/env bash
# Register career-ops git merge drivers in the local .git/config.
# Run once after cloning or after a fresh git clone.
#
# Usage: bash scripts/install-merge-drivers.sh
#
# The .gitattributes file declares *which* files use a custom driver;
# this script registers the driver *command* that handles them.
# git requires both — .gitattributes alone is a no-op without the registration.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git config merge.jsonl-union.name "JSONL union merge — dedup by id, latest last_updated wins"
git config merge.jsonl-union.driver "node scripts/jsonl-merge-driver.mjs %O %A %B %L %P"

echo "[install-merge-drivers] Registered: merge.jsonl-union"
echo "[install-merge-drivers] Applies to: data/bug-ledger.jsonl, regression-bug-queue.jsonl, v2-fix-log.jsonl, v2-rollback-counter.jsonl"
echo "[install-merge-drivers] Verify: git config --get merge.jsonl-union.driver"
