# Staging label correction — NOT EXECUTED

Reported state: the Coolify project/environment is labelled `production`, while
the gateway target is `staging.studenthub.co`. No credentials were available or
used; the live hierarchy and exact project name have not been independently
verified. This is an operator remediation note, not evidence of a live change.

During a separately authorized maintenance window:

1. Identify the existing gateway by its application UUID (the value referenced by
   `COOLIFY_STUDENTHUB_GATEWAY_UUID`) and confirm its domain is exactly
   `https://staging.studenthub.co`. Record its project UUID, environment UUID,
   current labels, resource membership and current artifact digest in the ops
   change record without copying secret values.
2. In that project's environment settings, rename the environment **production →
   staging**. Preserve its UUID and all resource membership; do not delete or
   recreate it, move resources, change runtime `NODE_ENV`, or deploy.
3. If the containing project's display name is also literally **production** and
   the project contains only staging resources, rename that project **production
   → studenthub-staging**, preserving the project UUID. If it is shared with real
   production resources, stop the project rename and document the shared scope;
   the exact environment rename remains the correction for this staging target.
4. Save labels only. Verify the unchanged application UUID, environment/project
   UUIDs, `staging.studenthub.co` domain, image digest and resource membership.
   Review external automation that addresses environments by name and update its
   staging reference in a separate authorized change before relying on it.

Why: a production label on staging misdirects incident routing and operator
judgment, can produce incorrect approval assumptions, and makes deployment audit
records ambiguous. A label is not an isolation or authorization control; renaming
it does not establish production safety or alter deployment permissions.

Rollback: using the recorded UUIDs, restore the environment display name to
`production` and, only if changed above, the project display name to its recorded
original (`production`). Restore any separately changed name-based references in
that change's own rollback. Do not redeploy, move resources, change DNS, touch
storage or reset runtime environment variables for a label rollback.

Status: **NOT EXECUTED**. No Coolify API call, label mutation, production contact,
host write or deployment was performed in this implementation lane.
