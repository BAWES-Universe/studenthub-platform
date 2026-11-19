import { randomUUID } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "../connection.js";

// Recruit R2b: the admin checklist and staff notes on requests. Admins keep the
// checklist; staff, admin and operator recruiters read it and write, edit and
// softly remove notes (legacy let any staff member do so). Refusals answer null
// or not_found so nothing is revealed.

type Grant = { org_id: string; role: string; scope: string };
type NoteType = "internal_note" | "phone_call" | "email" | "meeting" | "interview" | "task";

export interface RecruitChecklistItemInput { readonly nameEn: string; readonly nameAr: string | null; readonly required: boolean; readonly sortOrder: number }
export interface RecruitNoteInput { readonly type: NoteType; readonly text: string; readonly checklistItemId: string | null; readonly cardId: string | null }
export interface RecruitChecklistItemRecord { id: string; name_en: string; name_ar: string | null; required: boolean; sort_order: number }
export interface RecruitNoteRecord {
  id: string; card_id: string | null; person_name: string | null; checklist_item_id: string | null; checklist_name: string | null;
  note_type: NoteType; note_text: string; author_name: string | null; created_at: string; updated_at: string;
}
export interface RecruitChecklistStoreOptions {
  readonly connectionString?: string;
  readonly pool?: pg.Pool;
  readonly adminDecision: (rows: readonly Grant[]) => boolean;
  readonly notesDecision: (rows: readonly Grant[]) => boolean;
}
export type RecruitNoteWriteResult = { kind: "created"; noteId: string } | { kind: "updated" | "removed" } | { kind: "not_found" | "item_not_found" | "card_not_found" };

