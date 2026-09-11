#!/usr/bin/env bash
# Install this reviewed file root-owned and non-writable at
# /usr/local/libexec/shu-reviewer-sandbox. The coordinator invokes it through a
# narrowly-scoped sudo rule. It executes builder-authored tests as shu-reviewer
# in a transient systemd sandbox with no network, a read-only host tree, and no
# view of sibling attempt workspaces.
set -euo pipefail

if [[ "$#" -lt 6 || "$1" != "--workspace-root" || "$3" != "--workspace" || "$5" != "--" ]]; then
  echo "reviewer sandbox requires an exact workspace binding and argv" >&2
  exit 64
fi

workspace_root="$2"
workspace="$4"
shift 5

if [[ "$workspace_root" != /* || "$workspace" != /* || -L "$workspace_root" || -L "$workspace" ]]; then
  echo "reviewer sandbox paths must be absolute real directories" >&2
  exit 64
fi
canonical_root="$(realpath -e -- "$workspace_root")"
canonical_workspace="$(realpath -e -- "$workspace")"
if [[ ! -d "$canonical_root" || ! -d "$canonical_workspace" ||
      "$(dirname -- "$canonical_workspace")" != "$canonical_root" ||
      ! "$(basename -- "$canonical_workspace")" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "reviewer sandbox workspace is not a direct attempt child" >&2
  exit 64
fi
if [[ "$(stat -c '%a' -- "$canonical_workspace")" != "750" ]]; then
  echo "reviewer sandbox workspace must have mode 0750" >&2
  exit 64
fi
workspace_uid="$(stat -c '%u' -- "$canonical_workspace")"
if [[ "$workspace_uid" != "0" && "$workspace_uid" != "${SUDO_UID:-}" ]]; then
  echo "reviewer sandbox workspace must be root/coordinator-owned" >&2
  exit 64
fi

reviewer_uid="$(id -u shu-reviewer)"
if /usr/bin/getfacl -cpn -- "$canonical_workspace" | /usr/bin/grep -q "^user:${reviewer_uid}:"; then
  echo "reviewer sandbox refuses a persistent reviewer workspace ACL" >&2
  exit 64
fi

# Access exists only for this invocation. The trap removes it on success,
# refusal, signal, or systemd failure; sibling paths are additionally masked in
# the transient mount namespace, including siblings that predate mode 0750.
/usr/bin/setfacl -m "u:${reviewer_uid}:r-x" -- "$canonical_workspace"
cleanup() { /usr/bin/setfacl -x "u:${reviewer_uid}" -- "$canonical_workspace" || true; }
trap cleanup EXIT HUP INT TERM

systemd_args=()
while IFS= read -r -d '' sibling; do
  [[ "$sibling" == "$canonical_workspace" ]] && continue
  sibling_name="$(basename -- "$sibling")"
  if [[ -L "$sibling" || ! -d "$sibling" || "$(dirname -- "$(realpath -e -- "$sibling")")" != "$canonical_root" ||
        ! "$sibling_name" =~ ^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\.shu-review-sibling-probe-[A-Za-z0-9]+)$ ]]; then
    echo "reviewer sandbox refuses an unsafe sibling workspace entry" >&2
    exit 64
  fi
  systemd_args+=("--property=InaccessiblePaths=$sibling")
done < <(/usr/bin/find "$canonical_root" -mindepth 1 -maxdepth 1 -print0)

/usr/bin/systemd-run \
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
  --property="WorkingDirectory=$canonical_workspace" \
  "${systemd_args[@]}" \
  --setenv=HOME=/nonexistent \
  --setenv=LANG=C.UTF-8 \
  --setenv=LC_ALL=C.UTF-8 \
  -- "$@"
