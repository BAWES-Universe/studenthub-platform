#!/bin/bash
# Verification only: private user/mount namespaces; the host is never changed.
# Invoke from the repository root with the exact test command as argv.
set -euo pipefail
case "${1:-}" in
  --mount)
    shift
    scratch=$1
    shift
    mount --make-rprivate /
    mount --bind "$scratch/passwd" /etc/passwd
    mount --bind "$scratch/group" /etc/group
    mount --bind "$scratch/nsswitch.conf" /etc/nsswitch.conf
    mount -t tmpfs -o mode=0755 tmpfs /run
    mount -t tmpfs -o mode=0755 tmpfs /etc/sudoers.d
    exec unshare --user --map-user=1000 --map-group=1000 "$0" --run "$@"
    ;;
  --run)
    shift
    umask 0022
    test "$(id -u)" = 1000
    for account in shu71-evidence shu-coordinator shu-workspace messagebus; do
      if getent passwd "$account" || getent group "$account"; then exit 1; fi
    done
    test ! -e /run/shu71-evidence
    test ! -e /etc/sudoers.d/shu-reviewer
    printf 'CI_CONSTRAINTS uid=%s umask=%s target_accounts=absent runtime=absent reviewer=absent\n' "$(id -u)" "$(umask)" >&2
    exec "$@"
    ;;
esac
scratch=$(mktemp -d /tmp/shu71-ci-like.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
awk -F: '$1 !~ /^(shu71-evidence|shu-coordinator|shu-workspace|messagebus)$/' /etc/passwd > "$scratch/passwd"
awk -F: '$1 !~ /^(shu71-evidence|shu-coordinator|shu-workspace|messagebus)$/' /etc/group > "$scratch/group"
printf 'passwd: files\ngroup: files\nshadow: files\nhosts: files dns\n' > "$scratch/nsswitch.conf"
unshare --user --map-root-user --mount "$0" --mount "$scratch" "$@"
