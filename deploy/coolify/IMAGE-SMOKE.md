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

## Mechanically derived runtime closure

`stage-workspaces.mjs` exports `runtimeClosure` for direct testing. It discovers
workspace names and paths from lockfile links, validated by `npm ci`. Those links
are candidates, not permission to ship a workspace. The only application process
is the gateway; its entrypoint also runs the DB migration executable.

The algorithm is a fixed-point traversal seeded by the gateway manifest and the
emitted gateway and migration entrypoints. For each reached workspace it follows
`package.json` **dependencies**, never `devDependencies`, transitively. It follows
that package's runtime exports/main entrypoints and parses emitted imports, re-exports, literal
`import()`/`require()` calls, and `new URL(..., import.meta.url)` worker references
with the build-only TypeScript parser. Relative edges are followed recursively;
paths under a locked workspace grant that workspace membership. This captures
private-documents and idempotency-contract despite their relative imports, plus
observability (which is not an npm workspace). Type-only imports disappeared in
compilation and confer no membership. Nonliteral imports/worker URLs fail the
build rather than silently omitting code. Unsupported wildcard exports fail explicitly; adding one requires extending the resolver.
Unreferenced emitted modules cannot grant additional workspace authority.
Results are sorted and serialized to
`/app/runtime-closure.json`. There is no package-name allowlist.

A newly referenced workspace enters automatically through a production dependency
or emitted import; removing its last runtime edge excludes it. The staging tree
contains only closure manifests, emitted `.js`/`.mjs`/`.cjs` output, and DB SQL
migrations. The one asset rule is explicit: `migrate.js` reads
`packages/db/migrations/*.sql` at startup; unknown migration file classes fail the
build. Manifest `files` fields cannot authorize arbitrary assets. No source tree,
TypeScript (including declarations), map, test suite, docs, tools, credentials,
or unrelated root build output is copied. Only the entrypoint, preflight, and
content assertion are copied from deployment tooling.

After staging, npm prunes development dependencies. Unused workspace links are
removed again because npm can recreate them during prune. Every retained link
must resolve to its matching closure manifest; excluded workspaces have neither
a manifest nor a link. Third-party production packages retain their runtime
files, with TypeScript, maps, tests, fixtures directories, docs and tools removed.

### Required runtime exceptions

The prohibition is on **source files**, not the spelling of an emitted runtime
path. Root TypeScript output uses `dist/**/src/*.js`; these files are reachable
compiled JavaScript, not repository `src/` trees. Existing relative imports and
the entrypoint require these paths. Published debug, OpenTelemetry and vendored
Sentry dependencies likewise use `src/` paths for executable JavaScript. These
runtime directories remain; a literal assertion that there are zero directories
named `src` anywhere would be false. No `.ts` files remain even in these paths.

`packages/profile/dist/fixtures.js` is a required compiled runtime exception:
profile's public `index.js` unconditionally re-exports it, so Node must load it
when the gateway imports profile. It contains synthetic profile data. Removing
it requires an application/export change, outside this packaging fix. No fixture
suite or fixture directory is staged. Other exported built modules (for example
login-contract conformance) remain part of their package's built output.

### Current closure and file classes

| Workspace | Staged file classes |
| --- | --- |
| `@bawes/actor-assertion` | package.json; package-local dist JavaScript |
| `@studenthub/contracts` | package.json; package-local dist JavaScript; reached root dist JavaScript |
| `@studenthub/db` | package.json; package-local dist JavaScript; migration SQL |
| `@studenthub/gateway` | package.json; reached root dist JavaScript |
| `@studenthub/idempotency-contract` | package.json; package-local dist JavaScript; reached root dist JavaScript |
| `@studenthub/login-contract` | package.json; package-local dist JavaScript |
| `@studenthub/private-documents` | package.json; reached root dist JavaScript |
| `@studenthub/profile` | package.json; package-local dist JavaScript, including the required fixtures.js export |

Observability contributes only reached root dist JavaScript, including the
telemetry worker. The worker application, search, safe-write-contract,
source-connection-contract and all four tool workspaces are excluded.

### Assertions and mutation coverage

The existing `/health == 200` assertion is unchanged. Only after it passes does
the smoke script execute `assert-image-content.mjs` inside that same container.
The content assertion requires a nonempty manifest/code/asset inventory, every
closure file and package link, exact absence of excluded workspace manifests,
bounded first-party files, zero TypeScript/maps/test files, zero repository source
trees, and zero dangling workspace links. It scans `/app`, including third-party
node_modules; OS-distribution files outside `/app` are not application inventory.

`runtime-closure.test.mjs` directly exercises add/remove/devDependency mutations,
relative imports, worker references, fail-closed dynamic imports, bounded staging,
and the image gate wiring. Algorithm mutants must throw named `AssertionError`s:
`CLOSURE_ADD_RUNTIME`, `CLOSURE_REMOVE_RUNTIME`, and `CLOSURE_DEV_ONLY`.
Content mutations inject TypeScript/maps/tests, source trees, unused packages,
missing manifests and dangling links; each must fail the relevant
`IMAGE_CONTENT_CLASSES`, `IMAGE_CONTENT_BOUNDED`, or `IMAGE_CONTENT_COMPLETE`
assertion. These tests run through the existing root `npm test` deployment glob.

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
