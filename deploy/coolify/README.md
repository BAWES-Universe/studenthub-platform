# Coolify staging package (SHU-80)

This Compose application packages the StudentHub gateway with a dedicated PostgreSQL 17 service. The gateway refuses to start with a partial login configuration, applies every checked-in migration before serving traffic, binds explicitly to the container network, and is healthy only while both PostgreSQL and the gateway respond.

## Deploy

1. In Coolify, create a Docker Compose resource from this repository and select `deploy/coolify/compose.yaml`.
2. Pin the resource to the exact reviewed Git commit. Set `SOURCE_REVISION` to the same full 40-character SHA. It is consumed only as a build argument and baked into the image as the root-owned, read-only `/image-source-revision`; the container receives no revision variable at runtime, so a stale value in the deployer's environment can neither start the gateway nor change what `/health` reports.
3. Add every variable named in `.env.example` through Coolify. Keep database passwords and the OIDC client secret out of Git, Linear, PR comments, and chat. `PLATFORM_DATABASE_URL` must use `platform-postgres` as its hostname and match the PostgreSQL database, user, and password variables.
4. Configure the public gateway hostname in Coolify to route HTTPS traffic to the `gateway` service on port 3000. Do not create or change DNS until the approved SHU-30 hostname decision is recorded.
5. Deploy. The database health gate runs first; the gateway preflight and migrations must succeed before the process starts. Coolify should report the gateway healthy only after the application health response and `SELECT 1` both succeed.

The nine login variables are the application's existing all-or-nothing runtime contract. Use the Authentik endpoints and client created by the SHU-50 blueprint work; do not copy secrets into this file.

The build workflow verifies that every key in `deployment-env-manifest.json` exists as a runtime variable on the target Coolify application before building or pushing an image. Configure `COOLIFY_READ_TOKEN` as a non-sensitive, read-only team token; Coolify does not support application-scoped tokens, so this is the narrowest available scope. The check reads key metadata only and works when values are redacted. Keep the existing deploy-capable `COOLIFY_TOKEN` separate. Pull requests execute only the trusted base checker and treat the proposed JSON manifest as data, so PR-controlled code never receives either Coolify token. Value semantics and non-empty requirements remain enforced by the fail-closed runtime preflight during deployment.

## Failure and rollback

- A missing variable, invalid source revision, loopback-only bind, unreachable database, or failed migration stops the gateway before it can serve traffic.
- PostgreSQL data persists in the named `platform-postgres-data` volume across container replacement.
- Roll back the gateway by redeploying the previously verified commit and rebuilding with `SOURCE_REVISION` set to that SHA. Because the revision is baked at build time, a rollback must rebuild or redeploy that commit's image — editing the variable alone changes nothing. Migrations are forward-only; do not delete or roll back the database volume. If a new migration is not backward compatible, restore from a separately verified database backup instead of reusing this application rollback procedure.
- This package does not change Authentik, DNS, production, Railway, or any legacy database. Those are explicit live-operator actions on SHU-79/SHU-30.

## Repository verification

Run `npm test`. The deployment tests prove that incomplete configuration, a non-container bind, an unpinned revision, database failure, and gateway failure cannot be reported ready. Build the image with an exact revision using:

```sh
docker build --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" -t studenthub-gateway:"$(git rev-parse --short HEAD)" .
```
