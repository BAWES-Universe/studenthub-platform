/**
 * S8 ID cards (legacy `candidate_id_card`, staff `CandidateIdCardController`). StudentHub staff
 * issue a card to people who are assigned to a store; it is valid for three months and staff
 * renew it for another three. The card shows the person's name and the company and store of
 * their current assignment, read when the card is shown, so a move to another store shows on
 * the card without a new one.
 *
 * Who counts as assigned is the same rule the morning summary uses for civil IDs: an
 * assignment in the work lane that has not ended (no end date, or one today or later, in
 * Asia/Kuwait). Legacy's lists use `candidate.store_id > 0`, which is the same set.
 *
 * A batch issue or renewal is all or nothing, as in legacy: if any person in it cannot get a
 * card, nothing is written and every refusal is returned.
 */
import { idCardsPdf, type IdCardFace } from "./id-card-pdf.js";
import { readImage } from "./pdf.js";

export const ID_CARD_VALID_MONTHS = 3;
export const ID_CARD_BATCH_MAX = 100;
export const ID_CARD_PAGE_SIZE = 50;
export const ID_CARD_VIEWS = ["needs", "expired", "issued"] as const;
export type IdCardView = typeof ID_CARD_VIEWS[number];
export type IdCardAction = "issue" | "renew";
export type IdCardRefusal = "unknown_person" | "not_assigned" | "no_card";

export interface IdCardPlacement { readonly company: string; readonly store: string }
export interface IdCardListRow {
  readonly personId: string; readonly name: string | null; readonly employeeId: string | null;
  readonly cardNumber: number | null; readonly expiresOn: string | null; readonly placement: IdCardPlacement | null;
}
export interface OwnIdCard {
  readonly name: string | null; readonly arabicName: string | null; readonly employeeId: string | null; readonly cardNumber: number;
  readonly expiresOn: string; readonly issuedAt: Date; readonly placement: IdCardPlacement | null;
}
export interface IdCardsStore {
  /** One page of a staff list for the Asia/Kuwait day `today`, with the list's total. */
  list(view: IdCardView, today: string, name: string | null, offset: number, limit: number): Promise<{ readonly rows: readonly IdCardListRow[]; readonly total: number }>;
  /**
   * In one transaction: checks every person, and when none is refused sets each card's expiry to
   * `expiresOn` (creating it on issue) with one event row each. Returns the refusals; when there
   * are any, nothing was written.
   */
  write(action: IdCardAction, people: readonly string[], today: string, expiresOn: string, actor: string): Promise<readonly { readonly personId: string; readonly code: IdCardRefusal }[]>;
  card(personId: string, today: string): Promise<OwnIdCard | undefined>;
  /** How many assigned people have no card, and how many have an expired one, for the morning summary. */
  counts(today: string): Promise<{ readonly needs: number; readonly expired: number }>;
}
export interface IdCardsAuthority { isStaff(principalId: string): Promise<boolean> }
/** The person's current personal photo for a card `viewerId` is printing (the read is audited against the viewer); null when they have none. */
export interface IdCardPhotoSource { read(personId: string, viewerId: string): Promise<{ readonly bytes: Buffer; readonly mime: string } | null> }

export type IdCardWriteResult =
  | { readonly status: "ok"; readonly count: number; readonly expiresOn: string }
  | { readonly status: "refused"; readonly refusals: readonly { readonly personId: string; readonly code: IdCardRefusal }[] }
  | { readonly status: "invalid" }
  | { readonly status: "not_found" };

