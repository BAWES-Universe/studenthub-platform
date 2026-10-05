# Selected trigger diagnosis and local fix

Correction lane: `fix/trigger-selected-diagnosis`, PR #108. Historical run
source: `43c6d923f2f66b303f4851c2f01fa43a86566c75`. The correction reread
GitHub run metadata, job logs and the selected artifact through the GitHub API;
it did not inspect or change Coolify or the runtime.

## Evidence and corrected diagnosis

**Run 34834697047 failed the operator digest comparison. Run 34835669797
reached the trigger CLI's blanket catch, but its underlying exception was
suppressed and cannot be identified from the retained evidence.** The previous
claim that the mutable `latest` pin caused these failures is withdrawn. Changing
a live application pin is not an evidence-supported remedy for these runs.

Sources: [first deploy job](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34834697047/job/103945797741),
[second deploy job](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34835669797/job/103948835803),
and [second environment job](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34835669797/job/103948798685).
Read with `gh run view <run-id> --json headSha,jobs,conclusion` and
`gh api repos/BAWES-Universe/studenthub-platform/actions/jobs/<job-id>/logs`.
The following are exact log lines (timestamps are UTC; ANSI styling omitted):

```text
2026-09-14T10:45:06.8860538Z   EXPECTED_DIGEST: sha256:002bcadf3f2b69f1a61dbe17448b7c1cacc64cf7584cd918af6ce7b0ed298939
2026-09-14T10:45:07.6657086Z Error: published digest does not match operator selection
2026-09-14T10:45:07.6702585Z ##[error]Process completed with exit code 1.
2026-09-14T10:57:08.1569709Z   EXPECTED_DIGEST: sha256:80851c284177581f2d4c9bbed5f24cab5665c54a3efec5f39463081203b1ae72
2026-09-14T10:57:10.8399877Z Artifact selected-artifact-34835669797-1 has been successfully uploaded! Final size is 390 bytes. Artifact ID is 10344325676
2026-09-14T10:57:10.8521261Z ##[group]Run node deploy/coolify/trigger-selected.mjs selected-artifact.json
2026-09-14T10:57:10.8560372Z   COOLIFY_BASE: ***
2026-09-14T10:57:10.8560824Z   COOLIFY_TOKEN: ***
2026-09-14T10:57:10.8561155Z   COOLIFY_STUDENTHUB_GATEWAY_UUID: ***
2026-09-14T10:57:10.8561450Z ##[endgroup]
2026-09-14T10:57:10.8921087Z selected deployment failed; inspect the recorded selection and Coolify deployment history
2026-09-14T10:57:10.8971317Z ##[error]Process completed with exit code 1.
```

Run metadata marks the first run's selection step failed and its upload and
trigger steps skipped. The second run's selection and upload steps succeeded;
its trigger failed and receipt upload was skipped. There is no download-artifact
step in this deploy job: the trigger reads the same workspace file.

The interval from the second trigger's environment endgroup to its catch message
is 35.9637 ms (44.0056 ms from the Run banner to the exit annotation). This
supports investigating local rejection, but timing is not an execution trace and
cannot prove that no GET was attempted or identify a particular exception.
The successful environment check is in a **different job**, uses
`COOLIFY_READ_TOKEN`, and cannot prove the trigger's request succeeded. Its Run
banner is at `2026-09-14T10:56:47.8484961Z` and its verified-11-keys message at
`2026-09-14T10:56:48.5571013Z` (708.6052 ms apart). Neither interval establishes
a universal minimum network latency.

