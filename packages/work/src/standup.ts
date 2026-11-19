// The daily stand-up (legacy daily_standup_question / daily_standup_answer):
// while their day is in progress a StudentHub staff member is asked the next
// question they haven't answered today; operator admins keep the questions and
// read the answers by date and staff member.
//
// Who: any operator staff member answers for themself; operator admins manage
// questions and read everyone's answers (legacy admin app).

import { cleanText, isIsoDate, isPrincipalId, isUuid, kuwaitDate, isOperatorStaff, sqlState, type IsoDate } from "./common.js";
import type { GrantsPort } from "./placement.js";
import { isOperatorAdmin } from "./staff-time.js";

export interface StandupQuestion {
  readonly id: string;
  readonly question: string;
  readonly createdAt: string;
}
export interface StandupAnswer {
  readonly id: string;
  readonly staffId: string;
  readonly questionId: string;
  /** The question as it read when answered. */
  readonly question: string;
  readonly answer: string;
  readonly workDate: IsoDate;
  readonly createdAt: string;
}
export interface StandupAnswerCursor { readonly staffId: string; readonly createdAt: string; readonly id: string }

export interface StandupStore {
  /** Questions still asked, oldest first. */
  questions(): Promise<readonly StandupQuestion[]>;
  insertQuestion(q: { readonly id: string; readonly question: string; readonly createdBy: string }): Promise<StandupQuestion>;
  /** Undefined when there is no such question still asked. */
  editQuestion(id: string, question: string): Promise<StandupQuestion | undefined>;
  /** False when there is no such question still asked. */
  retireQuestion(id: string): Promise<boolean>;
  /** The next question still asked that the staff member hasn't answered on the date. */
  nextQuestion(staffId: string, workDate: IsoDate): Promise<StandupQuestion | undefined>;
  /** "exists" when that question is already answered by them that day; "gone" when the question is retired or unknown. */
  insertAnswer(a: { readonly id: string; readonly staffId: string; readonly questionId: string; readonly answer: string; readonly workDate: IsoDate }): Promise<"inserted" | "exists" | "gone">;
  /** Answers on the date, by staff id then time, after the cursor. */
  answers(filter: { readonly workDate: IsoDate; readonly staffId?: string; readonly after?: StandupAnswerCursor; readonly limit: number }): Promise<readonly StandupAnswer[]>;
  /** Everyone who holds a staff or admin grant on an operator organization. */
  operatorStaff(): Promise<readonly string[]>;
  /** Who answered anything on the date. */
  staffWithAnswerOn(workDate: IsoDate): Promise<ReadonlySet<string>>;
}

export const STANDUP_ANSWER_PAGE_SIZE = 100;
export const STANDUP_QUESTION_MAX = 255;
export const STANDUP_ANSWER_MAX = 4000;
export type StandupRefusal = "forbidden" | "invalid_input" | "not_found" | "already_answered";
type Refused = { readonly kind: "refused"; readonly code: StandupRefusal };
const refused = (code: StandupRefusal): Refused => ({ kind: "refused", code });

