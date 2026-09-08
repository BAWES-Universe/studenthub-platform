#!/bin/sh
set -eu

node deploy/coolify/preflight.mjs
node packages/db/dist/migrate.js
exec node dist/apps/gateway/src/index.js
