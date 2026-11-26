# Production parity inventory: live front ends and clients

**Card:** SHU-138 (parent SHU-88). Feeds the cutover sequencing in P5 and the client-retirement rows in SHU-129.
**Sources:** the seven front-end repositories listed below, each at its default-branch HEAD as fetched 2026-09-09, plus `BAWES-Universe/studenthub@c2ce255` for the API hosts and `nginx/production.conf` and `nginx/railway-prod.conf` for what is actually routed.
**Method:** read-only inspection of repositories and their CI configuration. **No network access to any deployed site**, so nothing here is confirmed by fetching a live bundle. Section 6 states exactly what that leaves open.

## 1. What this card had to answer

"Identify the actual deployed front-end revision for every app; do not assume the newest repository is live."

The instruction is well aimed, because the naive answer is wrong in two ways at once. Repository "last pushed" timestamps point at feature branches, not at what ships: `studenthub-staff` was pushed on 2026-09-09 but its `master` is from 2026-06-29. And one repository that looks current has no deployment path at all.

The reliable route is the deployment mechanism. Every front end is a CircleCI job that syncs a build to an S3 bucket and invalidates a CloudFront distribution, filtered to one branch. So **the branch the deploy job filters on is the branch that reaches production**, and its HEAD is the expected live revision.

## 2. The five web front ends

| App | Repo | Deploy branch | HEAD at 2026-09-09 | Last commit | Production bucket | API host | Host routed by nginx? |
|---|---|---|---|---|---|---|---|
| Admin | `studenthub-admin` | `master` | `c789b17` | 2026-06-04 | `s3://studenthub-admin-prod` | `admin.api.studenthub.co` | yes |
| Candidate | `studenthub-candidate-react` | `main` | `2f0a121` | 2026-06-03 | `s3://studenthub-candidate-prod` | `student.api.studenthub.co` | yes |
| Employer | `studenthub-company` | `master` | `b9578d5` | 2026-06-04 | `s3://studenthub-company-prod` | `employer.api.studenthub.co` | yes |
| Staff | `studenthub-staff` | `master` | `49ed05c` | 2026-06-29 | `s3://studenthub-staff-prod` | `staff.api.studenthub.co` | yes |
| Store manager | `studenthub-manager` | `main` | `41c3293` | 2026-02-25 | `s3://studenthub-manager-prod` | `manager.api.studenthub.co` | **no** |

All five are Angular except the candidate app, which is React. All five deploy through CircleCI to S3 plus CloudFront, with a dev bucket on `develop` and a production bucket on the default branch.

## 3. The candidate client question, resolved

Three repositories target the candidate API. Only one reaches production.

| Repo | Default branch HEAD | Last commit | Deploy targets | Verdict |
|---|---|---|---|---|
| `studenthub-candidate-react` | `2f0a121` | 2026-06-03 | `studenthub-candidate-dev`, **`studenthub-candidate-prod`** | **the live web client** |
| `studenthub-candidate` (Cordova) | `de3ac8c` | 2026-07-06 | `studenthub-candidate-dev`, `studenthub-candidate-staging` — **no production bucket** | the mobile shell (`config.xml`, `capacitor.config.ts`, `android/`, `ios/`, a release keystore). Ships through app stores, not this pipeline |
| `studenthub-candidate-next` | `7c57b58` | **2025-01-10** | **none** | abandoned experiment; no CI deployment of any kind |

This closes the "unresolved which candidate client is live" row carried in SHU-123, SHU-129 and the coverage ledger. The React app serves the web; the Cordova project is the mobile build; the Next.js app is dead and should be archived rather than migrated.

## 4. The store-manager app

The manager front end targets `manager.api.studenthub.co`, and **no nginx configuration in the production repository routes that host**. The served list is `admin.api`, `student.api`, `employer.api`, `inspector.api`, `staff.api`, `v.` and `verification.` — manager is absent.

**Owner confirmation (Khalid, 2026-09-09):** the manager app was built so store managers could manage the staff assigned to their stores, and was never completed.

That resolves it without further investigation. The consequences for the platform:

- The store-manager **journey** is real and wanted. It is already carried as OR-06, OR-21 and slice O7 in the organizations inventory, and as a store-scoped grant in identity slice I4.
- The manager **application, API app and identity table** are not parity requirements. `manager/` in the monolith (10 controllers, 36 actions), the `store_manager` table as a separate credential store, and this repository are all retirement candidates.
- The `store_manager` rows still matter as data: they record who manages which store, which becomes a store-scoped grant at import.

## 5. Inspector, status and the routing anomaly

