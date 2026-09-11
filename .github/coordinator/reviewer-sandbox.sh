#!/usr/bin/env bash
# Install this reviewed file root-owned and non-writable at
# /usr/local/libexec/shu-reviewer-sandbox. The coordinator invokes it through a
# narrowly-scoped sudo rule. It executes builder-authored tests as shu-reviewer
# in a transient systemd sandbox with no network and a read-only host tree.
set -euo pipefail

if [[ "$#" -lt 1 ]]; then
  echo "reviewer sandbox requires an argv" >&2
  exit 64
fi

exec /usr/bin/systemd-run \
  --quiet \
  --wait \
  --pipe \
  --collect \
  --service-type=exec \
  --uid=shu-reviewer \
  --gid=shu-reviewer \
  --property=PrivateNetwork=yes \
  --property=RestrictAddressFamilies=AF_UNIX \
  --property=ProtectSystem=strict \
  --property=ProtectHome=yes \
  --property=PrivateTmp=yes \
  --property=PrivateDevices=yes \
  --property=NoNewPrivileges=yes \
  --property=CapabilityBoundingSet= \
  --property=InaccessiblePaths=/run \
  --property=InaccessiblePaths=/var/run \
  --property=ProtectProc=invisible \
  --property=ProcSubset=pid \
  --property=ProtectKernelTunables=yes \
  --property=ProtectKernelModules=yes \
  --property=ProtectKernelLogs=yes \
  --property=ProtectControlGroups=yes \
  --property=ProtectClock=yes \
  --property=LockPersonality=yes \
  --property=RestrictNamespaces=yes \
  --property=RestrictRealtime=yes \
  --property=RestrictSUIDSGID=yes \
  --property=UMask=0077 \
  --setenv=HOME=/nonexistent \
  --setenv=LANG=C.UTF-8 \
  --setenv=LC_ALL=C.UTF-8 \
  -- "$@"
