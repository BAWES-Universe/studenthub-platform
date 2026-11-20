import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The ID card's verification link (S8 b). The QR code on a printed card holds
 * `<origin>/v/<card number>.<valid until, YYYYMMDD>.<signature>`. The signature is an HMAC with a
 * key only the server holds, so a link cannot be made up or changed: someone who scans the card
 * learns only what the public page shows (name, photo, company and whether the card is valid),
 * and nobody can walk the card numbers.
 *
 * The link expires with the printed card: after the date printed on it the page says the card
 * has expired, even if staff have renewed the person's card since (the renewed card is a new
 * print with a new link). Before that date the page still checks the card as it is now, so a
 * card that was shortened or whose holder left shows as not valid.
 */
export const ID_CARD_VERIFY_PATH = "/v/";
/** How long a photo key from the public page stays good. */
export const ID_CARD_PHOTO_SECONDS = 60;
const TOKEN = /^([1-9][0-9]{0,17})\.(\d{4})(\d{2})(\d{2})\.([A-Za-z0-9_-]{22})$/;

export class IdCardVerifier {
  readonly #key: Buffer;
  /** `key` is at least 32 random bytes, kept only on the server. */
  constructor(key: Buffer) {
    if (!Buffer.isBuffer(key) || key.length < 32) throw new RangeError("the ID card verification key must be at least 32 bytes");
    this.#key = Buffer.from(key);
  }
  #mac(cardNumber: number, validUntil: string): string {
    return createHmac("sha256", this.#key).update(`studenthub.id-card.verify.v1|${cardNumber}|${validUntil}`).digest().subarray(0, 16).toString("base64url");
  }
  /** The token for a card printed with `validUntil` (YYYY-MM-DD). */
  token(cardNumber: number, validUntil: string): string {
    if (!Number.isSafeInteger(cardNumber) || cardNumber < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) throw new RangeError("invalid card");
    return `${cardNumber}.${validUntil.replace(/-/g, "")}.${this.#mac(cardNumber, validUntil)}`;
  }
  /** The full link for the QR code, on `origin` (https://host). */
  url(origin: string, cardNumber: number, validUntil: string): string {
    const base = new URL(origin);
    if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") throw new RangeError("the verification link must be https");
    return `${base.origin}${ID_CARD_VERIFY_PATH}${this.token(cardNumber, validUntil)}`;
  }
  /**
   * The card number and printed date a token's text carries, and whether this key signed it.
   * Undefined only when the text is not shaped like a token; a caller that answers the same for a
   * forged token and a missing card does the same work for both (looks the number up) either way.
   */
  parse(token: string): { readonly cardNumber: number; readonly validUntil: string; readonly signed: boolean } | undefined {
    const m = TOKEN.exec(token); if (!m) return undefined;
    const cardNumber = Number(m[1]), validUntil = `${m[2]}-${m[3]}-${m[4]}`;
    if (!Number.isSafeInteger(cardNumber)) return undefined;
    const expected = Buffer.from(this.#mac(cardNumber, validUntil)), given = Buffer.from(m[5]!);
    return { cardNumber, validUntil, signed: expected.length === given.length && timingSafeEqual(expected, given) };
  }
  /** The card number and printed date a token carries, or undefined when it was not made with this key. */
  read(token: string): { readonly cardNumber: number; readonly validUntil: string } | undefined {
    const parsed = this.parse(token);
    return parsed?.signed ? { cardNumber: parsed.cardNumber, validUntil: parsed.validUntil } : undefined;
  }
  #photoMac(token: string, expires: number): string {
    return createHmac("sha256", this.#key).update(`studenthub.id-card.photo.v1|${token}|${expires}`).digest().subarray(0, 16).toString("base64url");
  }
  /**
   * The short-lived key for the photo on the page of `token`: `<expiry, epoch seconds>.<signature>`,
   * good for ID_CARD_PHOTO_SECONDS. The page hands it out each time it is shown, so a copied photo
   * link stops working within a minute and the photo is never reachable from the card link alone.
   */
  photoKey(token: string, nowEpochSeconds: number): string {
    const expires = Math.floor(nowEpochSeconds) + ID_CARD_PHOTO_SECONDS;
    return `${expires}.${this.#photoMac(token, expires)}`;
  }
  /** Whether `key` is a photo key this server made for `token` that has not expired. */
  photoKeyValid(token: string, key: string, nowEpochSeconds: number): boolean {
    const m = /^(\d{10})\.([A-Za-z0-9_-]{22})$/.exec(key);
    const expires = m ? Number(m[1]) : 0;
    const expected = Buffer.from(this.#photoMac(token, expires)), given = Buffer.from(m?.[2] ?? "".padEnd(22, "A"));
    const signed = expected.length === given.length && timingSafeEqual(expected, given);
    return !!m && signed && expires > nowEpochSeconds && expires <= nowEpochSeconds + ID_CARD_PHOTO_SECONDS;
  }
}
