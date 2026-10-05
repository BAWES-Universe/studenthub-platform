# Runtime closure verification

Base: `c8aedb21ee99ef195086792d8c145b0384b41b06`.
Clone: `/home/bawes/work/imgfix2`; branch: `fix/gateway-runtime-closure`.
The final commit SHA and final commit-labelled image result are reported in the
completion message (a commit cannot contain its own SHA).

## Commands, counted separately

Both repository and coordinator commands used `umask 0002` after
`chmod -R go-w .github/coordinator` as requested. No coordinator content changed.

| Command | Result |
| --- | --- |
| `npm test` | 416 passed, 0 failed/skipped: 389 Node tests + 27 Vitest tests; also 79 standalone mutation kills and the synthetic exercise |
| `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | 862 total: 855 passed, 7 skipped, 0 failed |
| `node --test deploy/coolify/test/runtime-closure.test.mjs` | 16 passed, 0 failed/skipped; includes 10 named mutation kills |
| `node --test deploy/coolify/test/*.test.mjs` | 40 passed, 0 failed/skipped; includes the preceding 16 |

The focused runs are not added to the root total. Root subcommands:

| Root test phase | Tests passed / mutations killed |
| --- | --- |
| Initial compiled Node test list | 258 tests |
| test:profile:mutations | 10 mutations |
| test:idempotency:mutations | 3 mutations |
| test:assertion | 27 tests |
| test:deployment | 40 tests |
| test:web | 15 tests |
| test:documents | 19 tests |
| test:documents:mutations | 17 mutations |
| test:documents:hardening | 10 tests |
| test:documents:hardening:mutations | 10 mutations |
| test:observability | 15 tests |
| test:observability:mutations | 17 mutations |
| exercise:observability | passed |
| test:documents:lifecycle | 25 tests |
| test:documents:lifecycle:mutations | 22 mutations |
| test:documents:r2 | 7 tests |

## Real Docker verification

Docker used `DOCKER_CONFIG=/tmp/imgfix2-docker-config`, whose sole configuration
is `{"auths":{}}`. Built the untouched base as `imgfix2-before` and the changed
Dockerfile as `imgfix2-after`. A disposable Postgres 17 container on the isolated
`imgfix2-smoke` Docker network supplies the database, without source mounts.

The existing smoke script passes HTTP 200 using the normal migration/preflight
entrypoint, then passes the added content assertion in the same running container.
An initial attempt raced Postgres readiness and failed with ECONNREFUSED; after
`pg_isready` passed, the unchanged smoke gate passed. The base also built cleanly.

| Application inventory (`/app`, including node_modules) | Before | After |
| --- | ---: | ---: |
| TypeScript, including declarations | 4538 | 0 |
| Source maps | 2780 | 0 |
| Test files (test directory or `.test`/`.spec` JS) | 130 | 0 |
| Image size, Docker `.Size` bytes | 298461508 | 253704289 |

Reduction: 44,757,219 bytes (15.00%). The first-party-only before inventory was
270 TypeScript files, 156 maps, and 126 test files; the broader counts above
include dependencies and emitted declarations. All corresponding after counts
are zero. All 8 closure workspace links resolve, including every retained
`@studenthub` link; unused workspace links/manifests are absent. The closure
contains 70 JavaScript files and 5 migration SQL assets.

See [IMAGE-SMOKE.md](IMAGE-SMOKE.md#current-closure-and-file-classes) for each
closure package and its staged file classes. Required runtime exceptions are
explicit there: emitted JavaScript under `dist/**/src`, third-party executable
JavaScript directories named `src`, and profile's unconditionally re-exported
compiled `fixtures.js`. Therefore this does **not** claim zero directory names
`src` or zero filenames containing `fixtures`; it claims zero source trees and
zero TypeScript/maps/test files. Application code and exports were not changed.

## Every new test

1. `runtime closure follows transitive dependencies and add/remove/devDependency mutations`
2. `runtime closure follows emitted relative imports and worker URLs without unrelated output`
3. `runtime closure fails closed on nonliteral dynamic imports`
4. `runtime closure mutation killed: ignore added runtime dependency`
5. `runtime closure mutation killed: retain removed runtime dependency`
6. `runtime closure mutation killed: follow devDependencies`
7. `staging bounds manifests emitted JavaScript and SQL migrations and excludes source tests credentials and unused output`
8. `image content mutation killed: TypeScript source`
9. `image content mutation killed: source map`
10. `image content mutation killed: test file`
11. `image content mutation killed: source tree`
12. `image content mutation killed: unrelated workspace`
13. `image content mutation killed: missing closure manifest`
14. `image content mutation killed: dangling workspace link`
15. `image smoke keeps the HTTP 200 gate and then asserts image contents in the same container`
16. `unused emitted module cannot grant workspace runtime authority`

## Named mutation failures

- `ignore added runtime dependency: AssertionError [CLOSURE_ADD_RUNTIME]`
- `retain removed runtime dependency: AssertionError [CLOSURE_REMOVE_RUNTIME]`
- `follow devDependencies: AssertionError [CLOSURE_DEV_ONLY]`
- `TypeScript source: AssertionError [IMAGE_CONTENT_CLASSES]`
- `source map: AssertionError [IMAGE_CONTENT_CLASSES]`
- `test file: AssertionError [IMAGE_CONTENT_CLASSES]`
- `source tree: AssertionError [IMAGE_CONTENT_BOUNDED]`
- `unrelated workspace: AssertionError [IMAGE_CONTENT_BOUNDED]`
- `missing closure package: AssertionError [IMAGE_CONTENT_COMPLETE]`
- `dangling workspace link: AssertionError [IMAGE_CONTENT_CLASSES]`

## Scope and limits

Dispatch remains disabled (`enable_dispatch: false`). No host or `/srv` access,
remote deployment, Coolify action, coordinator content change, dispatch config
change, or workflow trigger change occurred. The GitHub-hosted job was not run;
its real build and smoke commands were run locally. No push was requested or done.

The parser explicitly rejects nonliteral module references and wildcard exports;
future use must extend resolution rather than silently widen packaging authority.
The image inventory covers `/app`, not OS/vendor files elsewhere in the base image.
