# Selected trigger diagnosis and local fix

Baseline: local main `aac05b1055c719924f8f305d25238fdfed05d806`.
Branch: `fix/trigger-selected-diagnosis`. No remote refresh or runtime inspection.

## Root cause

Accepted operator evidence: workflow_dispatch runs 34834697047 and 34835669797
at head 43c6d923 both failed. The first intentionally wrong digest was correctly
rejected. The second used the true manifest digest but Coolify created no new
deployment (newest remained e8zxu4qf at 08:02). Staging stayed healthy, zero
restarts, revision 50db30ee. The app is pinned to mutable `latest`.

The pin precondition plus a blanket CLI catch explains this exact state. These
are **baseline** line numbers in `deploy/coolify/trigger-selected.mjs`, obtainable
with `git show main:deploy/coolify/trigger-selected.mjs | nl -ba`:

```text
10     || application.docker_registry_image_tag !== selection.digest.replace(':', '-')
12     throw new Error('staging application must already pin the selected digest');
31   assertSelectedApplication(await call(`/api/v1/applications/${uuid}`, 'GET'), selection);
32   const result = await call(`/api/v1/deploy?uuid=${uuid}`, 'POST');
33   if (!Array.isArray(result.deployments) || !result.deployments.length
34       || result.deployments.some((item) => !item.deployment_uuid)) throw new Error('Coolify returned no deployment UUID');
35   return { ...selection, applicationUuid: env.COOLIFY_STUDENTHUB_GATEWAY_UUID,
36     deploymentUuids: result.deployments.map((item) => item.deployment_uuid) };
43   } catch { console.error('selected deployment failed; inspect the recorded selection and Coolify deployment history'); process.exitCode = 1; }
```

With `latest`, line 10 fails, line 12 throws during line 31, and line 32 is never
executed. Line 43 discards the actual reason and falsely labels this a deployment
failure. The generic log alone cannot prove which exception occurred; the supplied
pin state and code establish the precondition path without querying Coolify.

