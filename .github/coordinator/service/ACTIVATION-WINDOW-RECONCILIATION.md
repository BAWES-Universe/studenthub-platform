# Activation-window reconciliation: partial checkpoint

## Completion boundary

Items 1–2 and their Item 6 controls are implemented. **Items 3–4 are incomplete**:
there is no owner-approved committed public SPKI PEM, `config.json` has no
`two_fixture_activation_public_key`, and `shu71-trust-anchor.json` retains a null
fingerprint with `state: owner-authority-required`. The owner-approved Ed25519
public PEM and expected SHA-256 SPKI fingerprint were requested. No test key was
promoted into authority. The two SHU-71 verification paths remain unchanged;
no unified public source or named public-key load path is claimed. Their positive
controls and fingerprint/foreign-key/load-path mutations are **not implemented**.
This checkpoint does not complete the requested reconciliation PR.

Start SHA: `9dc776977870f9bf32a43a82d3e40d4cae8bed11`.
History contains #124 (`9dc7769`), #122 (`037efdf`), #121 (`199f044`).
Work and local commit take place in `/home/bawes/work/recons`, on
`chore/activation-window-reconciliation`; main is unchanged. No push or PR action.

## Item 1: interface and refusal

The service parameter shape replaces the shared field with:

```js
{
  supervisorEnvironmentFile: '/etc/shu/supervisor.env',
  coordinatorEnvironmentFile: '/srv/shu/service.env'
}
```

`serviceParameters` validates both path strings with the unchanged character
class, absolute-path rule and prohibition on dot/dot-dot segments. `render` and
`assertPolicy` additionally inspect both files before accepting any units.
`install` already calls both, so its existing interface inherits these checks
without an installer rewrite. `verify` provisions temporary random credential
fixtures, never host credentials. The templates have separate placeholders.

The real crossing and missing-file predicates are:

```js
assert.notEqual(supervisorEnvironmentFile, coordinatorEnvironmentFile,
  'SHU251_ENV_IDENTICAL: environment files must be distinct');
assert.ok(supervisorEnvironmentFile !== '/srv/shu/service.env'
  && coordinatorEnvironmentFile !== '/etc/shu/supervisor.env',
  'SHU251_ENV_CROSSED: environment file paths belong to the other unit');
assert.ok(stat, 'SHU251_ENV_MISSING: required environment file is absent');
assert.ok(stats[0].dev !== stats[1].dev || stats[0].ino !== stats[1].ino,
  'SHU251_ENV_IDENTICAL: environment files must not share an inode');
assert.ok(!supervisor.has('GITHUB_TOKEN') && !supervisor.has('LINEAR_API_TOKEN')
  && !coordinator.has('SHU_SUPERVISOR_SECRET'),
  'SHU251_ENV_CROSSED: environment contents belong to the other unit');
```

Only regular non-symlink files are accepted. The supervisor map must have exactly
one entry, its secret of at least 32 bytes. The coordinator map must contain
nonempty GitHub and Linear credentials. Duplicate assignments and ambiguous
quoting/escaping are refused. Diagnostics never contain credential values.
Missing required files also fail systemd startup because neither directive uses
an optional `-` prefix. The original identity, readiness, restart, child retention,
flock, supervisor dependency, timer target, no-secret-literal and dispatch-off
assertions remain enforced.

The coordinator transport still reads its supervisor authentication value from
its process environment. The decided coordinator credential file does not supply
that value; delivery requires separately reviewed transport provisioning. This
checkpoint does not claim a usable deployed transport or modify transport code.
Supervisor root:root 0600 provisioning is documented; no host ownership audit
was run. The accepted environment-file syntax is deliberately narrower than all
systemd environment-file syntax: single-line assignments, optional matching quotes
without escapes, blank lines and comments.

## Controls and named mutations

The new reconciliation file executes 17 tests: 3 positive-control tests and
14 mutation tests. Existing staging/syntax controls additionally exercise the
new pair with actual rendered units and installer transactions.