`inspector.api.studenthub.co` **is** routed by nginx, but the inspector app has only Auth, Account, Aws and Ping — no feature endpoints — and the last front-end repository for it (`studenthub-inspector`) was pushed in 2021. The reporting inventory established why: the inspector identity is the login for the `status` reporting app, whose own host is not routed either.

So two hosts referenced by real code are unrouted (`manager.api`, `status.api`), and one routed host serves an app with no features (`inspector.api`). Whether the live nginx matches the repository is the same open question as SHU-141, and it is the single check that would settle all three at once.

## 6. What is not established, and why

- **No deployed revision is confirmed by observation.** Every revision in section 2 is the branch CI deploys from, at the HEAD I fetched. Confirming it needs either CircleCI run history for the last successful deploy job, or fetching the live bundle and comparing a build hash. This session has no network access to either.
- **A failed or skipped CI run would break the inference.** If the last deploy job on `master` failed, production is running an older commit than the HEAD listed.
- **Manual deployments would break it too.** An `aws s3 sync` from a laptop leaves no trace in the repository.
- **Mobile app-store versions are unknown.** The Cordova project's shipped iOS and Android versions are not derivable from the repository.
- Whether the live nginx matches `nginx/production.conf` (SHU-141).

**To close section 6, someone with access needs three things:** the last successful CircleCI deploy job and its commit for each of the five apps; the current app-store versions of the mobile client; and one request to settle SHU-141. That is under an hour of work for someone with the credentials, and it is not work this session can do.

## 7. Cutover consequences

Every front end authenticates against a legacy credential store. At the Universe cutover each either updates or stops working. Sequencing, using the resolution above:

| Client | Cutover treatment |
|---|---|
| Candidate web (`studenthub-candidate-react`) | **Update first.** It is the only client with a Universe login branch already started (`feat/shu-29-continue-with-universe` exists on the remote), and candidates are the largest population |
| Candidate mobile (Cordova) | Update and ship through both app stores. **App-store review time is the long pole in the whole cutover** and nothing else in the programme has that dependency |
| Staff, admin, employer web | Update in step with the platform's staff and employer surfaces |
| Store manager web | **Do not update.** Retire with the manager app per section 4 |
| `studenthub-candidate-next` | Archive |
| `studenthub-mcp` | Re-point at the platform API; recorded as live in SHU-34 but not re-verified here |
| Staff-registered webhooks | Consumers unknown; SHU-129 CM-F4 |

## 8. Findings

| ID | Finding | Evidence | Severity | Action |
|---|---|---|---|---|
| **FE-F1** | Repository "last pushed" reflects feature branches, not production. `studenthub-staff` was pushed 2026-09-09; its deploy branch `master` is from 2026-06-29 | §1, §2 | Method (it is the error this card was written to avoid) | use the deploy filter, not the timestamp |
| **FE-F2** | The manager front end targets an API host no nginx config routes; owner confirms the product was never completed | §4 | Resolved by owner | retire the app, keep the journey |
| **FE-F3** | Three repositories target the candidate API; only `studenthub-candidate-react` deploys to a production bucket | §3 | Resolves an ambiguity carried by three earlier inventories | archive `-next` |
| **FE-F4** | The mobile client introduces app-store review into the cutover critical path, and no other work in the programme has that dependency | §7 | **Planning, high** | P5 sequencing must start the mobile update earliest |
| **FE-F5** | All five production front ends deploy from a default branch whose HEAD is three months old or more, except staff | §2 | Observation, not a defect | useful signal: the legacy front ends are in maintenance, which lowers the cost of retiring them |
| **FE-F6** | No deployed revision is confirmed by observation | §6 | Honest limit of this card | needs CI history or network access |

## 9. Bounded slices

This card produces no implementation slices of its own. Its output is sequencing input to P5 and three concrete follow-ups:

1. Confirm the five deployed revisions from CircleCI history (30 minutes with access).
2. Record the mobile client's live app-store versions.
3. Archive `studenthub-candidate-next` and mark `studenthub-manager` for retirement.

## 10. Decision for Khalid

| ID | Decision | Recommended default | Cost of waiting |
|---|---|---|---|
| D-FE1 | The mobile candidate client is on the cutover critical path because of app-store review. Does the platform ship a mobile client at cutover, or does mobile follow later on the legacy API? | **Ship web first and let mobile follow.** Keeping the legacy candidate API alive for the mobile client for one extra cycle is cheaper and safer than gating the whole cutover on two app-store reviews | This is the one sequencing decision that can add weeks to P5 if taken late, because app-store review time cannot be compressed |