export class PostgresRecruitChecklistStore {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(readonly options: RecruitChecklistStoreOptions) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async #grants(c: pg.Pool | pg.PoolClient, principalId: string, lock = false): Promise<Grant[]> {
    return (await c.query<Grant>(`SELECT org_id, role, scope FROM grants WHERE principal_id = $1::text${lock ? " FOR SHARE" : ""}`, [principalId])).rows;
  }

  /**
   * Every write decides inside its own transaction on grants read FOR SHARE, so a revocation either commits first
   * (and the write is refused) or waits until the write has committed; it can never land between check and write.
   */
  async #transaction<T>(work: (c: pg.PoolClient) => Promise<T | { rollback: T }>): Promise<T> {
    const c = await this.#pool.connect();
    let broken = false;
    try {
      await c.query("BEGIN");
      const result = await work(c);
      if (typeof result === "object" && result !== null && "rollback" in result) {
        await c.query("ROLLBACK");
        return (result as { rollback: T }).rollback;
      }
      await c.query("COMMIT");
      return result as T;
    } catch (error) {
      try { await c.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally {
      c.release(broken);
    }
  }

  /** Active items for anyone who may write notes or keep the checklist; null otherwise. */
  async items(principalId: string): Promise<RecruitChecklistItemRecord[] | null> {
    const grants = await this.#grants(this.#pool, principalId);
    if (!this.options.notesDecision(grants) && !this.options.adminDecision(grants)) return null;
    return (await this.#pool.query<RecruitChecklistItemRecord>("SELECT id, name_en, name_ar, required, sort_order FROM recruit_checklist_items WHERE status = 'active' ORDER BY sort_order, id")).rows;
  }

  async createItem(principalId: string, input: RecruitChecklistItemInput): Promise<{ kind: "created"; itemId: string } | { kind: "not_found" }> {
    return this.#transaction<{ kind: "created"; itemId: string } | { kind: "not_found" }>(async (c) => {
      if (!this.options.adminDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const id = randomUUID();
      await c.query("INSERT INTO recruit_checklist_items(id, name_en, name_ar, required, sort_order) VALUES($1::uuid, $2::text, $3::text, $4::boolean, $5::int)", [id, input.nameEn, input.nameAr, input.required, input.sortOrder]);
      return { kind: "created", itemId: id };
    });
  }

  async updateItem(principalId: string, itemId: string, input: RecruitChecklistItemInput): Promise<{ kind: "updated" | "not_found" }> {
    return this.#transaction<{ kind: "updated" | "not_found" }>(async (c) => {
      if (!this.options.adminDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const r = await c.query("UPDATE recruit_checklist_items SET name_en = $2::text, name_ar = $3::text, required = $4::boolean, sort_order = $5::int, updated_at = clock_timestamp() WHERE id = $1::uuid AND status = 'active'", [itemId, input.nameEn, input.nameAr, input.required, input.sortOrder]);
      return r.rowCount === 1 ? { kind: "updated" } : { rollback: { kind: "not_found" } };
    });
  }

  async removeItem(principalId: string, itemId: string): Promise<{ kind: "removed" | "not_found" }> {
    return this.#transaction<{ kind: "removed" | "not_found" }>(async (c) => {
      if (!this.options.adminDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const r = await c.query("UPDATE recruit_checklist_items SET status = 'deleted', updated_at = clock_timestamp() WHERE id = $1::uuid AND status = 'active'", [itemId]);
      return r.rowCount === 1 ? { kind: "removed" } : { rollback: { kind: "not_found" } };
    });
  }

  async addNote(principalId: string, requestId: string, input: RecruitNoteInput): Promise<RecruitNoteWriteResult> {
    return this.#transaction<RecruitNoteWriteResult>(async (c) => {
      if (!this.options.notesDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      // The request, the ticked step and the named card are read FOR SHARE: a step removed at the same moment either
      // commits first (and the note is refused) or waits until the note has committed.
      if (!(await c.query("SELECT 1 FROM recruit_requests WHERE id = $1::uuid FOR SHARE", [requestId])).rowCount) return { rollback: { kind: "not_found" } };
      if (input.checklistItemId !== null && !(await c.query("SELECT 1 FROM recruit_checklist_items WHERE id = $1::uuid AND status = 'active' FOR SHARE", [input.checklistItemId])).rowCount) return { rollback: { kind: "item_not_found" } };
      if (input.cardId !== null && !(await c.query("SELECT 1 FROM recruit_pipeline_cards WHERE id = $1::uuid AND request_id = $2::uuid FOR SHARE", [input.cardId, requestId])).rowCount) return { rollback: { kind: "card_not_found" } };
      const id = randomUUID();
      await c.query(
        "INSERT INTO recruit_request_notes(id, request_id, card_id, checklist_item_id, note_type, note_text, author_principal_id, updated_by_principal_id) VALUES($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text, $7::text)",
        [id, requestId, input.cardId, input.checklistItemId, input.type, input.text, principalId]);
      return { kind: "created", noteId: id };
    });
  }

  async editNote(principalId: string, noteId: string, type: NoteType, text: string): Promise<RecruitNoteWriteResult> {
    return this.#transaction<RecruitNoteWriteResult>(async (c) => {
      if (!this.options.notesDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const r = await c.query("UPDATE recruit_request_notes SET note_type = $2::text, note_text = $3::text, updated_by_principal_id = $4::text, updated_at = clock_timestamp() WHERE id = $1::uuid AND removed_at IS NULL", [noteId, type, text, principalId]);
      return r.rowCount === 1 ? { kind: "updated" } : { rollback: { kind: "not_found" } };
    });
  }

  async removeNote(principalId: string, noteId: string): Promise<RecruitNoteWriteResult> {
    return this.#transaction<RecruitNoteWriteResult>(async (c) => {
      if (!this.options.notesDecision(await this.#grants(c, principalId, true))) return { rollback: { kind: "not_found" } };
      const r = await c.query("UPDATE recruit_request_notes SET removed_at = clock_timestamp(), updated_by_principal_id = $2::text, updated_at = clock_timestamp() WHERE id = $1::uuid AND removed_at IS NULL", [noteId, principalId]);
      return r.rowCount === 1 ? { kind: "removed" } : { rollback: { kind: "not_found" } };
    });
  }

  /** A request's notes (oldest first) and the checklist items any note has ticked, in three queries; null when refused or unknown. */
  async requestNotes(principalId: string, requestId: string): Promise<{ title: string; notes: RecruitNoteRecord[]; items: RecruitChecklistItemRecord[]; doneItemIds: string[]; cards: { id: string; person_name: string | null }[] } | null> {
    if (!this.options.notesDecision(await this.#grants(this.#pool, principalId))) return null;
    const request = (await this.#pool.query<{ position_title: string }>("SELECT position_title FROM recruit_requests WHERE id = $1::uuid", [requestId])).rows[0];
    if (!request) return null;
    const [notes, items, cards] = await Promise.all([
      this.#pool.query<RecruitNoteRecord>(
        `SELECT n.id, n.card_id, COALESCE(cpp.display_name, cp.display_name, cf.name) AS person_name, n.checklist_item_id, i.name_en AS checklist_name,
           n.note_type, n.note_text, COALESCE(app.display_name, ap.display_name) AS author_name, n.created_at, n.updated_at
         FROM recruit_request_notes n
         LEFT JOIN recruit_pipeline_cards c ON c.id = n.card_id LEFT JOIN principals cp ON cp.id = c.person_principal_id LEFT JOIN person_profiles cpp ON cpp.principal_id = c.person_principal_id LEFT JOIN recruit_fulltimers cf ON cf.id = c.fulltimer_id
         LEFT JOIN recruit_checklist_items i ON i.id = n.checklist_item_id
         LEFT JOIN principals ap ON ap.id = n.author_principal_id LEFT JOIN person_profiles app ON app.principal_id = n.author_principal_id
         WHERE n.request_id = $1::uuid AND n.removed_at IS NULL ORDER BY n.created_at, n.id`, [requestId]),
      this.#pool.query<RecruitChecklistItemRecord>("SELECT id, name_en, name_ar, required, sort_order FROM recruit_checklist_items WHERE status = 'active' ORDER BY sort_order, id"),
      // The people on this request's pipeline, so a note can be about one of them.
      this.#pool.query<{ id: string; person_name: string | null }>(
        `SELECT c.id, COALESCE(pp.display_name, p.display_name, f.name) AS person_name FROM recruit_pipeline_cards c
         LEFT JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = c.person_principal_id LEFT JOIN recruit_fulltimers f ON f.id = c.fulltimer_id
         WHERE c.request_id = $1::uuid ORDER BY c.created_at, c.id`, [requestId]),
    ]);
    const done = [...new Set(notes.rows.map((n) => n.checklist_item_id).filter((id): id is string => id !== null))];
    return { title: request.position_title, notes: notes.rows, items: items.rows, doneItemIds: done, cards: cards.rows };
  }
}
