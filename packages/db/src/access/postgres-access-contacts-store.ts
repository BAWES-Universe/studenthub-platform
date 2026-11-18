import { randomUUID } from "node:crypto";
import pg from "pg";
import { organizationLive } from "../organization-liveness.js";
import { ancestorsOf } from "./postgres-access-grants-store.js";

/**
 * Access lane A3 (migration 0402): a company's extra contacts. A contact has
 * no principal and no grant; nothing here reads or writes grants beyond the
 * caller's own, for the decision. Writes take the company lock and decide
 * inside their transaction on what they read there.
 */

type Held = { readonly orgId: string; readonly role: string; readonly scope: string };
type Refused<R extends string> = { readonly kind: "refused"; readonly reason: R };
type Channel = { readonly value: string; readonly label: string | null };
type Contact = { readonly name: string; readonly roleTitle: string | null; readonly phones: readonly Channel[]; readonly emails: readonly Channel[] };
type Snapshot = { callerGrants: readonly Held[]; orgLive: boolean; orgAncestors: readonly string[]; liveContacts: number };

const ORG_LOCK_KEY = 5960;

export class PostgresAccessContactsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) { this.#pool = options.pool; this.#ownsPool = false; }
    else { this.#pool = new pg.Pool({ connectionString: options.connectionString }); this.#ownsPool = true; }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async context(callerId: string, orgId: string): Promise<{
    readonly callerGrants: readonly Held[];
    readonly organization: null | { readonly orgId: string; readonly name: string; readonly ancestors: readonly string[] };
  }> {
    const [grants, org] = await Promise.all([
      this.#pool.query<{ org_id: string; role: string; scope: string }>("SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id", [callerId]),
      this.#pool.query<{ id: string; name: string }>(
        `SELECT o.id, o.name FROM organizations o
         WHERE o.id = $1 AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id)`, [orgId]),
    ]);
    const callerGrants = grants.rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }));
    const row = org.rows[0];
    if (!row) return { callerGrants, organization: null };
    const ancestors = await ancestorsOf(this.#pool, [row.id]);
    return { callerGrants, organization: { orgId: row.id, name: row.name, ancestors: ancestors.get(row.id) ?? [] } };
  }

  /** Live contacts and all their channels: two queries whatever the count. */
  async contacts(orgId: string): Promise<readonly { id: string; name: string; roleTitle: string | null; phones: Channel[]; emails: Channel[]; updatedAt: string }[]> {
    const contacts = await this.#pool.query<{ id: string; name: string; role_title: string | null; updated_at: Date }>(
      `SELECT id, name, role_title, updated_at FROM company_contacts
       WHERE org_id = $1 AND removed_at IS NULL ORDER BY lower(name), id`, [orgId]);
    if (contacts.rowCount === 0) return [];
    const channels = await this.#pool.query<{ contact_id: string; kind: "phone" | "email"; value: string; label: string | null }>(
      `SELECT contact_id, kind, value, label FROM company_contact_channels
       WHERE contact_id = ANY($1::uuid[]) ORDER BY contact_id, kind, position`, [contacts.rows.map((row) => row.id)]);
    const byContact = new Map<string, { phones: Channel[]; emails: Channel[] }>();
    for (const row of contacts.rows) byContact.set(row.id, { phones: [], emails: [] });
    for (const row of channels.rows) byContact.get(row.contact_id)?.[row.kind === "phone" ? "phones" : "emails"].push({ value: row.value, label: row.label });
    return contacts.rows.map((row) => ({ id: row.id, name: row.name, roleTitle: row.role_title, ...byContact.get(row.id)!, updatedAt: row.updated_at.toISOString() }));
  }

  async #write<T>(callerId: string, orgId: string, run: (client: pg.PoolClient, snapshot: Snapshot) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", [`access:org:${orgId}`, ORG_LOCK_KEY]);
      const grants = await client.query<{ org_id: string; role: string; scope: string }>(
        "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id FOR SHARE", [callerId]);
      const orgLive = await organizationLive(client, orgId, true);
      const ancestors = orgLive ? (await ancestorsOf(client, [orgId])).get(orgId) ?? [] : [];
      const live = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM company_contacts WHERE org_id = $1 AND removed_at IS NULL", [orgId]);
      const result = await run(client, {
        callerGrants: grants.rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope })),
        orgLive, orgAncestors: ancestors, liveContacts: live.rows[0]?.n ?? 0,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async #channels(client: pg.PoolClient, contactId: string, contact: Contact): Promise<void> {
    await client.query("DELETE FROM company_contact_channels WHERE contact_id = $1", [contactId]);
    const rows = [
      ...contact.phones.map((channel, position) => ["phone", position, channel] as const),
      ...contact.emails.map((channel, position) => ["email", position, channel] as const),
    ];
    if (rows.length === 0) return;
    await client.query(
      `INSERT INTO company_contact_channels (contact_id, kind, position, value, label)
       SELECT $1, kind, position, value, label FROM unnest($2::text[], $3::smallint[], $4::text[], $5::text[]) AS c(kind, position, value, label)`,
      [contactId, rows.map((row) => row[0]), rows.map((row) => row[1]), rows.map((row) => row[2].value), rows.map((row) => row[2].label)]);
  }

  async create<R extends string>(input: { readonly callerId: string; readonly orgId: string; readonly contact: Contact; readonly now: Date;
    readonly decide: (snapshot: Snapshot) => { readonly kind: "ok" } | Refused<R> }): Promise<{ readonly kind: "created"; readonly id: string } | Refused<R>> {
    return this.#write(input.callerId, input.orgId, async (client, snapshot) => {
      const decision = input.decide(snapshot);
      if (decision.kind === "refused") return decision;
      const id = randomUUID();
      await client.query(
        `INSERT INTO company_contacts (id, org_id, name, role_title, created_by, created_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $5, $6)`,
        [id, input.orgId, input.contact.name, input.contact.roleTitle, input.callerId, input.now]);
      await this.#channels(client, id, input.contact);
      return { kind: "created", id };
    });
  }

  async update<R extends string>(input: { readonly callerId: string; readonly orgId: string; readonly contactId: string; readonly contact: Contact; readonly now: Date;
    readonly decide: (snapshot: Snapshot) => { readonly kind: "ok" } | Refused<R> }): Promise<{ readonly kind: "updated" } | Refused<R | "not_found">> {
    return this.#write(input.callerId, input.orgId, async (client, snapshot) => {
      const decision = input.decide(snapshot);
      if (decision.kind === "refused") return decision;
      const changed = await client.query(
        `UPDATE company_contacts SET name = $3, role_title = $4, updated_by = $5, updated_at = $6
         WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`,
        [input.contactId, input.orgId, input.contact.name, input.contact.roleTitle, input.callerId, input.now]);
      if (!changed.rowCount) return { kind: "refused", reason: "not_found" };
      await this.#channels(client, input.contactId, input.contact);
      return { kind: "updated" };
    });
  }

  /** Soft removal: the row stays with removed_at; its channels, grants, principals and profiles are untouched. */
  async remove<R extends string>(input: { readonly callerId: string; readonly orgId: string; readonly contactId: string; readonly now: Date;
    readonly decide: (snapshot: Snapshot) => { readonly kind: "ok" } | Refused<R> }): Promise<{ readonly kind: "removed" } | Refused<R | "not_found">> {
    return this.#write(input.callerId, input.orgId, async (client, snapshot) => {
      const decision = input.decide(snapshot);
      if (decision.kind === "refused") return decision;
      const changed = await client.query(
        `UPDATE company_contacts SET removed_at = $3, removed_by = $4
         WHERE id = $1 AND org_id = $2 AND removed_at IS NULL`,
        [input.contactId, input.orgId, input.now, input.callerId]);
      return changed.rowCount ? { kind: "removed" } : { kind: "refused", reason: "not_found" };
    });
  }
}
