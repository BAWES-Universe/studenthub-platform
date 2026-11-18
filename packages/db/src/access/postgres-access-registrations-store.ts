import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { insertAuthorizationMutationAudit, organizationAuditRef, principalAuditRef, requestAuditRef, resolveAuthorizationMutationContext } from "../authorization-audit.js";
import { grantSummary } from "./postgres-access-grants-store.js";

/**
 * Access lane A7 (migration 0408): "Register a company" submissions and the
 * staff review queue. Structural types only: the decision lives in
 * packages/access and is handed to `review`, which runs it on what it read
 * under the locks.
 */

type Grant = { readonly orgId: string; readonly role: string; readonly scope: string };
type Status = "pending" | "approved" | "rejected";

interface Submission {
  readonly companyName: string;
  readonly contactName: string;
  readonly contactPosition: string;
  readonly phoneNumber: string;
  readonly companyEmail: string;
  readonly requestingFor: string;
}

export interface RegistrationReviewSnapshotRow {
  readonly callerGrants: readonly Grant[];
  readonly registration: { readonly submitterPrincipalId: string; readonly status: Status; readonly companyName: string } | null;
  readonly nameTaken: boolean;
  readonly submitterPaused: boolean;
}

export type RegistrationReviewOutcome<R extends string = string> =
  | { readonly kind: "approved"; readonly orgId: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "refused"; readonly reason: R };

/** The organization-creation lock the existing creation store takes on the parent. */
const CREATION_LOCK_KEY = 163;
const ORG_LOCK_KEY = 5960;
const PRINCIPAL_LOCK_KEY = 5959;
const OWNER_ROLE = "org-owner";

const iso = (value: Date | string | null): string | null => (value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString());
const statusRef = (registrationId: string) => createHash("sha256").update("studenthub:company-registration:v1\0").update(registrationId).digest("hex");

type Row = {
  id: string; submitter_principal_id: string; display_name: string | null; email: string | null;
  company_name: string; contact_name: string; contact_position: string; phone_number: string; company_email: string; requesting_for: string;
  status: Status; submitted_at: Date; reviewed_at: Date | null; review_reason: string | null; org_id: string | null;
};
const COLUMNS = `r.id, r.submitter_principal_id, p.display_name, p.email, r.company_name, r.contact_name, r.contact_position,
  r.phone_number, r.company_email, r.requesting_for, r.status, r.submitted_at, r.reviewed_at, r.review_reason, r.org_id`;
const FROM = "company_registrations r JOIN principals p ON p.id = r.submitter_principal_id";
const registration = (row: Row) => Object.freeze({
  id: row.id,
  submitter: Object.freeze({ principalId: row.submitter_principal_id, displayName: row.display_name, email: row.email }),
  companyName: row.company_name, contactName: row.contact_name, contactPosition: row.contact_position,
  phoneNumber: row.phone_number, companyEmail: row.company_email, requestingFor: row.requesting_for,
  status: row.status, submittedAt: iso(row.submitted_at)!, reviewedAt: iso(row.reviewed_at), reviewReason: row.review_reason, orgId: row.org_id,
});

export class PostgresAccessRegistrationsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new pg.Pool({ connectionString: options.connectionString });
      this.#ownsPool = true;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async submit(principalId: string, request: Submission): Promise<{ kind: "submitted"; id: string } | { kind: "refused"; reason: "already_pending" | "unknown_person" }> {
    const id = randomUUID();
    try {
      const { rowCount } = await this.#pool.query(
        `INSERT INTO company_registrations (id, submitter_principal_id, company_name, contact_name, contact_position, phone_number, company_email, requesting_for)
         SELECT $1, p.id, $3, $4, $5, $6, $7, $8 FROM principals p WHERE p.id = $2`,
        [id, principalId, request.companyName, request.contactName, request.contactPosition, request.phoneNumber, request.companyEmail, request.requestingFor]);
      return rowCount ? { kind: "submitted", id } : { kind: "refused", reason: "unknown_person" };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return { kind: "refused", reason: "already_pending" };
      throw error;
    }
  }

  async mine(principalId: string) {
    const { rows } = await this.#pool.query<Row>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE r.submitter_principal_id = $1 ORDER BY r.submitted_at DESC, r.id LIMIT 20`, [principalId]);
    return rows.map(registration);
  }

  async queue() {
    const [pending, decided] = await Promise.all([
      this.#pool.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.status = 'pending' ORDER BY r.submitted_at, r.id LIMIT 100`),
      this.#pool.query<Row>(`SELECT ${COLUMNS} FROM ${FROM} WHERE r.status <> 'pending' ORDER BY r.reviewed_at DESC, r.id LIMIT 25`),
    ]);
    return { pending: pending.rows.map(registration), decided: decided.rows.map(registration) };
  }

  /**
   * One transaction. Takes the parent's organization-creation lock (so a
   * company of the same name can't be created beside it), locks the
   * registration row and then the submitter, re-reads, decides, and applies:
   * approval creates the company (Active, approved to hire) with its audit
   * row, makes the submitter its owner with a grants.grant audit and an event
   * row, and records the decision.
   */
  async review<R extends string>(input: {
    readonly callerId: string;
    readonly review: { readonly registrationId: string; readonly action: "approve" | "reject"; readonly reason: string };
    readonly parentOrgId: string;
    readonly decide: (snapshot: RegistrationReviewSnapshotRow) => { readonly kind: "apply" } | { readonly kind: "refused"; readonly reason: R };
    readonly requestId?: string;
  }): Promise<RegistrationReviewOutcome<R>> {
    const { callerId, review, parentOrgId } = input;
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      // The tree lock (taken by every rename and reparent) and then the
      // parent's creation lock, so the name check below holds until the insert.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('studenthub:organizations:tree'))");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [parentOrgId, CREATION_LOCK_KEY]);
      const row = (await client.query<{ submitter_principal_id: string; status: Status; company_name: string }>(
        "SELECT submitter_principal_id, status, company_name FROM company_registrations WHERE id = $1 FOR UPDATE", [review.registrationId])).rows[0];
      if (row) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [row.submitter_principal_id, PRINCIPAL_LOCK_KEY]);
      const callerGrants = await client.query<{ org_id: string; role: string; scope: string }>(
        "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id FOR SHARE", [callerId]);
      const nameTaken = row ? Boolean((await client.query(
        `SELECT 1 FROM organizations o WHERE o.parent_org_id = $1 AND lower(o.name) = lower($2)
           AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)`, [parentOrgId, row.company_name])).rowCount) : false;
      const submitterPaused = row ? Boolean((await client.query(
        "SELECT 1 FROM account_pauses WHERE principal_id = $1 AND resumed_at IS NULL", [row.submitter_principal_id])).rowCount) : false;
      const decision = input.decide(Object.freeze({
        callerGrants: callerGrants.rows.map((grant) => ({ orgId: grant.org_id, role: grant.role, scope: grant.scope })),
        registration: row ? { submitterPrincipalId: row.submitter_principal_id, status: row.status, companyName: row.company_name } : null,
        nameTaken,
        submitterPaused,
      }));
      if (decision.kind !== "apply") {
        await client.query("ROLLBACK");
        return decision;
      }
      const submitter = row!.submitter_principal_id;

      if (review.action === "reject") {
        await client.query(
          `UPDATE company_registrations SET status = 'rejected', reviewed_by = $2, reviewed_at = clock_timestamp(), review_reason = $3 WHERE id = $1`,
          [review.registrationId, callerId, review.reason]);
        await client.query("COMMIT");
        return { kind: "rejected" };
      }

      const orgId = randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${orgId}`, ORG_LOCK_KEY]);
      const count = Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM organizations o WHERE o.parent_org_id = $1
           AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)`, [parentOrgId])).rows[0]!.count);
      await client.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, $2, $3)", [orgId, row!.company_name, parentOrgId]);
      await client.query(
        `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, target_org_refs, before_summary, after_summary)
         VALUES ($1, $2, 'organization.create', $2, $3::text[], $4::jsonb, $5::jsonb)`,
        [requestAuditRef(`organization_create_${randomUUID()}`), principalAuditRef(callerId), [organizationAuditRef(orgId)],
          JSON.stringify({ childCount: count }), JSON.stringify({ childCount: count + 1 })]);
      await client.query("INSERT INTO organization_status_overrides (org_id, status) VALUES ($1, 'active')", [orgId]);
      await client.query(
        "INSERT INTO organization_status_events (org_id, receipt_ref, from_status, to_status) VALUES ($1, $2, NULL, 'active')",
        [orgId, statusRef(review.registrationId)]);
      await client.query("INSERT INTO organization_approved_to_hire (org_id, approved) VALUES ($1, true)", [orgId]);

      const before = await grantSummary(client, submitter);
      await client.query("INSERT INTO grants (principal_id, org_id, role, scope) VALUES ($1, $2, $3, 'self')", [submitter, orgId, OWNER_ROLE]);
      await insertAuthorizationMutationAudit(client, {
        context: resolveAuthorizationMutationContext({ actorPrincipalId: callerId, ...(input.requestId ? { requestId: input.requestId } : {}) }),
        operation: "grants.grant", targetPrincipalId: submitter, targetOrgIds: [orgId], before, after: await grantSummary(client, submitter),
      });
      await client.query(
        `INSERT INTO access_grant_events (target_principal_id, org_id, role, scope, action, actor_principal_id, reason)
         VALUES ($1, $2, $3, 'self', 'grant', $4, $5)`,
        [submitter, orgId, OWNER_ROLE, callerId, [...`Company registration approved: ${review.reason}`].slice(0, 500).join("")]);
      await client.query(
        `UPDATE company_registrations SET status = 'approved', reviewed_by = $2, reviewed_at = clock_timestamp(), review_reason = $3, org_id = $4 WHERE id = $1`,
        [review.registrationId, callerId, review.reason, orgId]);
      await client.query("COMMIT");
      return { kind: "approved", orgId };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
