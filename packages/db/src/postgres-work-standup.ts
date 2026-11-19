// The daily stand-up (work lane): questions operator admins keep, answers
// StudentHub staff give. Implements the work package's StandupStore port by shape.

import type { Pool as PgPool, PoolConfig } from "pg";
import { PoolOwner } from "./postgres-work-store.js";

export interface WorkStandupQuestionRecord { readonly id: string; readonly question: string; readonly createdAt: string }
export interface WorkStandupAnswerRecord {
  readonly id: string;
  readonly staffId: string;
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
  readonly workDate: string;
  readonly createdAt: string;
}

interface QuestionRow { id: string; question: string; created_at: Date }
interface AnswerRow { id: string; staff_principal_id: string; question_id: string; question: string; answer: string; work_date: string; created_at: Date }
const question = (r: QuestionRow): WorkStandupQuestionRecord => Object.freeze({ id: r.id, question: r.question, createdAt: r.created_at.toISOString() });
const answer = (r: AnswerRow): WorkStandupAnswerRecord => Object.freeze({
  id: r.id, staffId: r.staff_principal_id, questionId: r.question_id, question: r.question, answer: r.answer, workDate: r.work_date, createdAt: r.created_at.toISOString(),
});
const ANSWER_COLUMNS = `id, staff_principal_id, question_id, question, answer, to_char(work_date,'YYYY-MM-DD') AS work_date, created_at`;

/** The operator organizations whose staff and admins answer the stand-up (as in the work package). */
const OPERATOR_ORG_IDS = ["root"];

export class PostgresWorkStandupStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  async questions(): Promise<readonly WorkStandupQuestionRecord[]> {
    const { rows } = await this.#db.pool.query<QuestionRow>("SELECT id, question, created_at FROM work_standup_questions WHERE retired_at IS NULL ORDER BY created_at, id");
    return Object.freeze(rows.map(question));
  }

  async insertQuestion(q: { id: string; question: string; createdBy: string }): Promise<WorkStandupQuestionRecord> {
    const { rows } = await this.#db.pool.query<QuestionRow>("INSERT INTO work_standup_questions(id, question, created_by) VALUES($1,$2,$3) RETURNING id, question, created_at", [q.id, q.question, q.createdBy]);
    return question(rows[0]!);
  }

  async editQuestion(id: string, text: string): Promise<WorkStandupQuestionRecord | undefined> {
    const { rows } = await this.#db.pool.query<QuestionRow>(
      "UPDATE work_standup_questions SET question = $2, updated_at = clock_timestamp() WHERE id = $1 AND retired_at IS NULL RETURNING id, question, created_at", [id, text]);
    return rows[0] ? question(rows[0]) : undefined;
  }

  async retireQuestion(id: string): Promise<boolean> {
    const { rowCount } = await this.#db.pool.query("UPDATE work_standup_questions SET retired_at = clock_timestamp() WHERE id = $1 AND retired_at IS NULL", [id]);
    return rowCount === 1;
  }

  async nextQuestion(staffId: string, workDate: string): Promise<WorkStandupQuestionRecord | undefined> {
    const { rows } = await this.#db.pool.query<QuestionRow>(
      `SELECT q.id, q.question, q.created_at FROM work_standup_questions q
       WHERE q.retired_at IS NULL AND NOT EXISTS (SELECT 1 FROM work_standup_answers a WHERE a.question_id = q.id AND a.staff_principal_id = $1 AND a.work_date = $2::date)
       ORDER BY q.created_at, q.id LIMIT 1`, [staffId, workDate]);
    return rows[0] ? question(rows[0]) : undefined;
  }

  async insertAnswer(a: { id: string; staffId: string; questionId: string; answer: string; workDate: string }): Promise<"inserted" | "exists" | "gone"> {
    // The question's wording is copied from a question still asked, in the same statement.
    const { rowCount } = await this.#db.pool.query(
      `INSERT INTO work_standup_answers(id, staff_principal_id, question_id, question, answer, work_date, source)
       SELECT $1, $2, q.id, q.question, $4, $5::date, 'app' FROM work_standup_questions q WHERE q.id = $3 AND q.retired_at IS NULL
       ON CONFLICT (staff_principal_id, question_id, work_date) WHERE source = 'app' DO NOTHING`,
      [a.id, a.staffId, a.questionId, a.answer, a.workDate]);
    if (rowCount === 1) return "inserted";
    const { rowCount: asked } = await this.#db.pool.query("SELECT 1 FROM work_standup_questions WHERE id = $1 AND retired_at IS NULL", [a.questionId]);
    return asked ? "exists" : "gone";
  }

  async answers(filter: { workDate: string; staffId?: string; after?: { staffId: string; createdAt: string; id: string }; limit: number }): Promise<readonly WorkStandupAnswerRecord[]> {
    const { rows } = await this.#db.pool.query<AnswerRow>(
      `SELECT ${ANSWER_COLUMNS} FROM work_standup_answers
       WHERE work_date = $1::date AND ($2::text IS NULL OR staff_principal_id = $2)
         AND ($3::text IS NULL OR (staff_principal_id, created_at, id) > ($3::text, $4::timestamptz, $5::uuid))
       ORDER BY staff_principal_id, created_at, id LIMIT $6`,
      [filter.workDate, filter.staffId ?? null, filter.after?.staffId ?? null, filter.after?.createdAt ?? null, filter.after?.id ?? null, filter.limit]);
    return Object.freeze(rows.map(answer));
  }

  async operatorStaff(): Promise<readonly string[]> {
    const { rows } = await this.#db.pool.query<{ principal_id: string }>(
      "SELECT DISTINCT principal_id FROM grants WHERE role IN ('staff','admin') AND scope = 'subtree' AND org_id = ANY($1::text[]) ORDER BY principal_id", [OPERATOR_ORG_IDS]);
    return Object.freeze(rows.map((r) => r.principal_id));
  }

  async staffWithAnswerOn(workDate: string): Promise<ReadonlySet<string>> {
    const { rows } = await this.#db.pool.query<{ staff_principal_id: string }>("SELECT DISTINCT staff_principal_id FROM work_standup_answers WHERE work_date = $1::date", [workDate]);
    return new Set(rows.map((r) => r.staff_principal_id));
  }
}
