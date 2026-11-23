#!/bin/sh
# Installs the pinned Node runtime (tools/legacy-import/node-runtime.txt: version, platform and the
# sha256 of the official release archive) into this checkout's .runtime/node. The M-4 build pin and
# the staging install both run this, then build with that runtime, so its bytes are in the digest.
set -eu
root=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/../.." && pwd -P)
read -r version platform sum < "$root/tools/legacy-import/node-runtime.txt"
name="node-$version-$platform"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$version/$name.tar.xz" -o "$work/$name.tar.xz"
echo "$sum  $work/$name.tar.xz" | sha256sum -c --quiet -
rm -rf "$root/.runtime/node"
mkdir -p "$root/.runtime/node"
tar -xJf "$work/$name.tar.xz" -C "$root/.runtime/node" --strip-components=1 --no-same-owner
"$root/.runtime/node/bin/node" -e 'process.stdout.write(`m4 runtime node=${process.versions.node}\n`)'
