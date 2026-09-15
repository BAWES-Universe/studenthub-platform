#!/bin/bash -p
# Install this reviewed file root-owned and non-writable at
# /usr/local/libexec/shu-reviewer-sandbox. The coordinator invokes it through a
# narrowly-scoped sudo rule. It executes both phases of review as shu-reviewer:
# builder-authored tests use the no-network `test` profile and Claude uses the
# provider-network-only `model` profile. Both profiles share the same filesystem,
# process and identity boundary. Privileged bash mode prevents startup files,
# imported functions, BASH_ENV and caller shell options from running as root.
while IFS= read -r environment_name; do
  case "$environment_name" in
    CLAUDE_CODE_OAUTH_TOKEN|SUDO_UID) ;;
    *) unset "$environment_name" 2>/dev/null || true ;;
  esac
done < <(compgen -e)
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"
unset BASH_ENV ENV CDPATH GLOBIGNORE
set -euo pipefail

trusted_executable() {
  local configured="$1" canonical mode directory parent
  canonical="$(/usr/bin/realpath -e -- "$configured")"
  mode="$(/usr/bin/stat -c '%a' -- "$canonical")"
  if [[ ! -f "$canonical" || -L "$canonical" || ! -x "$canonical" ||
        "$(/usr/bin/stat -c '%u' -- "$canonical")" != "0" || $(( 8#$mode & 8#022 )) -ne 0 ]]; then
    return 1
  fi
  directory="$(/usr/bin/dirname -- "$canonical")"
  while :; do
    mode="$(/usr/bin/stat -c '%a' -- "$directory")"
    if [[ ! -d "$directory" || -L "$directory" || "$(/usr/bin/stat -c '%u' -- "$directory")" != "0" ||
          $(( 8#$mode & 8#022 )) -ne 0 ]]; then
      return 1
    fi
    parent="$(/usr/bin/dirname -- "$directory")"
    [[ "$parent" == "$directory" ]] && break
    directory="$parent"
  done
  printf '%s\n' "$canonical"
}

if [[ "$#" -lt 8 || "$1" != "--profile" || ( "$2" != "test" && "$2" != "model" ) ||
      "$3" != "--workspace-root" || "$5" != "--workspace" || "$7" != "--" ]]; then
  echo "reviewer sandbox requires an exact workspace binding and argv" >&2
  exit 64
fi

if [[ "$EUID" -ne 0 || ! "${SUDO_UID:-}" =~ ^[0-9]+$ || "${SUDO_UID:-0}" == "0" ]]; then
  echo "reviewer sandbox requires root execution from the deployed non-root coordinator" >&2
  exit 64
fi

profile="$2"
workspace_root="$4"
workspace="$6"
shift 7

# systemd 255's ProtectProc= hides other service identities but does not hide a
# concurrent process with the same uid. Serialize both reviewer profiles under
# a root-held lock so there is never a same-uid sibling reviewer to inspect.
exec 9>/run/lock/shu-reviewer-sandbox.lock
if ! /usr/bin/flock -n 9; then
  echo "reviewer sandbox refuses concurrent same-identity execution" >&2
  exit 75
fi

if [[ "$workspace_root" != /* || "$workspace" != /* || -L "$workspace_root" || -L "$workspace" ]]; then
  echo "reviewer sandbox paths must be absolute real directories" >&2
  exit 64
fi
canonical_root="$(/usr/bin/realpath -e -- "$workspace_root")"
canonical_workspace="$(/usr/bin/realpath -e -- "$workspace")"
if [[ ! -d "$canonical_root" || ! -d "$canonical_workspace" ||
      "$(/usr/bin/dirname -- "$canonical_workspace")" != "$canonical_root" ||
      ! "$(/usr/bin/basename -- "$canonical_workspace")" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "reviewer sandbox workspace is not a direct attempt child" >&2
  exit 64
fi
if [[ "$(/usr/bin/stat -c '%a' -- "$canonical_workspace")" != "750" ]]; then
  echo "reviewer sandbox workspace must have mode 0750" >&2
  exit 64
fi
workspace_uid="$(/usr/bin/stat -c '%u' -- "$canonical_workspace")"
if [[ "$workspace_uid" != "0" && "$workspace_uid" != "${SUDO_UID:-}" ]]; then
  echo "reviewer sandbox workspace must be root/coordinator-owned" >&2
  exit 64
fi

reviewer_uid="$(/usr/bin/id -u shu-reviewer)"
reviewer_gid="$(/usr/bin/id -g shu-reviewer)"
if [[ "$reviewer_uid" == "0" || "$reviewer_uid" == "${SUDO_UID:-}" ]]; then
  echo "reviewer sandbox requires a distinct non-root deployed reviewer identity" >&2
  exit 64
fi
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

# A checkout hardlink can bypass path-only masking: a protected inode linked
# under the allowed checkout remains the same readable object. Independent Git
# checkouts do not require working-tree hardlinks, so fail closed on any of them.
hardlinked_file="$(/usr/bin/find "$canonical_workspace" -xdev -type f -links +1 -print -quit)"
if [[ -n "$hardlinked_file" ]]; then
  echo "reviewer sandbox refuses hardlinked files in the assigned checkout" >&2
  exit 64
fi

systemd_args=()
while IFS= read -r -d '' sibling; do
  [[ "$sibling" == "$canonical_workspace" ]] && continue
  sibling_name="$(/usr/bin/basename -- "$sibling")"
  if [[ -L "$sibling" || ! -d "$sibling" || "$(/usr/bin/dirname -- "$(/usr/bin/realpath -e -- "$sibling")")" != "$canonical_root" ||
        ! "$sibling_name" =~ ^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\.shu-review-sibling-probe-[A-Za-z0-9]+)$ ]]; then
    echo "reviewer sandbox refuses an unsafe sibling workspace entry" >&2
    exit 64
  fi
  systemd_args+=("--property=InaccessiblePaths=$sibling")
done < <(/usr/bin/find "$canonical_root" -mindepth 1 -maxdepth 1 -print0)

# These are the deployed SHU-251/SHU-63 authority locations, not test-only
# stand-ins. The '-' prefix makes an absent optional class harmless while an
# existing path is always masked. `/srv/shu/state` covers activation records,
# workspace authority, supervisor state, evidence and coordinator-private logs.
for protected in \
  /srv/shu/state \
  /etc/shu \
  /srv/shu/service.env \
  /srv/shu/coordinator.env \
  /srv/shu/.gitkeys \
  /srv/shu/.ssh \
  /srv/shu/logs \
  /srv/shu/shu251-killswitch-demo.log \
  /srv/codex \
  /srv/shu/.claude \
  /home/shu-coordinator \
  /home/shu-worker \
  /root \
  /var/log \
  /run/log; do
  systemd_args+=("--property=InaccessiblePaths=-$protected")
done

if [[ "$profile" == "test" ]]; then
  if [[ "$1" != /* || "$(basename -- "$1")" != "node" ||
        "${2:-}" != "/srv/shu/studenthub-platform/.github/coordinator/review-execution-child.mjs" ]]; then
    echo "reviewer test profile accepts only the reviewed exact-head evidence child" >&2
    exit 64
  fi
  canonical_node="$(trusted_executable "$1")" || {
    echo "reviewer test profile requires a root-owned non-writable Node executable and path" >&2
    exit 64
  }
  shift
  set -- "$canonical_node" "$@"
  network_args=(
    "--property=PrivateNetwork=yes"
    "--property=RestrictAddressFamilies=AF_UNIX"
  )
  environment_args=()
else
  if [[ "$1" != "claude" || -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    echo "reviewer model profile accepts only subscription-authenticated Claude" >&2
    exit 64
  fi
  claude_path="$(command -v -- claude)"
  canonical_claude="$(trusted_executable "$claude_path")" || {
    echo "reviewer model profile requires a root-owned non-writable Claude executable" >&2
    exit 64
  }
  shift
  set -- "$canonical_claude" "$@"
  network_args=("--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6")
  # The reviewer necessarily receives its own bounded subscription credential.
  # It receives no coordinator, GitHub, Linear, SSH or supervisor credential.
  # Copy the one permitted value from this process environment without placing
  # the credential in systemd-run's inspectable command line.
  environment_args=("--setenv=CLAUDE_CODE_OAUTH_TOKEN")
fi

/usr/bin/systemd-run \
  --quiet \
  --wait \
  --pipe \
  --collect \
  --service-type=exec \
  --uid="$reviewer_uid" \
  --gid="$reviewer_gid" \
  "${network_args[@]}" \
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
  --property="ReadOnlyPaths=$canonical_workspace" \
  --property="NoExecPaths=$canonical_workspace" \
  --property="WorkingDirectory=$canonical_workspace" \
  "${systemd_args[@]}" \
  --setenv=HOME=/tmp/shu-reviewer-home \
  --setenv=PATH=/usr/local/bin:/usr/bin:/bin \
  --setenv=LANG=C.UTF-8 \
  --setenv=LC_ALL=C.UTF-8 \
  "${environment_args[@]}" \
  -- "$@"
