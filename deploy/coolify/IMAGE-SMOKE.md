# Gateway image delivery gate

`Platform CI` runs job `image-smoke` (check name `gateway-image-smoke`) on
all pull requests and pushes to main, without path filters or allowed failures.
It builds the root Dockerfile with `SOURCE_REVISION=${GITHUB_SHA}`, then runs
`bash deploy/coolify/image-smoke.sh gateway-image-smoke`. The normal entrypoint
validates configuration and applies migrations to disposable Postgres 17 before
starting the gateway. The assertion is:

```
IMAGE_SMOKE: /health must return 200 from the built image
```

It probes inside the newly started container, requires exactly HTTP 200 within
90 seconds, prints container logs on failure, and removes the container on exit.
The job has read-only repository permission, no secrets, no registry push or
deploy, and uses the compose-validation example.test URLs and
`ci-only-placeholder` credentials. It adds `/profile` to the allowed return URLs
because the real startup preflight requires it. Postgres matches fast-checks.
These properties make it suitable as a required check on every PR. Making the
check mandatory in GitHub branch protection is an external repository setting;
this change does not modify repository settings.

## Workspace inventory and packaging choice

Runtime imports in `apps/gateway/src` reference these workspace packages by name:

- `@bawes/actor-assertion`: authz middleware/audit and login runtime.
- `@studenthub/contracts`: server and authz middleware.
- `@studenthub/db`: login and candidate-document runtimes.
- `@studenthub/login-contract`: login application/runtime.
- `@studenthub/profile`: login runtime and web UI.

Relative runtime imports also reference `packages/private-documents/src` from
the candidate-document HTTP/runtime modules, and `packages/observability/src`
from the server and authz middleware. Their JavaScript is emitted under the root
`dist/packages` tree, which is retained in full. Observability has no workspace
manifest. Private-documents has a manifest but no package-local build or exports;
its runtime code is in root `dist`, not `packages/private-documents/dist`.

The build copies the context before `npm ci`, so npm sees every workspace
manifest and validates it against the lockfile. After build and production prune,
`stage-workspaces.mjs` copies the sorted unique workspace targets from lockfile
links into a staging tree. Runtime copies that tree plus root `dist` and production
`node_modules`. This preserves profile's manifest and package-local dist,
private-documents' manifest, all workspace symlink targets, and assets such as
DB migrations without maintaining another package or asset list. The tradeoff is
less dependency-layer caching and some extra workspace source/test files in the
image. Adding a workspace needs no Dockerfile edit; a stale lockfile fails npm ci.

## Local reproduction and mutation

With a disposable Postgres reachable from Docker, build with:

```sh
docker build --file Dockerfile --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" --tag gateway-image-smoke .
DATABASE_URL=postgres://postgres:ci-only-placeholder@localhost:55432/studenthub_authz \
  bash deploy/coolify/image-smoke.sh gateway-image-smoke
```

For a Docker bridge network, set `IMAGE_SMOKE_NETWORK` and
`PLATFORM_DATABASE_HOSTS` to the disposable network and database alias, and use
that alias in `DATABASE_URL`. No source bind mounts are used.

To test sensitivity without modifying the source image, build a throwaway derived
image with `FROM gateway-image-smoke`, `USER root`,
`RUN rm -rf /app/packages/profile`, and `USER node`. Run the same smoke script
against that image and require exit 1 with the named assertion and a missing
`@studenthub/profile` preflight error. The unmodified image must exit 0.

## Verification in the delivery-gate fix clone

- Real Docker build: passed with source revision
  `40246c4b774f8344d2594f29e539a146f9913adc` (main at the start of this fix).
  The initial attempt failed on the local desktop credential helper; retrying
  with an empty temporary `DOCKER_CONFIG` succeeded.
- Unmodified image, same smoke script, disposable Postgres on a Docker bridge:
  exit 0, `PASS: IMAGE_SMOKE: /health must return 200 from the built image`.
- Throwaway derived image with `/app/packages/profile` removed: exit 1,
  `FAIL: IMAGE_SMOKE: /health must return 200 from the built image`.
  Container log: `deployment preflight failed: Cannot find package
  '@studenthub/profile' imported from /app/dist/apps/gateway/src/login-runtime.js`.
- Root `npm test`: exit 0; 400 tests passed, zero failures/skips, 79 mutations
  killed, and the observability synthetic exercise passed.
- `umask 0002 && chmod -R go-w .github/coordinator && node --test
  .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs`:
  exit 0; 862 tests, 855 passed, 7 skipped, zero failures.

No GitHub workflow run or branch-protection update was performed; no push,
PR interaction, deployment, or Coolify action was performed.
