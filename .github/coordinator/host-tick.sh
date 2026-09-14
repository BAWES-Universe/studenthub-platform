#!/usr/bin/env bash
# One explicitly armed tick; an operator-owned driver may repeat this command.
# This script neither creates an activation nor enables dispatch.
set -euo pipefail
if [[ $# != 2 || ! "$2" =~ ^[0-9a-f]{40}$ || "$1" != /* ]]; then
  echo 'usage: host-tick.sh /absolute/activation.json <40-character initial lane head>' >&2
  exit 2
fi
: "${SHU_WORKTREE_ROOT:?approved workspace root required}"
: "${SHU_WORKSPACE_STATE_DIR:?private workspace state directory required}"
if [[ "${ENABLE_DISPATCH:-false}" != true ]]; then
  echo 'runtime dispatch gate is off; nothing started' >&2
  exit 2
fi
coordinator_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export DISPATCH_TARGET_SHA="$2"
# Same lock for every driver using this reviewed state directory. Never steal a
# live tick's lock; do not let overlapping operator loops reach launch together.
exec flock --nonblock --conflict-exit-code 2 \
  "$SHU_WORKSPACE_STATE_DIR/host-tick.lock" \
  node "$coordinator_dir/reconcile.mjs" --activation "$1"
