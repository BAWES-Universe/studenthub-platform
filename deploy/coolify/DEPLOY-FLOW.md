# Staging deployment

Staging (https://staging.studenthub.co) has one deployment path:
`.github/workflows/staging-on-dev.yml`, described below. It follows main while no
pull request holds the `on-dev` label, and the labelled PR while one does.

`build.yml` still builds, smoke-tests and publishes `main-<sha>` images for
runtime-changing pushes to main, behind the environment-manifest gate. It no longer
deploys. Its automatic deploy job (`automatic-staging.mjs` with rollback discovery
and the `[staging-deploy] frozen` issue) was retired on 2026-10-04 with the owner's
approval. It hadn't deployed since 14 Sep, because its rollback discovery needed
SSH access to the staging host that the workflow never had. Two paths moving
`latest` independently also couldn't agree on who owns staging. `automatic-staging.mjs`
remains as the source of the staging target checks (`assertStagingTag`) and the
public feature smoke (`featureSmoke`) used by `staging-switch.mjs`. The history of
the retired path is in [RESTORE-VALIDATION.md](RESTORE-VALIDATION.md),
[RESTORE-JOB-COMPARISON.md](RESTORE-JOB-COMPARISON.md) and
[ROLLBACK-CONTRACT.md](ROLLBACK-CONTRACT.md).

Production has no workflow path or target here. Its separate explicit owner
approval requirement remains.

## Putting a branch on staging (`on-dev`)

`.github/workflows/staging-on-dev.yml` mirrors Universe's dev-server label. Adding
the `on-dev` label to a same-repository pull request puts its branch on staging.
Pushes to the labelled PR follow. Removing the label, merging or closing the PR
returns staging to main, and while no PR holds the label staging follows main.
The PR labelled most recently holds staging; other PRs lose the label, and fork
PRs are never built. A manual run brings staging back in line.

GitHub keeps only the newest queued run in a concurrency group, so any run can be
dropped. No step acts on the event that started its run. Each one reconciles live
state through `staging-ownership.mjs` (always run from main), so whichever run
survives restores the intended state:

1. `decide` (one at a time) settles the label and names the branch to build.
2. The build job builds that branch as `dev-<sha>` and runs `image-smoke.sh` on the
   exact digest. It runs branch code, so it gets no Coolify secrets.
3. The switch job checks out main and works out again which commit staging should
   run now. That may be newer than its own build. If that commit's `dev-<sha>` image
   exists, main's `image-smoke.sh` runs on it. The job then confirms the commit is
   still wanted, and `staging-switch.mjs` moves `latest` to that digest, triggers
   the staging app and waits until `/health` reports the revision and the feature
   smoke passes. If the image doesn't exist yet, the job changes nothing, because
   that commit's own run is still to come.

The switch job is the only job that moves `latest`, and switches run one at a time
in the `staging-switch` queue. There is no rollback
or freeze on this path: staging is a test site, and the next run puts back whatever
is wanted.
