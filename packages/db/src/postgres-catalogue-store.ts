import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import type {
  CatalogueItem, CatalogueItemInput, CatalogueSortKey, CatalogueStore,
  CatalogueSubmission, CatalogueType, SubmittableCatalogueType,
} from "@studenthub/reference-catalogue";
import { catalogueSortKey } from "@studenthub/reference-catalogue";

interface ItemRow {
  id: string; catalogue_type: CatalogueType; name: string; code: string | null;
  status: "active" | "deleted"; created_at: Date; updated_at: Date; deleted_at: Date | null;
}
interface SubmissionRow {
  id: string; catalogue_type: SubmittableCatalogueType; name: string; code: string | null;
  status: "pending" | "approved" | "rejected"; submitted_at: Date;
  moderated_at: Date | null; created_item_id: string | null;
}

export class PostgresCatalogueStore implements CatalogueStore {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async listActive(type: CatalogueType, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueItem[]> {
    const { rows } = await this.#pool.query<ItemRow>(
      `SELECT id, catalogue_type, name, code, status, created_at, updated_at, deleted_at
       FROM catalogue_items
       WHERE catalogue_type = $1 AND status = 'active'
         AND ($2::text IS NULL OR normalized_name COLLATE "C" > $2::text COLLATE "C"
           OR (normalized_name = $2 AND id > $3::uuid))
       ORDER BY normalized_name COLLATE "C", id LIMIT $4`,
      [type, after?.sortKey ?? null, after?.id ?? null, limit],
    );
    return rows.map(itemFromRow);
  }

  async resolveById(type: CatalogueType, id: string): Promise<CatalogueItem | undefined> {
    const { rows } = await this.#pool.query<ItemRow>(
      `SELECT id, catalogue_type, name, code, status, created_at, updated_at, deleted_at
       FROM catalogue_items WHERE catalogue_type = $1 AND id = $2`, [type, id]);
    return rows[0] && itemFromRow(rows[0]);
  }

  async createItem(input: CatalogueItem & { readonly actorRef: string }): Promise<CatalogueItem> {
    const { rows } = await this.#pool.query<ItemRow>(
      `INSERT INTO catalogue_items
       (id, catalogue_type, name, normalized_name, code, status, created_by_ref, updated_by_ref, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$6,$7,$7)
       RETURNING id, catalogue_type, name, code, status, created_at, updated_at, deleted_at`,
      [input.id, input.type, input.name, catalogueSortKey(input.name), input.code ?? null, input.actorRef, input.createdAt]);
    return itemFromRow(rows[0]!);
  }

  async updateItem(type: CatalogueType, id: string, input: CatalogueItemInput & { readonly actorRef: string; readonly now: string }): Promise<CatalogueItem | undefined> {
    const { rows } = await this.#pool.query<ItemRow>(
      `UPDATE catalogue_items SET name=$3, normalized_name=$4, code=$5, updated_by_ref=$6, updated_at=$7
       WHERE catalogue_type=$1 AND id=$2 AND status='active'
       RETURNING id, catalogue_type, name, code, status, created_at, updated_at, deleted_at`,
      [type, id, input.name, catalogueSortKey(input.name), input.code ?? null, input.actorRef, input.now]);
    return rows[0] && itemFromRow(rows[0]);
  }

  async softDeleteItem(type: CatalogueType, id: string, actorRef: string, now: string): Promise<CatalogueItem | undefined> {
    const { rows } = await this.#pool.query<ItemRow>(
      `UPDATE catalogue_items SET status='deleted', deleted_at=$4, updated_at=$4, updated_by_ref=$3
       WHERE catalogue_type=$1 AND id=$2 AND status='active'
       RETURNING id, catalogue_type, name, code, status, created_at, updated_at, deleted_at`,
      [type, id, actorRef, now]);
    return rows[0] && itemFromRow(rows[0]);
  }

  async createSubmission(input: CatalogueSubmission & { readonly actorRef: string; readonly orgId: string }): Promise<CatalogueSubmission> {
    const { rows } = await this.#pool.query<SubmissionRow>(
      `INSERT INTO catalogue_submissions
       (id,catalogue_type,name,normalized_name,code,status,submitted_by_ref,organization_id,submitted_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)
       RETURNING id,catalogue_type,name,code,status,submitted_at,moderated_at,created_item_id`,
      [input.id, input.type, input.name, catalogueSortKey(input.name), input.code ?? null, input.actorRef, input.orgId, input.submittedAt]);
    return submissionFromRow(rows[0]!);
  }

  async listSubmissions(status: CatalogueSubmission["status"], type: SubmittableCatalogueType | undefined, after: CatalogueSortKey | undefined, limit: number): Promise<readonly CatalogueSubmission[]> {
    const { rows } = await this.#pool.query<SubmissionRow>(
      `SELECT id,catalogue_type,name,code,status,submitted_at,moderated_at,created_item_id
       FROM catalogue_submissions WHERE status=$1 AND ($2::text IS NULL OR catalogue_type=$2)
         AND ($3::timestamptz IS NULL OR submitted_at > $3::timestamptz
           OR (submitted_at = $3::timestamptz AND id > $4::uuid))
       ORDER BY submitted_at,id LIMIT $5`, [status, type ?? null, after?.sortKey ?? null, after?.id ?? null, limit]);
    return rows.map(submissionFromRow);
  }

  async moderateSubmission(id: string, decision: "approved" | "rejected", actorRef: string, now: string, itemId: string): Promise<CatalogueSubmission | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<SubmissionRow>(
        `SELECT id,catalogue_type,name,code,status,submitted_at,moderated_at,created_item_id
         FROM catalogue_submissions WHERE id=$1 FOR UPDATE`, [id]);
      const current = selected.rows[0];
      if (!current || current.status !== "pending") { await client.query("ROLLBACK"); return undefined; }
      let createdItemId: string | null = null;
      if (decision === "approved") {
        await insertApprovedItem(client, current, itemId, actorRef, now);
        createdItemId = itemId;
      }
      const { rows } = await client.query<SubmissionRow>(
        `UPDATE catalogue_submissions SET status=$2, moderated_by_ref=$3, moderated_at=$4, created_item_id=$5
         WHERE id=$1 AND status='pending'
         RETURNING id,catalogue_type,name,code,status,submitted_at,moderated_at,created_item_id`,
        [id, decision, actorRef, now, createdItemId]);
      await client.query("COMMIT");
      return rows[0] && submissionFromRow(rows[0]);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally { client.release(); }
  }
}

async function insertApprovedItem(client: PoolClient, submission: SubmissionRow, id: string, actorRef: string, now: string): Promise<void> {
  await client.query(
    `INSERT INTO catalogue_items
     (id,catalogue_type,name,normalized_name,code,status,created_by_ref,updated_by_ref,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$6,$7,$7)`,
    [id, submission.catalogue_type, submission.name, catalogueSortKey(submission.name), submission.code, actorRef, now]);
}

function itemFromRow(row: ItemRow): CatalogueItem {
  return { id: row.id, type: row.catalogue_type, name: row.name, ...(row.code === null ? {} : { code: row.code }),
    status: row.status, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at.toISOString() }) };
}
function submissionFromRow(row: SubmissionRow): CatalogueSubmission {
  return { id: row.id, type: row.catalogue_type, name: row.name, ...(row.code === null ? {} : { code: row.code }),
    status: row.status, submittedAt: row.submitted_at.toISOString(),
    ...(row.moderated_at === null ? {} : { moderatedAt: row.moderated_at.toISOString() }),
    ...(row.created_item_id === null ? {} : { createdItemId: row.created_item_id }) };
}