After a successful POST the old script only checked `deployments[].deployment_uuid`
and returned a receipt. The CLI wrote that receipt and exited zero. It never
verified completion or health, so acceptance could also falsely look successful.
The documented [deploy API](https://coolify.io/docs/api/endpoints/deployments/deploy-by-tag-or-uuid)
returns deployment UUIDs; a UUID is not a completion status.

| Candidate explanation | Code evidence and conclusion |
| --- | --- |
| App not pinned | Lines 10, 12, 31: explains `latest` and zero POSTs. Precondition, not deployment failure. |
| Wrong deployment ID assumption | Lines 33–36 use `deployment_uuid`, consistent with the API; missing UUID still went through the misleading catch. |
| Wrong polling endpoint | No polling existed at all. Only application GET and deploy POST. |
| Timeout | Line 25 bounded each request to 15 seconds; any timeout also hit line 43. No deployment-completion deadline existed. Not needed to explain this incident. |
| Empty list | Lines 33–34 reject an empty trigger receipt, not an empty history/poll result. That cannot establish a real failure either. |

`select-artifact.mjs:10` sets ``const tag = `main-${revision}`;`` and line 15 emits
`coolifyTag: digest.replace(':', '-')`. Resolving a full-SHA publication tag does
not pin the app. `.github/workflows/build.yml:177` requires main ancestry; line
178 is exactly:

```js
if (selection.digest !== process.env.EXPECTED_DIGEST) throw new Error('published digest does not match operator selection');
```

Lines 183–188 upload selection before the trigger command at line 194. None of
these workflow gates, trigger conditions or commands changed.

## Fixed contract

See [DEPLOY-FLOW.md](DEPLOY-FLOW.md) for exact operator configuration and verification.
`DeploymentOutcome.code` and the CLI diagnostic distinguish:

| Outcome | Evidence |
| --- | --- |
| PRECONDITION_NOT_MET | Missing/invalid local configuration, wrong image mode/repository/domain or nonselected digest pin before POST. |
| TRIGGER_REJECTED | Explicit POST refusal: HTTP 400/401/403/404/405/422/429. |
| DEPLOYMENT_FAILED | Matching returned deployment UUID reaches failed/cancelled/cancelled-by-user. |
| DEPLOYMENT_UNKNOWN | No usable receipt, ambiguous request error, missing/mismatched lookup, unsupported status, changed pin, timeout or unverified health. |
| DEPLOYMENT_SUCCEEDED | Every returned UUID is finished, app pin remains selected, app is running:healthy and gateway health reports the selected revision. |

Lookup uses the [deployment UUID endpoint](https://coolify.io/docs/api/endpoints/deployments/get-deployment-by-uuid),
never a global list or an application UUID as a deployment UUID. Maximum verification
window is five minutes. No POST retries. Diagnostics omit response bodies and
arbitrary error messages. The unauthenticated health request carries no Coolify token.
Known UUID receipts remain local if verification fails; unchanged workflow gates
mean they are uploaded only on success. An external job cancellation can prevent
a final diagnostic; a later failure remains the failure monitor's responsibility.

## New test inventory

All API requests below use injected stubs, with a virtual clock for polling:

- `trigger precondition latest creates no deployment`
- `trigger explicit HTTP rejection is typed`
- `trigger no deployment receipt is unknown not failed`
- `trigger real terminal failure is detected`
- `trigger UUID receipt waits for finished and healthy selected revision`
- `trigger missing deployment and wrong UUID cannot prove failure`
- `trigger timeout and unhealthy or stale revision remain unknown`
- `trigger ambiguous response never retries POST or leaks secrets`
- `trigger invalid local configuration is a precondition`

Production source mutations run in isolated temporary copies. Each child must
exit 1 with AssertionError and its named assertion, not a syntax/import crash:

| New mutation test | Required child failure text |
| --- | --- |
| trigger mutation killed: precondition mislabeled | AssertionError: TRIGGER_PRECONDITION_TYPED |
| trigger mutation killed: rejection mislabeled | AssertionError: TRIGGER_REJECTION_TYPED |
| trigger mutation killed: empty receipt mislabeled | AssertionError: TRIGGER_NO_FALSE_FAILURE |
| trigger mutation killed: real failure hidden | AssertionError: TRIGGER_REAL_FAILURE_DETECTED |
| trigger mutation killed: health verification bypassed | AssertionError: TRIGGER_HEALTH_REQUIRED |

The existing `verified digest deployment records Coolify deployment ID` test was
updated to require status polling and healthy revision verification.

## Verification in this clone

Commands are reported separately, not combined with coordinator counts:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; installed locked dependencies for local checks. |
| `node --test deploy/coolify/test/trigger-selected*.test.mjs deploy/coolify/test/artifact-selection.test.mjs` | Initial focused run: 20 passed, 0 failed, 0 skipped; final health field correction covered by root suite below. |
| `npm test` (repository root) | Exit 0. Node suites: 421 passed, 0 failed, 0 skipped; Vitest: 27 passed. Total test cases 448. Build and synthetic observability exercise passed. Separate mutation runners: 10/10, 3/3, 17/17, 10/10, 17/17, 22/22 killed. The deployment suite's 72/72 includes all five new mutation harness tests. |
| `umask 0002` then `chmod -R go-w .github/coordinator` then `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | Exit 0; 905 tests, 898 passed, 0 failed, 7 skipped. |
| `git diff --check` | Exit 0. |

No push, PR, dispatch, deployment, Coolify API call or configuration mutation was
performed. No host or `/srv` operation was used. Runtime success and the installed
Coolify response shape were not tested live; the supplied operational evidence is
accepted and API behavior is exercised with stubs. Official public API documentation
was read to check endpoint contracts. All tracked changes are in `deploy/coolify`;
workflow and coordinator command gates are unchanged. The mutable-pin operator
item remains open. The coordinator skips remain skips, not claimed passes.