| Item | Positive control | Mutation | Named assertion |
| --- | --- | --- | --- |
| 1 | `RECON_ENV_POSITIVE`: distinct roles render, pass policy and retain both defaults | Swap temporary paths or reverse canonical paths | `SHU251_ENV_CROSSED` |
| 1 | same | Identical paths or hardlinked files | `SHU251_ENV_IDENTICAL` |
| 1 | same | Supervisor absent | `SHU251_ENV_MISSING` |
| 1 | same | Coordinator absent | `SHU251_ENV_MISSING` |
| 1 | same | Supervisor points at coordinator contents | `SHU251_ENV_CROSSED` |
| 1 | same | Coordinator points at supervisor contents | `SHU251_ENV_CROSSED` |
| 1 | same | Unsafe supervisor absolute path | `SHU251_SECRET_FILE` |
| 1 | same | Unsafe coordinator absolute path | `SHU251_SECRET_FILE` |
| 1 | same | GitHub credential missing / empty | `SHU251_ENV_COORDINATOR` / `SHU251_ENV_CONTENT` |
| 1 | same | Linear credential missing / empty | `SHU251_ENV_COORDINATOR` / `SHU251_ENV_CONTENT` |
| 2 | `RECON_DOC_POSITIVE`: closed decision, separate files, actual error contract | Reopen owner decision | `RECON_DOC_OWNER` |
| 2 | same | Omit unexpected-error class | `RECON_DOC_ERRORS` |
| 2 | same | Restore shared-file validation claim | `RECON_DOC_SEPARATE` |
| 1–2 boundary | `RECON_CONFIG_POSITIVE`: off gate, capacity two, unchanged pair | Flip config gate true | `RECON_CONFIG_GATE` |
| 3 | **Not implemented** | Fingerprint mismatch; foreign/self-appointed key | **Not verified** |
| 4 | **Not implemented** | Public load path unnamed/changed | **Not verified** |

## Validation

Normalized using `chmod -R go-w .github/coordinator` and `umask 0002`.

| Command | Total | Pass | Fail | Skip |
| --- | ---: | ---: | ---: | ---: |
| `TMPDIR=/tmp node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | 1161 | 1154 | 0 | 7 |
| `TMPDIR=/tmp SHU_TEST_CLOCK_OFFSET_MS=31536000000 NODE_OPTIONS="--import=$PWD/.github/coordinator/test/fixture/shift-wall-clock.mjs" npm run test:coordinator` | 1161 | 1154 | 0 | 7 |

Exact skip list, identical in both suites; none is counted as a pass:

1. `SHU-227: worker owns its checkout and recovery preserves descendant commits` — requires root or passwordless sudo for distinct-uid proof.
2. `SHU-227: non-owner service account resolves revision with no global Git trust` — requires distinct-uid execution.
3. `SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches` — requires distinct-uid execution.
4. `SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches` — requires distinct-uid execution.
5. `SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity` — host cannot switch to the fixture worker uid.
6. `SHU-244 A10: distinct-root scoped handoff production workspace` — host cannot switch worker uid.
7. `SHU-71 restricted capability refusal` — production vocabulary has no undeclared runtime/role pair.

Source test-name multiset (quoted/template first arguments, templates unexpanded):
main **840**, checkpoint **851**, added **11**, lost **0**. All 69 pre-existing
test files retain their exact ordered registration-label lists. There are 70
current test files. The new file expands its 11 source registrations into 17
runtime tests. This is a source-name comparison, not a claim that main was rerun.

`systemd-analyze verify` is available at `/usr/bin/systemd-analyze`, and exited
**0** with empty stderr on rendered temporary units through `verify.mjs` and the
service tests. Standalone verification additionally reported two disabled ticks,
zero launches, zero writes and exact rollback. It is local syntax/fixture evidence.
`git diff --check`: exit **0**. Shell files touched: **0** (`bash -n` not applicable).
Conflict markers in changed files: **0**.

The config blob in both main and this checkpoint is
`8a0317173d76f4c09811b9365e25b380b38dc93d`; bytes, gate, capacity and scope are unchanged.
Workflow files, product code, migrations and manifests touched: **0**.
Private-key material added: **0**. Signing-key operations added: **0**.
No real signing key was accessed or generated, and no signing artifact was added.
New credential fixtures generate random values at test runtime under `/tmp` and
are removed by fixture cleanup; no values are embedded in added lines or units.
An overly broad process listing exposed an unrelated credential in tool output;
it was not copied into repository files or this report. Consequently, this report
does not claim that all tool output was credential-free.

## Item 2: every wording change, before and after

The following exact diff includes the host-binding contract correction and all
related validation/README reconciliations. `-` is before; `+` is after.

```diff
diff --git a/.github/coordinator/service/README.md b/.github/coordinator/service/README.md
index bf3ea22..e0b4813 100644
--- a/.github/coordinator/service/README.md
+++ b/.github/coordinator/service/README.md
@@ -22,21 +22,24 @@ Before the coordinator-controlled host re-run, the operator must provide:
   parent must be a real, non-symlink directory owned by the running UID with no
   group/other permission bits; preserve the existing assertion. Supervisor state
   must also be accessible to that user. Ownership changes are a host operation.
