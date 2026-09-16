#!/bin/sh
set -eu

# Typed operational-binding entry point for composition by the separately
# approved host-window package. Lifecycle execution requires driver approval.
if [ "$#" -lt 2 ]; then
  echo '{"ok":false,"code":"SHU251_WINDOW_USAGE","reason":"expected ACTION and absolute spec path"}' >&2
  exit 64
fi
case "$1" in
  inventory|quiescence|transport|launch|worker|replay-release|cleanup|capture-prior|rollback)
    if [ "$#" -ne 2 ]; then
      echo '{"ok":false,"code":"SHU251_WINDOW_USAGE","reason":"expected ACTION and absolute spec path"}' >&2
      exit 64
    fi
    ;;
  preflight|install|start|readiness|restart|host-rollback|pin|pin-restore|pin-retain) ;;
  *) echo '{"ok":false,"code":"SHU251_WINDOW_ACTION","reason":"unknown typed action"}' >&2; exit 64 ;;
esac
case "$2" in /*) ;; *) echo '{"ok":false,"code":"SHU251_WINDOW_SPEC","reason":"spec path must be absolute"}' >&2; exit 64 ;; esac
# Lifecycle actions take a driver spec and the driver's closed approval flags.
# The driver defaults to a dry run; this wrapper never manufactures approval.
case "$1" in
  preflight|install|start|readiness|restart|host-rollback|pin|pin-restore|pin-retain)
    exec /usr/bin/node "$(dirname "$0")/phase-a-driver.mjs" "$@" ;;
esac
exec /usr/bin/node "$(dirname "$0")/host-window-bindings.mjs" "$1" "$2"
