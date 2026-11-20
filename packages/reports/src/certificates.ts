/**
 * S8 experience certificates (legacy "Certificate of Appreciation": candidate
 * `CandidateController::actionAppreciationCertificate`, staff the same action with a candidate
 * id). A certificate is made on demand from one of the person's store assignments in the work
 * lane, as legacy made it from a `candidate_work_history` row; nothing is stored, as in legacy.
 *
 * It names the person, the company and store of the assignment, and the dates worked: from the
 * start date to the end date, or to today while the assignment runs (legacy printed "now").
 * An assignment that has not started yet has no experience to certify, so it has no certificate.
 *
 * The person downloads certificates for their own assignments. StudentHub staff download them
 * for anyone (legacy staff `appreciation-certificate/<id>/<wid>`). Anyone else, and any
 * assignment that is not the caller's, gets the same not found.
 */
import { experienceCertificatePdf } from "./certificate-pdf.js";
import { kuwaitDay, type IdCardsAuthority } from "./id-cards.js";

export interface WorkHistoryRow {
  readonly assignmentId: string; readonly company: string; readonly store: string;
  readonly startDate: string; readonly endDate: string | null;
}
export interface CertificateFacts extends WorkHistoryRow { readonly personId: string; readonly name: string | null }
export interface CertificatesStore {
  /** The person's assignments that started on or before `today`, latest first; undefined when there is no such person. */
  workHistory(personId: string, today: string): Promise<{ readonly name: string | null; readonly rows: readonly WorkHistoryRow[] } | undefined>;
  /** One assignment with its person's name; undefined when there is none. */
  assignment(assignmentId: string): Promise<CertificateFacts | undefined>;
}
export interface CertificateEntry extends WorkHistoryRow { readonly until: string; readonly ongoing: boolean }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERSON = /^[A-Za-z0-9@._:+-]{1,256}$/;

export class CertificatesService {
  readonly #store: CertificatesStore; readonly #authority: IdCardsAuthority; readonly #now: () => Date;
  constructor(store: CertificatesStore, authority: IdCardsAuthority, now: () => Date = () => new Date()) {
    this.#store = store; this.#authority = authority; this.#now = now;
  }

  #entry(row: WorkHistoryRow, today: string): CertificateEntry {
    const ongoing = row.endDate === null || row.endDate > today;
    return { assignmentId: row.assignmentId, company: row.company, store: row.store, startDate: row.startDate, endDate: row.endDate, until: ongoing ? today : row.endDate!, ongoing };
  }

  /** The person's own assignments a certificate can be made for. */
  async own(personId: string): Promise<{ readonly name: string | null; readonly rows: readonly CertificateEntry[] }> {
    const today = kuwaitDay(this.#now()), history = await this.#store.workHistory(personId, today);
    return { name: history?.name ?? null, rows: (history?.rows ?? []).map(r => this.#entry(r, today)) };
  }

  /** A staff member's view of a person's assignments; undefined for anyone who is not staff, or no such person. */
  async staffList(viewer: string, personId: string): Promise<{ readonly name: string | null; readonly rows: readonly CertificateEntry[] } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    if (!PERSON.test(personId)) return undefined;
    const today = kuwaitDay(this.#now()), history = await this.#store.workHistory(personId, today);
    return history && { name: history.name, rows: history.rows.map(r => this.#entry(r, today)) };
  }

  /**
   * The certificate PDF for an assignment, or undefined. The person gets their own assignments
   * only; staff get anyone's. Someone else's assignment, one that has not started and one that
   * does not exist all give the same undefined, so a caller learns nothing about others' work.
   */
  async pdf(viewer: string, assignmentId: string): Promise<Buffer | undefined> {
    const staff = await this.#authority.isStaff(viewer);
    if (!ID.test(assignmentId)) return undefined;
    const facts = await this.#store.assignment(assignmentId), today = kuwaitDay(this.#now());
    if (!facts || (!staff && facts.personId !== viewer) || facts.startDate > today) return undefined;
    const entry = this.#entry(facts, today);
    return experienceCertificatePdf({ name: facts.name, company: facts.company, store: facts.store, from: facts.startDate, to: entry.until });
  }
}