-- A separately provisioned **0600 regular environment file**, owned by root or
-  the coordinator, in a private directory owned by root or the coordinator.
-  Both units require `EnvironmentFile=/etc/shu/supervisor.env`; customize the
-  absolute path with `secretEnvironmentFile`. There is no optional `-` prefix:
-  systemd refuses startup when the file is missing. Do not put secret values in
-  parameters.json, units, drop-ins, argv, version control, or staging backups.
-  The installer stages only the reference and does not create or read secrets.
-- One shared, random `SHU_SUPERVISOR_SECRET` value of at least 32 bytes in that
-  file. Systemd loads it into both processes. Do not include dispatch gates or
-  other settings in this secret-only file. Retain the reviewed activation and
-  adapter configuration separately; provisioning a secret does not enable work.
+- Supervisor `EnvironmentFile=/etc/shu/supervisor.env`, parameter
+  `supervisorEnvironmentFile`: root:root **0600**, containing only
+  `SHU_SUPERVISOR_SECRET` of at least 32 bytes.
+- Coordinator `EnvironmentFile=/srv/shu/service.env`, parameter
+  `coordinatorEnvironmentFile`: as provisioned, containing nonempty
+  `GITHUB_TOKEN` and `LINEAR_API_TOKEN`. These are distinct required absolute
+  paths. Missing files, identical paths/inodes, crossed paths or contents,
+  symlinks, duplicate assignments and incomplete credentials fail closed.
+  Each file uses single-line `NAME=value` assignments (optional matching quotes,
+  no escapes), blank lines and comments. Values are inspected in memory and
+  never included in diagnostics or units. Offline staging requires temporary
+  fixture files; it does not read host credentials. Systemd also refuses startup
+  if either required file disappears. Do not put credential values in parameters,
+  units, drop-ins, argv, version control or staging backups.

 For the **later authorized host window only**, the following root-run example
 creates a new private file without printing its secret or overwriting an existing