export interface StandupServiceOptions {
  readonly store: StandupStore;
  readonly grants: GrantsPort;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export class StandupService {
  readonly #store: StandupStore;
  readonly #grants: GrantsPort;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: StandupServiceOptions) {
    this.#store = options.store;
    this.#grants = options.grants;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  async #staff(actorId: string): Promise<boolean> { return isOperatorStaff(await this.#grants.listGrantsForPrincipal(actorId)); }
  async #admin(actorId: string): Promise<boolean> { return isOperatorAdmin(await this.#grants.listGrantsForPrincipal(actorId)); }

  /** Today's next unanswered question for the actor (null when every question is answered), and their answers today. */
  async today(actorId: string): Promise<{ readonly kind: "today"; readonly workDate: IsoDate; readonly next: StandupQuestion | null; readonly answers: readonly StandupAnswer[] } | Refused> {
    if (!(await this.#staff(actorId))) return refused("forbidden");
    const workDate = kuwaitDate(this.#now());
    const [next, answers] = await Promise.all([this.#store.nextQuestion(actorId, workDate), this.#store.answers({ workDate, staffId: actorId, limit: STANDUP_ANSWER_PAGE_SIZE })]);
    return { kind: "today", workDate, next: next ?? null, answers };
  }

  /** Answers a question for today; a second answer to the same question the same day is refused. */
  async answer(actorId: string, questionId: unknown, answer: unknown): Promise<{ readonly kind: "answered"; readonly workDate: IsoDate } | Refused> {
    if (!(await this.#staff(actorId))) return refused("forbidden");
    const body = cleanText(answer, STANDUP_ANSWER_MAX);
    if (!isUuid(questionId) || body === undefined) return refused("invalid_input");
    const workDate = kuwaitDate(this.#now());
    const result = await this.#store.insertAnswer({ id: this.#newId(), staffId: actorId, questionId: questionId.toLowerCase(), answer: body, workDate });
    if (result === "exists") return refused("already_answered");
    if (result === "gone") return refused("not_found");
    return { kind: "answered", workDate };
  }

  /** The questions still asked; admins only. */
  async questions(actorId: string): Promise<{ readonly kind: "questions"; readonly questions: readonly StandupQuestion[] } | Refused> {
    if (!(await this.#admin(actorId))) return refused("forbidden");
    return { kind: "questions", questions: await this.#store.questions() };
  }

  async addQuestion(actorId: string, question: unknown): Promise<{ readonly kind: "question"; readonly question: StandupQuestion } | Refused> {
    if (!(await this.#admin(actorId))) return refused("forbidden");
    const body = cleanText(question, STANDUP_QUESTION_MAX);
    if (body === undefined) return refused("invalid_input");
    return { kind: "question", question: await this.#store.insertQuestion({ id: this.#newId(), question: body, createdBy: actorId }) };
  }

  /** Rewords a question; answers already given keep the wording they answered. */
  async editQuestion(actorId: string, id: unknown, question: unknown): Promise<{ readonly kind: "question"; readonly question: StandupQuestion } | Refused> {
    if (!(await this.#admin(actorId))) return refused("forbidden");
    const body = cleanText(question, STANDUP_QUESTION_MAX);
    if (!isUuid(id) || body === undefined) return refused("invalid_input");
    const edited = await this.#store.editQuestion(id.toLowerCase(), body);
    return edited ? { kind: "question", question: edited } : refused("not_found");
  }

  /** Stops asking a question (legacy deleted it); its answers stay. */
  async retireQuestion(actorId: string, id: unknown): Promise<{ readonly kind: "retired" } | Refused> {
    if (!(await this.#admin(actorId))) return refused("forbidden");
    if (!isUuid(id)) return refused("invalid_input");
    return (await this.#store.retireQuestion(id.toLowerCase())) ? { kind: "retired" } : refused("not_found");
  }

  /** Everyone's answers on a date (or one staff member's); admins only. */
  async answers(actorId: string, date: unknown, options: { readonly staffId?: string; readonly after?: StandupAnswerCursor | null } = {}):
    Promise<{ readonly kind: "answers"; readonly workDate: IsoDate; readonly answers: readonly StandupAnswer[]; readonly next: StandupAnswerCursor | null } | Refused> {
    if (!isIsoDate(date)) return refused("invalid_input");
    if (options.staffId !== undefined && !isPrincipalId(options.staffId)) return refused("invalid_input");
    if (options.after && (!isPrincipalId(options.after.staffId) || !isUuid(options.after.id) || typeof options.after.createdAt !== "string" || Number.isNaN(Date.parse(options.after.createdAt)))) return refused("invalid_input");
    if (!(await this.#admin(actorId))) return refused("forbidden");
    const rows = await this.#store.answers({ workDate: date, ...(options.staffId ? { staffId: options.staffId } : {}), ...(options.after ? { after: options.after } : {}), limit: STANDUP_ANSWER_PAGE_SIZE + 1 });
    const page = rows.slice(0, STANDUP_ANSWER_PAGE_SIZE);
    const last = page[page.length - 1];
    return { kind: "answers", workDate: date, answers: page, next: rows.length > STANDUP_ANSWER_PAGE_SIZE && last ? { staffId: last.staffId, createdAt: last.createdAt, id: last.id } : null };
  }

  /** Operator staff who answered nothing on the date (legacy list-inactive); admins only. */
  async unanswered(actorId: string, date: unknown): Promise<{ readonly kind: "unanswered"; readonly workDate: IsoDate; readonly staffIds: readonly string[] } | Refused> {
    if (!isIsoDate(date)) return refused("invalid_input");
    if (!(await this.#admin(actorId))) return refused("forbidden");
    const [everyone, answered] = await Promise.all([this.#store.operatorStaff(), this.#store.staffWithAnswerOn(date)]);
    return { kind: "unanswered", workDate: date, staffIds: [...new Set(everyone)].filter((id) => !answered.has(id)).sort() };
  }
}

/** Unique violation on the one-answer index: a parallel answer won. */
export function isStandupAnswerConflict(error: unknown): boolean {
  return sqlState(error) === "23505";
}
