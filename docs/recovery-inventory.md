# Recovery inventory

Complete the owner and current-coverage fields before a production go/no-go. Link evidence without copying credentials, personal data, or secret values into this document.

| Recovery asset | What must be backed up | Owner | Current coverage |
| --- | --- | --- | --- |
| Platform database | The managed PostgreSQL database, including every public table, migration ledger, sequence, constraint, and append-only audit trigger | _Operator to complete_ | _Operator to complete: backup mechanism, schedule, retention, and last restore-check evidence_ |
| Private document storage | Private object data and the metadata required to associate and authorize every object | _Operator to complete_ | _Operator to complete: provider backup/versioning and tested recovery evidence_ |
| Configuration | Coolify application configuration, deployment manifests, environment-variable names and secret-manager references; never plaintext secret values | _Operator to complete_ | _Operator to complete: export or reproducible source and last validation_ |
| Identity dependencies | Authentik tenant/configuration, clients, claims, signing-key recovery procedure, and upstream identity-provider dependencies | _Operator to complete_ | _Operator to complete: provider recovery coverage and last exercise_ |

The platform database restore procedure is in [the restore runbook](runbooks/restore.md). Private document restoration, backup schedules, and retention policy remain separate operational work.