-one (adapt the location to `secretEnvironmentFile`). These commands are not part
+one (adapt the location to `supervisorEnvironmentFile`). These commands are not part
 of local staging or verification:

 ```sh
@@ -44,7 +47,7 @@ sudo python3 - <<'PY_SECRET'
 import os, secrets
 os.umask(0o077)
 os.makedirs('/etc/shu', mode=0o700, exist_ok=True)
-# For an existing directory, verify root/coordinator ownership and 0700 first.
+# For an existing directory, verify root:root ownership and 0700 first.
 with open('/etc/shu/supervisor.env', 'x', encoding='ascii') as output:
     output.write('SHU_SUPERVISOR_SECRET=' + secrets.token_hex(32) + '\n')
 PY_SECRET
@@ -62,7 +65,9 @@ listening or readiness with `AssertionError`:
 `SHU251_SUPERVISOR_SECRET: SHU_SUPERVISOR_SECRET must contain at least 32 bytes`.
 The underlying supervisor validation remains intact. Rotate only under a
 coordinator-controlled quiescent window and restart both processes with the same
-file value. Never use the test fixture secret on a host.
+transport value through the separately reviewed transport provisioning. The
+coordinator credential file does not inherit the supervisor file. Never use
+test fixture credentials on a host.

 ## Local verification and required CI

@@ -94,7 +99,7 @@ clone: Node runs `service/supervisor-service.mjs` and `reconcile.mjs` directly.
 Inputs are `workdir`, optional `workspaceStateDir` (defaults to the exported
 `WORKSPACE_STATE_DIR`), and optional `supervisorStateDir`,
 `supervisorSocket`, absolute Node executable `node`, `serviceUser`, `serviceGroup`,
-and `secretEnvironmentFile` (defaults and requirements above). Defaults place supervisor
+and `supervisorEnvironmentFile` / `coordinatorEnvironmentFile` (defaults and requirements above). Defaults place supervisor
 state in `workspaceStateDir/supervisor` and its socket in
 `workspaceStateDir/supervisor.sock`. Serialize the returned object to parameters.json:

diff --git a/.github/coordinator/service/SHU-251-HOST-BINDINGS.md b/.github/coordinator/service/SHU-251-HOST-BINDINGS.md
index 4f050da..87d8bbb 100644
--- a/.github/coordinator/service/SHU-251-HOST-BINDINGS.md
+++ b/.github/coordinator/service/SHU-251-HOST-BINDINGS.md
@@ -9,8 +9,11 @@ change host permissions, start a worker, arm dispatch, or authorize SHU-71.
 absolute JSON-spec path. The Node implementation uses fixed executable paths and
 fixed argv. There is no `eval`, `sh -c`, command field, executable field, or
 operator-provided argument array. Unknown fields fail the closed manifest before
-an operation runs. Every failure is JSON with `ok:false`, a binding name and one
-of the following typed codes.
+an operation runs. Failures emit machine-readable JSON with `ok:false` on stderr
+and set `process.exitCode = 2`. A `HostBindingHalt` includes a binding name and
+one of the nine typed codes below. All other failures use `SHU251_UNEXPECTED`
+with a `reason` and no binding name, including a repeated `capture-prior`
+(`atomicExclusive` EEXIST) or an fs error for a missing `unit_directory`.

 | Missing binding from the report | Reviewed action/control | Typed failure |
 | --- | --- | --- |
@@ -72,11 +75,13 @@ out-of-scope cleanup path and rollback record bound to another revision. Each
 dies with its binding-specific `HostBindingHalt`; a free-form command field is
 also rejected by the closed spec.

-## One credential-owner decision remains
+## Decided credential environment files

-The tooling does not invent, copy or rotate `SHU_SUPERVISOR_SECRET`. Before a
-window is approved, the credential owner must name and provision **one** approved
-credential-only environment file whose parent and file satisfy the service
-privacy contract, and bind that absolute path in the final window spec. The
-tooling verifies ownership/mode/key name and uses the value only in memory; it
-never prints it. No other free-form operational input remains in this package.
+The owner has decided the pair: supervisor `/etc/shu/supervisor.env`, root:root
+0600, containing only `SHU_SUPERVISOR_SECRET`; coordinator `/srv/shu/service.env`,
+as provisioned, containing its GitHub / Linear credentials (`GITHUB_TOKEN` and
+`LINEAR_API_TOKEN`). The status binding uses the supervisor file. Neither file
+may substitute for the other. The tooling does not invent, copy or rotate
+credentials, and never prints their values. The renderer and policy validator
+require both files to exist and check their distinct roles before accepting units.
+The final window spec binds the decided supervisor path for status authentication.
diff --git a/.github/coordinator/service/SHU-251-VALIDATION.md b/.github/coordinator/service/SHU-251-VALIDATION.md
index c9f03ea..48cd07b 100644
--- a/.github/coordinator/service/SHU-251-VALIDATION.md
+++ b/.github/coordinator/service/SHU-251-VALIDATION.md
@@ -23,22 +23,24 @@ Both service templates now render `User=` and `Group=` from `serviceUser` and
 The existing socket-parent assertion is unchanged. Policy checks require exactly
 one matching identity directive on each service and reject root configuration.

-Both templates now require the same external `EnvironmentFile=`, parameterized by
-`secretEnvironmentFile`, default `/etc/shu/supervisor.env`. The temporary installer
-renders and validates the reference without reading or generating a host secret.
-README supplies explicit account, state ownership and private 0600 root/coordinator
-file requirements plus a non-overwriting random-secret provisioning example for
-the later host window. No secret value is embedded in a unit.
-
-Exact sourcing: systemd loads `SHU_SUPERVISOR_SECRET` from that environment file
-into both processes. The supervisor entry point passes
+The templates require separate external `EnvironmentFile=` bindings:
+`supervisorEnvironmentFile` defaults to `/etc/shu/supervisor.env` (root:root 0600,
+only `SHU_SUPERVISOR_SECRET`); `coordinatorEnvironmentFile` defaults to
+`/srv/shu/service.env` (as provisioned, GitHub / Linear credentials). Rendering
+and policy validation inspect existing files without emitting values: missing,
+identical, crossed or incomplete bindings fail by named assertions. Neither
+reference is optional, and no secret value is embedded in a unit.
+
+Systemd loads each file only into its corresponding process. The supervisor entry point passes
 `process.env.SHU_SUPERVISOR_SECRET` to `startSupervisor`, then `DurableSupervisor`.
 The new service assertion requires a string/Buffer containing at least 32 bytes
 before durable state, recovery, socket creation or readiness. Existing
 `supervisor.mjs` validation still converts strings with `Buffer.from(secret ?? "")`
 and checks 32 bytes; HMAC-SHA256 uses those bytes without trimming/hex decoding.
 The coordinator signer reads `env.SHU_SUPERVISOR_SECRET` in
-`supervisor-dispatch.mjs`. A missing environment file is a systemd startup failure;
+`supervisor-dispatch.mjs`; the separate coordinator credential file does not
+supply that transport secret. Its delivery remains outside this renderer and
+requires the separately reviewed transport provisioning. A missing environment file is a systemd startup failure;
 a missing/short variable gets the named service AssertionError below.

 Both full measurements ran from the repo root under `umask 0002` after
```