// The principal id grammar the access layer accepts (account pause); the store then refuses ids that are not people.
const PERSON = /^[A-Za-z0-9@._:+-]{1,256}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The Asia/Kuwait calendar day of an instant. */
export function kuwaitDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** `day` plus `months` calendar months; a day past the end of the month becomes its last day (30 Nov + 3 months = 28 Feb). */
export function addMonths(day: string, months: number): string {
  const m = DAY.exec(day); if (!m || !Number.isInteger(months)) throw new RangeError("invalid day");
  const total = Number(m[1]) * 12 + Number(m[2]) - 1 + months, year = Math.floor(total / 12), month = total % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(), d = Math.min(Number(m[3]), last);
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export class IdCardsService {
  readonly #store: IdCardsStore; readonly #authority: IdCardsAuthority; readonly #now: () => Date; readonly #photos: IdCardPhotoSource | undefined;
  constructor(store: IdCardsStore, authority: IdCardsAuthority, now: () => Date = () => new Date(), photos?: IdCardPhotoSource) { this.#store = store; this.#authority = authority; this.#now = now; this.#photos = photos; }

  /** A staff list; undefined for anyone who is not StudentHub staff. */
  async list(viewer: string, view: IdCardView, name: string | null, page: number): Promise<{ readonly rows: readonly IdCardListRow[]; readonly total: number; readonly today: string } | undefined> {
    if (!(await this.#authority.isStaff(viewer))) return undefined;
    if (!ID_CARD_VIEWS.includes(view) || !Number.isInteger(page) || page < 1) throw new RangeError("invalid list");
    const today = kuwaitDay(this.#now()), cleaned = name?.trim() ? name.trim().slice(0, 100) : null;
    return { ...(await this.#store.list(view, today, cleaned, (page - 1) * ID_CARD_PAGE_SIZE, ID_CARD_PAGE_SIZE)), today };
  }

  /** Staff issue (or re-issue) or renew cards for a batch of people, valid three months from today. */
  async write(viewer: string, action: IdCardAction, people: readonly string[]): Promise<IdCardWriteResult> {
    // The batch is copied before the first await, so a caller cannot change it after authorization.
    const batch = [...people];
    if (!(await this.#authority.isStaff(viewer))) return { status: "not_found" };
    const unique = [...new Set(batch)];
    if ((action !== "issue" && action !== "renew") || unique.length === 0 || unique.length > ID_CARD_BATCH_MAX || unique.length !== batch.length || unique.some(p => !PERSON.test(p))) return { status: "invalid" };
    const today = kuwaitDay(this.#now()), expiresOn = addMonths(today, ID_CARD_VALID_MONTHS);
    const refusals = await this.#store.write(action, unique, today, expiresOn, viewer);
    return refusals.length ? { status: "refused", refusals } : { status: "ok", count: unique.length, expiresOn };
  }

  /** The person's own card, with whether it is still valid today. */
  async own(personId: string): Promise<(OwnIdCard & { readonly valid: boolean }) | undefined> {
    const today = kuwaitDay(this.#now()), card = await this.#store.card(personId, today);
    return card && { ...card, valid: card.expiresOn >= today };
  }

  /** The person's own card as a PDF, or undefined when they have none. */
  async ownPdf(personId: string): Promise<Buffer | undefined> {
    const card = await this.#store.card(personId, kuwaitDay(this.#now()));
    return card && idCardsPdf([await this.#face(personId, card, personId)]);
  }

  /** Staff print a batch of cards as one PDF, in the order given; every person must have a card. */
  async staffPdf(viewer: string, people: readonly string[]): Promise<{ readonly status: "ok"; readonly pdf: Buffer } | { readonly status: "refused"; readonly refusals: readonly { readonly personId: string; readonly code: "no_card" }[] } | { readonly status: "invalid" } | { readonly status: "not_found" }> {
    const batch = [...people]; // copied before the first await, as in write
    if (!(await this.#authority.isStaff(viewer))) return { status: "not_found" };
    if (batch.length === 0 || batch.length > ID_CARD_BATCH_MAX || new Set(batch).size !== batch.length || batch.some(p => !PERSON.test(p))) return { status: "invalid" };
    const today = kuwaitDay(this.#now()), cards = await Promise.all(batch.map(p => this.#store.card(p, today)));
    const missing = batch.filter((_, i) => !cards[i]);
    if (missing.length) return { status: "refused", refusals: missing.map(personId => ({ personId, code: "no_card" as const })) };
    // Photos are read one at a time: a file-backed document store takes an exclusive lock per read.
    const faces: IdCardFace[] = [];
    for (const [i, p] of batch.entries()) faces.push(await this.#face(p, cards[i]!, viewer));
    return { status: "ok", pdf: idCardsPdf(faces) };
  }

  async #face(personId: string, card: OwnIdCard, viewerId: string): Promise<IdCardFace> {
    // Only reached after the caller is authorized (the person's own card, or staff). A photo that cannot be read or placed leaves the plain circle; the card still prints.
    const photo = await this.#photos?.read(personId, viewerId).catch(() => null);
    return { name: card.name, employeeId: card.employeeId, cardNumber: card.cardNumber, expiresOn: card.expiresOn, placement: card.placement, photo: photo ? readImage(photo.bytes, photo.mime) : null };
  }

  counts(at: Date): Promise<{ readonly needs: number; readonly expired: number }> { return this.#store.counts(kuwaitDay(at)); }
}