The [archived selection](https://github.com/BAWES-Universe/studenthub-platform/actions/runs/34835669797/artifacts/10344325676)
was downloaded using `gh api repos/BAWES-Universe/studenthub-platform/actions/artifacts/10344325676/zip`.
`selected-artifact.json` parses as a JSON object with revision
`43c6d923f2f66b303f4851c2f01fa43a86566c75`, the expected digest above, the
expected gateway image, matching `pin` and `coolifyTag`, and run ID
`34835669797`. Its trailing byte is a newline, not a literal backslash-n.
No selection correction is justified.

| Candidate | Evidence and limit |
| --- | --- |
| Local file read/JSON parse | Uploaded file exists and its archived bytes parse correctly. No intervening workflow step modifies it. A later runner-local read failure is not observable in this catch. |
| Selection validation or shape TypeError | Archived selection has the expected object shape and valid string fields. At the historical head, application validation executes only after the awaited GET; there is no separate local selection validator before that GET. A malformed remote application response remains unobservable. |
| Artifact upload/download failure | Upload succeeded in the second run; no download step exists. First run never reached upload. Receipt upload is skipped as a consequence of trigger failure. |
| Missing input/environment | First run supplied a mismatching digest; second selection passed. All three trigger settings have masked nonempty log entries, so absence is not supported. Their masked contents cannot establish validity. |
| URL validation/request construction | Historical trigger lines 20–21 parse the base URL and require HTTPS without URL credentials before calling fetch. The environment checker permits HTTP and trims settings. Thus its success does not exclude this local rejection. URL protocol/content, header validity and request errors are hidden; none is proven as the cause. |
| Mutable pin, rejected POST, response error | Blanket catch discards all such exceptions. No request/response trace or exception identifies any of them. The reported pin state alone does not show execution reached its check. |

At the run head, `trigger-selected.mjs:41` evaluates
`JSON.parse(readFileSync(process.argv[2], 'utf8'))` before entering
`triggerSelected`. Lines 17–21 check required settings and the base URL;
lines 24–29 construct and perform the request. Line 31 awaits the application
GET before validating its pin. Line 43 is the exact source of the logged message:

```js
} catch { console.error('selected deployment failed; inspect the recorded selection and Coolify deployment history'); process.exitCode = 1; }
```

That catch retains neither an error type nor a stack. It proves the failure
handler executed, not which preceding operation threw.

What remains established: the generic failure path fired; the supplied operator
observation reports no new deployment and unchanged healthy staging (not rechecked
here). The first run did not invoke the trigger. A generic error cannot establish
an actual deployment failure. The typed outcomes and verification contract below
remain supported by the existing tests. The baseline accepted deployment UUIDs
without verifying completion or health; the existing code correction addresses
that independently of the historical exception.

What was corrected: the asserted second-run pin mechanism, the implication that
both runs failed for that reason, and the instruction implying changing the pin
would make a retry succeed. This correction changes documentation only. Production
code, workflow, recorded selection, assertions and tests remain intact; no new
test is added for an exception the evidence cannot identify. Determining that
exception would require evidence the old catch did not retain; no dispatch or
live configuration change is authorized or performed to obtain it.

Immutable pinning remains a separate requirement enforced by
`assertSelectedApplication` before POST, not an explanation of these failures.
See [DEPLOY-FLOW.md](DEPLOY-FLOW.md) for that prospective deployment contract.

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

## Original implementation verification (before this correction)

Commands are reported separately, not combined with coordinator counts:

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Exit 0; installed locked dependencies for local checks. |
| `node --test deploy/coolify/test/trigger-selected*.test.mjs deploy/coolify/test/artifact-selection.test.mjs` | Initial focused run: 20 passed, 0 failed, 0 skipped; final health field correction covered by root suite below. |
| `npm test` (repository root) | Exit 0. Node suites: 421 passed, 0 failed, 0 skipped; Vitest: 27 passed. Total test cases 448. Build and synthetic observability exercise passed. Separate mutation runners: 10/10, 3/3, 17/17, 10/10, 17/17, 22/22 killed. The deployment suite's 72/72 includes all five new mutation harness tests. |
| `umask 0002` then `chmod -R go-w .github/coordinator` then `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | Exit 0; 905 tests, 898 passed, 0 failed, 7 skipped. |
| `git diff --check` | Exit 0. |

The table above records the earlier implementation lane, not a rerun in this
correction. The correction's command results are recorded separately below.
No dispatch, deployment, Coolify API call or configuration mutation, host access
or `/srv` operation is part of this correction. Runtime success and installed
Coolify response shapes remain untested live. Coordinator skips are not passes.

## Correction verification

Commands run in this correction, reported separately:

| Command | Result |
| --- | --- |
| `npm test` (first attempt, repository root) | Exit 2 during build: TS2688, missing Node type definitions because dependencies were absent. No tests ran. |
| `npm ci --ignore-scripts` | Exit 0; installed locked dependencies. |
| `npm test` (after dependency installation, repository root) | Exit 0; 421 Node tests and 27 Vitest tests passed (448 total), 0 failed, 0 skipped. Build and synthetic observability exercise passed. Mutation runners: 10/10, 3/3, 17/17, 10/10, 17/17, 22/22 killed. |
| `umask 0002` then `chmod -R go-w .github/coordinator` then `node --test .github/coordinator/test/*.test.mjs .github/coordinator/service/test/*.test.mjs` | Exit 0; 905 tests, 898 passed, 0 failed, 7 skipped. |
| `git diff --check` | Exit 0. |

Only this diagnosis and `DEPLOY-FLOW.md` changed. All existing code, workflow,
assertions and tests remain unchanged. Push and remote-head equality are reported
with the resulting commit SHA in the correction handoff.