## Removed assertion-line adjudication

There are **21** removed diff lines matching `assert|expect|throw`, each replaced
by a stronger check; there are **0** removals without a replacement. The old/new
hunks are quoted below. There are **0** test names lost.

- Policy calls now receive explicit fixture bindings. The same policy assertions
  remain, and the call additionally verifies both real fixture files, roles and
  distinct identities. Negative tests must still die by their original named
  assertion, so a missing-file failure cannot masquerade as the intended kill.
- The explicit workspace-override refusal passes the canonical state and false
  override explicitly while retaining both credential bindings. It still detects
  the same foreign workspace and now validates both environment files first.
- Exact directory inventories include the newly required `.environment` fixture
  directory, with `assertFixtureEnvironmentUnchanged(root)` added beside each.
  This additionally compares its credential bytes by SHA-256, modes and timestamps
  to their creation baseline; it does not ignore an arbitrary new directory.
- The former regex checking one expected environment directive becomes an exact
  list assertion, rejecting duplicate directives and checking the unit's own path.
- Production path validation applies the unchanged regex/dot-segment predicate
  to **both** paths, then adds distinctness, crossing and file-content assertions.
- Production policy's exact one-directive assertion is retained for each unit's
  separate binding, after the stronger file-content checks.

```diff
diff --git a/.github/coordinator/service/test/service.test.mjs b/.github/coordinator/service/test/service.test.mjs
index a28dc7c..7c867ec 100644
--- a/.github/coordinator/service/test/service.test.mjs
+++ b/.github/coordinator/service/test/service.test.mjs
@@ -36 +37 @@ test('SHU251 parameterised argv and unit syntax', noSystemd, t => {
-  assertPolicy(units);
+  assertPolicy(units, params);
@@ -80 +81,2 @@ test('SHU251 invalid executable fails syntax before staging changes', noSystemd,
-  assert.deepEqual(fs.readdirSync(root), []);
+  assert.deepEqual(fs.readdirSync(root), ['.environment']);
+  assertFixtureEnvironmentUnchanged(root);
@@ -109 +111 @@ for (const [label, name, before, after, message] of policyMutations) test(`SHU25
-  named(() => assertPolicy(units), message);
+  named(() => assertPolicy(units, params), message);
@@ -149 +151,2 @@ test('SHU251 partial staging failure restores prior state', noSystemd, t => {
-  assert.deepEqual(fs.readdirSync(root), [names[0]]);
+  assert.deepEqual(fs.readdirSync(root), ['.environment', names[0]]);
+  assertFixtureEnvironmentUnchanged(root);
@@ -154 +157 @@ test('SHU251 canonical writer lock accepted and foreign parameter refused', t =>
-  assertPolicy(render(params));
+  assertPolicy(render(params), params);
@@ -160 +163 @@ test('SHU251 mutation: rendered foreign writer lock', t => {
-  named(() => assertPolicy(units), 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
+  named(() => assertPolicy(units, params), 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
@@ -169 +172 @@ test('SHU251 mutation: unresolved timer placeholder', t => {
-  named(() => assertPolicy(units), 'SHU251_PARAMETER: unresolved template');
+  named(() => assertPolicy(units, params), 'SHU251_PARAMETER: unresolved template');
@@ -182 +185 @@ for (const [label, from, to, unit, message] of [
-  named(() => assertPolicy(units), message);
+  named(() => assertPolicy(units, params), message);
@@ -220 +223,2 @@ test('SHU251 foreign workspace state directory refused before staging', t => {
-    assert.deepEqual(fs.readdirSync(root), []);
+    assert.deepEqual(fs.readdirSync(root), ['.environment']);
+    assertFixtureEnvironmentUnchanged(root);
@@ -231 +235 @@ test('SHU251 explicit workspace override stages a visible two-writer hazard', no
-  named(() => assertPolicy(units), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
+  named(() => assertPolicy(units, { ...params, workspaceStateDir: WORKSPACE_STATE_DIR, allowWorkspaceStateDirOverride: false }), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
@@ -236 +240 @@ test('SHU251 mutation: matching foreign environment and writer lock', t => {
-  named(() => assertPolicy(units), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
+  named(() => assertPolicy(units, params), 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
@@ -271 +275,2 @@ test('SHU251 non-string workspace state directory has named fail-closed refusal'
-      assert.deepEqual(fs.readdirSync(root), []);
+      assert.deepEqual(fs.readdirSync(root), ['.environment']);
+      assertFixtureEnvironmentUnchanged(root);
@@ -288 +293 @@ test('SHU251 configured identity and external secret file survive staging', noSy
-    assert.match(units[name], /^EnvironmentFile=\/etc\/fixture\/supervisor.env$/m);
+    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${params[name === names[0] ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`], 'SHU251_SECRET_FILE: exact per-unit environment binding required');
@@ -298 +303 @@ for (const name of names.filter(name => name.endsWith('.service'))) {
-      named(() => assertPolicy(units), `SHU251_IDENTITY: ${name} must run with configured ${directive}`);
+      named(() => assertPolicy(units, params), `SHU251_IDENTITY: ${name} must run with configured ${directive}`);
@@ -303,3 +308,3 @@ for (const name of names.filter(name => name.endsWith('.service'))) {
-      const units = render(fixtureParameters(fixture(t)));
-      units[name] = units[name].replace('EnvironmentFile=/etc/shu/supervisor.env', replacement);
-      named(() => assertPolicy(units), 'SHU251_SECRET_FILE: services must require the shared secret environment file');
+      const params = fixtureParameters(fixture(t)), units = render(params);
+      units[name] = units[name].replace(`EnvironmentFile=${params[name === names[0] ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`, replacement);
+      named(() => assertPolicy(units, params), 'SHU251_SECRET_FILE: each service must require its own environment file');
@@ -313 +318 @@ test('SHU251 mutation: embedded secret in any unit refused', t => {
-    named(() => assertPolicy(units), 'SHU251_SECRET_LITERAL: units must not embed supervisor secrets');
+    named(() => assertPolicy(units, params), 'SHU251_SECRET_LITERAL: units must not embed supervisor secrets');
@@ -324 +329,2 @@ test('SHU251 unsafe identity and secret file parameters fail before staging', t
-  assert.deepEqual(fs.readdirSync(root), []);
+  assert.deepEqual(fs.readdirSync(root), ['.environment']);
+  assertFixtureEnvironmentUnchanged(root);
diff --git a/.github/coordinator/service/test/supervisor-service.test.mjs b/.github/coordinator/service/test/supervisor-service.test.mjs
index 903417a..4e0d228 100644
--- a/.github/coordinator/service/test/supervisor-service.test.mjs
+++ b/.github/coordinator/service/test/supervisor-service.test.mjs
@@ -128,2 +129,3 @@ test('SHU251 concrete merged service argv renders valid units', { skip: process.
-  const units = render(serviceParameters({ workdir, supervisorStateDir: params.stateDir, supervisorSocket: params.socketPath }));
-  assertPolicy(units);
+  const options = serviceParameters({ ...fixtureEnvironmentFiles(join(params.stateDir, '..')), workdir, supervisorStateDir: params.stateDir, supervisorSocket: params.socketPath });
+  const units = render(options);
+  assertPolicy(units, options);
diff --git a/.github/coordinator/service/units.mjs b/.github/coordinator/service/units.mjs
index daac039..137b9c1 100644
--- a/.github/coordinator/service/units.mjs
+++ b/.github/coordinator/service/units.mjs
@@ -23,4 +23,46 @@ function serviceConfiguration({ serviceUser = 'shu-coordinator', serviceGroup =
-  assert.ok(typeof secretEnvironmentFile === 'string' && /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(secretEnvironmentFile)
-    && !secretEnvironmentFile.split('/').some(p => p === '.' || p === '..'),
-    'SHU251_SECRET_FILE: plain absolute environment file path required');
-  return { serviceUser, serviceGroup, secretEnvironmentFile };
+  for (const environmentFile of [supervisorEnvironmentFile, coordinatorEnvironmentFile]) {
+    assert.ok(typeof environmentFile === 'string' && /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(environmentFile)
+      && !environmentFile.split('/').some(p => p === '.' || p === '..'),
+      'SHU251_SECRET_FILE: plain absolute environment file path required');
+  }
+  assert.notEqual(supervisorEnvironmentFile, coordinatorEnvironmentFile, 'SHU251_ENV_IDENTICAL: environment files must be distinct');
+  assert.ok(supervisorEnvironmentFile !== '/srv/shu/service.env' && coordinatorEnvironmentFile !== '/etc/shu/supervisor.env',
+    'SHU251_ENV_CROSSED: environment file paths belong to the other unit');
+  return { serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile };
+}
+
+// Inspect key names and nonempty values only; never include contents in errors.
+// Restrict the accepted format to unambiguous single-line systemd assignments.
+function environmentBindings(identity) {
+  const files = [identity.supervisorEnvironmentFile, identity.coordinatorEnvironmentFile];
+  const stats = files.map(file => {
+    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
+    assert.ok(stat, 'SHU251_ENV_MISSING: required environment file is absent');
+    assert.ok(stat.isFile(), 'SHU251_ENV_FILE: environment binding must be a regular non-symlink file');
+    return stat;
+  });
+  assert.ok(stats[0].dev !== stats[1].dev || stats[0].ino !== stats[1].ino,
+    'SHU251_ENV_IDENTICAL: environment files must not share an inode');
+  const entries = files.map(file => {
+    let source;
+    try { source = fs.readFileSync(file, 'utf8'); }
+    catch { assert.fail('SHU251_ENV_UNREADABLE: required environment file cannot be read'); }
+    const result = new Map();
+    for (const line of source.split(/\r?\n/)) {
+      if (/^\s*(?:[#;].*)?$/.test(line)) continue;
+      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
+      assert.ok(match && !result.has(match[1]), 'SHU251_ENV_CONTENT: unique single-line assignments required');
+      const raw = match[2];
+      const value = /^(?:"[^"\\]*"|'[^'\\]*')$/.test(raw) ? raw.slice(1, -1) : raw;
+      assert.ok(value.trim().length > 0 && !/["'\\]/.test(value), 'SHU251_ENV_CONTENT: nonempty unambiguous values required');
+      result.set(match[1], value);
+    }
+    return result;
+  });
+  const [supervisor, coordinator] = entries;
+  assert.ok(!supervisor.has('GITHUB_TOKEN') && !supervisor.has('LINEAR_API_TOKEN') && !coordinator.has('SHU_SUPERVISOR_SECRET'),
+    'SHU251_ENV_CROSSED: environment contents belong to the other unit');
+  assert.ok(supervisor.size === 1 && Buffer.byteLength(supervisor.get('SHU_SUPERVISOR_SECRET') ?? '') >= 32,
+    'SHU251_ENV_SUPERVISOR: only SHU_SUPERVISOR_SECRET of at least 32 bytes is required');
+  assert.ok(coordinator.has('GITHUB_TOKEN') && coordinator.has('LINEAR_API_TOKEN'),
+    'SHU251_ENV_COORDINATOR: GITHUB_TOKEN and LINEAR_API_TOKEN are required');
@@ -83,2 +127,2 @@ export function assertPolicy(units, options = {}) {
-    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${identity.secretEnvironmentFile}`],
-      'SHU251_SECRET_FILE: services must require the shared secret environment file');
+    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${identity[name === 'shu-supervisor.service' ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`],
+      'SHU251_SECRET_FILE: each service must require its own environment file');
diff --git a/.github/coordinator/service/verify.mjs b/.github/coordinator/service/verify.mjs
index 3f7a352..9bec0be 100644
--- a/.github/coordinator/service/verify.mjs
+++ b/.github/coordinator/service/verify.mjs
@@ -74 +90,2 @@ export async function verify() {
-    assert.deepEqual(fs.readdirSync(root), ['shu-supervisor.service'], 'SHU251_CLEANUP: rollback must remove transaction artifacts');
+    assert.deepEqual(fs.readdirSync(root), ['.environment', 'shu-supervisor.service'], 'SHU251_CLEANUP: rollback must remove transaction artifacts');
+    assertFixtureEnvironmentUnchanged(root);
```
