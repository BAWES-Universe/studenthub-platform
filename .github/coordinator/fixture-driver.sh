#!/usr/bin/env bash
set -euo pipefail
: "${SHU_WORKSPACE_STATE_DIR:?private operator state directory required}"
coordinator_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# Same lock as host-tick; serializes operators without waiting on a worker.
exec flock --nonblock --conflict-exit-code 2 \
  "$SHU_WORKSPACE_STATE_DIR/host-tick.lock" \
  node "$coordinator_dir/fixture-driver-cli.mjs" "$@"
