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
import type { IdCardVerifier } from "./id-card-verify.js";
import { qrModules } from "./qr.js";
import { publicPhoto, type PublicPhoto } from "./public-photo.js";

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
  /** The public verification page's facts for a card number; undefined when there is no such card. */
  verify(cardNumber: number, today: string): Promise<{ readonly personId: string; readonly name: string | null; readonly company: string | null; readonly expiresOn: string; readonly assigned: boolean } | undefined>;
  /** How many assigned people have no card, and how many have an expired one, for the morning summary. */
  counts(today: string): Promise<{ readonly needs: number; readonly expired: number }>;
}
export interface IdCardsAuthority { isStaff(principalId: string): Promise<boolean> }
/** The person's current personal photo for a card `viewerId` is printing (the read is audited against the viewer); null when they have none. */
export interface IdCardPhotoSource { read(personId: string, viewerId: string): Promise<{ readonly bytes: Buffer; readonly mime: string } | null> }

/**
 * The card holder's photo for the anonymous public page. Each read that returns bytes is first
 * recorded against the card and the hashed client address (there is no signed-in viewer); when
 * that record cannot be written, no bytes are returned.
 */
export interface IdCardPublicPhotoSource { read(personId: string, view: { readonly cardNumber: number; readonly clientHash: string }): Promise<{ readonly bytes: Buffer; readonly mime: string } | null> }

/** What the public page shows for a scanned card. Never the civil ID number or the phone (finding F10). */
export type IdCardCheck =
  | { readonly status: "unknown" }
  | { readonly status: "checked"; readonly name: string | null; readonly company: string | null; readonly validUntil: string; readonly valid: boolean; readonly reason: "expired" | "not_assigned" | null;
      /** The short-lived key for the holder's photo; only on a valid card, and only when public photos are configured. */
      readonly photoKey: string | null };

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
  readonly #store: IdCardsStore; readonly #authority: IdCardsAuthority; readonly #now: () => Date; readonly #photos: IdCardPhotoSource | undefined; readonly #verifier: IdCardVerifier | undefined; readonly #publicPhotos: IdCardPublicPhotoSource | undefined;
  /** Without a `verifier` the cards print without a QR code and every verification link is unknown; without `publicPhotos` the public page shows no photo. */
  constructor(store: IdCardsStore, authority: IdCardsAuthority, now: () => Date = () => new Date(), photos?: IdCardPhotoSource, verifier?: IdCardVerifier, publicPhotos?: IdCardPublicPhotoSource) {
    this.#store = store; this.#authority = authority; this.#now = now; this.#photos = photos; this.#verifier = verifier; this.#publicPhotos = publicPhotos;
  }

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

  /** The person's own card as a PDF, or undefined when they have none. `origin` is the site the QR code links to. */
  async ownPdf(personId: string, origin?: string): Promise<Buffer | undefined> {
    const card = await this.#store.card(personId, kuwaitDay(this.#now()));
    return card && idCardsPdf([await this.#face(personId, card, personId, origin)]);
  }

  /** Staff print a batch of cards as one PDF, in the order given; every person must have a card. */
  async staffPdf(viewer: string, people: readonly string[], origin?: string): Promise<{ readonly status: "ok"; readonly pdf: Buffer } | { readonly status: "refused"; readonly refusals: readonly { readonly personId: string; readonly code: "no_card" }[] } | { readonly status: "invalid" } | { readonly status: "not_found" }> {
    const batch = [...people]; // copied before the first await, as in write
    if (!(await this.#authority.isStaff(viewer))) return { status: "not_found" };
    if (batch.length === 0 || batch.length > ID_CARD_BATCH_MAX || new Set(batch).size !== batch.length || batch.some(p => !PERSON.test(p))) return { status: "invalid" };
    const today = kuwaitDay(this.#now()), cards = await Promise.all(batch.map(p => this.#store.card(p, today)));
    const missing = batch.filter((_, i) => !cards[i]);
    if (missing.length) return { status: "refused", refusals: missing.map(personId => ({ personId, code: "no_card" as const })) };
    // Photos are read one at a time: a file-backed document store takes an exclusive lock per read.
    const faces: IdCardFace[] = [];
    for (const [i, p] of batch.entries()) faces.push(await this.#face(p, cards[i]!, viewer, origin));
    return { status: "ok", pdf: idCardsPdf(faces) };
  }

  async #face(personId: string, card: OwnIdCard, viewerId: string, origin: string | undefined): Promise<IdCardFace> {
    // Only reached after the caller is authorized (the person's own card, or staff). A photo that cannot be read or placed leaves the plain circle; the card still prints.
    const photo = await this.#photos?.read(personId, viewerId).catch(() => null);
    const qr = this.#verifier && origin ? qrModules(this.#verifier.url(origin, card.cardNumber, card.expiresOn)) : null;
    return { name: card.name, employeeId: card.employeeId, cardNumber: card.cardNumber, expiresOn: card.expiresOn, placement: card.placement, photo: photo ? readImage(photo.bytes, photo.mime) : null, qr };
  }

  /**
   * The card a link names as it is now, with the date the link is valid until. Every link shaped
   * like a token is looked up, signed or not, so a forged link, a missing card and a real one take
   * the same work; anything not signed by this server is then unknown, like a missing card.
   */
  async #lookup(token: string) {
    const parsed = this.#verifier?.parse(token);
    if (!parsed) return undefined;
    const today = kuwaitDay(this.#now()), card = await this.#store.verify(parsed.cardNumber, today);
    if (!parsed.signed || !card) return undefined;
    const validUntil = parsed.validUntil < card.expiresOn ? parsed.validUntil : card.expiresOn;
    const reason = validUntil < today ? "expired" as const : !card.assigned ? "not_assigned" as const : null;
    return { card, cardNumber: parsed.cardNumber, validUntil, reason };
  }

  /**
   * The public check behind the QR code. Valid while the printed date has not passed, the card
   * has not expired, and its holder is still assigned to a store. Anything not signed by this
   * server is unknown, the same as a card number that does not exist. A valid card's answer
   * carries a photo key good for ID_CARD_PHOTO_SECONDS.
   */
  async check(token: string): Promise<IdCardCheck> {
    const found = await this.#lookup(token);
    if (!found) return { status: "unknown" };
    const { card, validUntil, reason } = found;
    const photoKey = reason === null && this.#publicPhotos ? this.#verifier!.photoKey(token, Math.floor(this.#now().getTime() / 1000)) : null;
    return { status: "checked", name: card.name, company: card.company, validUntil, valid: reason === null, reason, photoKey };
  }

  /**
   * The holder's photo for the public page, rebuilt without metadata (publicPhoto), or null. Only
   * for a signed link to a card that is valid now, with an unexpired photo key made for that link.
   * Every refusal (unknown, forged, expired or revoked card, stale key, no photo) is the same null.
   */
  async publicPhoto(token: string, key: string, clientHash: string): Promise<PublicPhoto | null> {
    const found = await this.#lookup(token);
    const keyValid = !!this.#verifier && this.#verifier.photoKeyValid(token, key, Math.floor(this.#now().getTime() / 1000));
    if (!found || found.reason !== null || !keyValid || !this.#publicPhotos || !/^[A-Za-z0-9_-]{22}$/.test(clientHash)) return null;
    const photo = await this.#publicPhotos.read(found.card.personId, { cardNumber: found.cardNumber, clientHash });
    return photo && publicPhoto(photo.bytes, photo.mime);
  }

  counts(at: Date): Promise<{ readonly needs: number; readonly expired: number }> { return this.#store.counts(kuwaitDay(at)); }
}
