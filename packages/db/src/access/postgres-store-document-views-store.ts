import pg from "pg";

/** People M-05 (migration 0411): each store document link issued and each document delivered, append-only. */
export type StoreDocumentView = {
  readonly viewerPrincipalId: string;
  readonly subjectPrincipalId: string;
  readonly storeId: string;
  readonly operation: "issue" | "deliver";
  readonly documentType: "personal-photo" | "resume";
  readonly documentVersion: string;
};

export class PostgresStoreDocumentViewsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) { this.#pool = options.pool; this.#ownsPool = false; }
    else { this.#pool = new pg.Pool({ connectionString: options.connectionString }); this.#ownsPool = true; }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async recordView(view: StoreDocumentView): Promise<void> {
    await this.#pool.query(
      `INSERT INTO store_document_views (viewer_principal_id, subject_principal_id, store_id, operation, document_type, document_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [view.viewerPrincipalId, view.subjectPrincipalId, view.storeId, view.operation, view.documentType, view.documentVersion]);
  }

  /** A person's views, newest first. */
  async forSubject(subjectPrincipalId: string): Promise<readonly (StoreDocumentView & { readonly at: string })[]> {
    const { rows } = await this.#pool.query<{ viewer_principal_id: string; subject_principal_id: string; store_id: string; operation: "issue" | "deliver"; document_type: "personal-photo" | "resume"; document_version: string; at: Date }>(
      `SELECT viewer_principal_id, subject_principal_id, store_id, operation, document_type, document_version, at
       FROM store_document_views WHERE subject_principal_id = $1 ORDER BY at DESC, id DESC`, [subjectPrincipalId]);
    return rows.map((row) => ({ viewerPrincipalId: row.viewer_principal_id, subjectPrincipalId: row.subject_principal_id, storeId: row.store_id,
      operation: row.operation, documentType: row.document_type, documentVersion: row.document_version, at: row.at.toISOString() }));
  }
}
