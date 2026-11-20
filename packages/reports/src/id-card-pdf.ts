import type { IdCardPlacement } from "./id-cards.js";
import { buildPdf, encodable, fitText, PdfPage, type PdfImage, type Rgb } from "./pdf.js";

/**
 * The ID card as a printable PDF: two pages, front and back, each the size of a bank card
 * (CR80, 54 x 85.6 mm, portrait), laid out after legacy's card (blue top with the round photo,
 * white bottom). A batch is one PDF with two pages per person, in the order given.
 *
 * Front: the photo (or a plain circle without one), the name, the card number, the company,
 * the store and the valid-until date. Back: where to return a found card, and the QR code once
 * verification lands. Legacy printed the civil ID number on the back; the new card does not,
 * since anyone who picks the card up could read it (finding F10).
 *
 * The standard PDF fonts have no Arabic, so the card prints the name in Latin letters; a name
 * with characters outside them is printed without those characters, and a name with nothing
 * left is not printed (the card number and employee ID still identify the person).
 */
export interface IdCardFace {
  readonly name: string | null; readonly employeeId: string | null; readonly cardNumber: number;
  readonly expiresOn: string; readonly placement: IdCardPlacement | null;
  readonly photo?: PdfImage | null;
  /** The verification QR code's modules, row 0 at the top. */
  readonly qr?: readonly (readonly boolean[])[] | null;
}

export const CARD_WIDTH = 153.07, CARD_HEIGHT = 242.65; // 54 x 85.6 mm in points
const BLUE: Rgb = [0x3d, 0x4a, 0xb8], WHITE: Rgb = [255, 255, 255], INK: Rgb = [0x1f, 0x23, 0x33], GREY: Rgb = [0x6b, 0x70, 0x80], PALE: Rgb = [0xd9, 0xdc, 0xf2];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2027-02-19" as "19 February 2027". */
export function longDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day); if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new RangeError("invalid day");
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
/** The card number as printed: six digits at least. */
export const cardNumberText = (n: number) => String(n).padStart(6, "0");

function front(card: IdCardFace): PdfPage {
  const page = new PdfPage(CARD_WIDTH, CARD_HEIGHT), mid = CARD_WIDTH / 2, inner = CARD_WIDTH - 20;
  page.rect(0, 0, CARD_WIDTH, CARD_HEIGHT, WHITE).rect(0, 99, CARD_WIDTH, CARD_HEIGHT - 99, BLUE);
  page.text(8, CARD_HEIGHT - 14, `No. ${cardNumberText(card.cardNumber)}`, 6.5, WHITE, "bold");
  // The photo: a white ring with the picture, or a pale circle without one.
  const cy = 182, r = 38;
  page.circle(mid, cy, r + 1.5, WHITE);
  if (card.photo) page.image(card.photo, mid - r, cy - r, r * 2, r * 2, "circle"); else page.circle(mid, cy, r, PALE);
  const name = card.name && encodable(card.name) ? card.name : card.name ? [...card.name.normalize("NFC")].filter(ch => encodable(ch)).join("").replace(/\s+/g, " ").trim() : "";
  if (name) { const fit = fitText(name, inner, 12, 7, "bold"); page.text(mid, 116, fit.text, fit.size, WHITE, "bold", "center"); }
  if (card.employeeId) page.text(mid, 105, `Employee ID ${card.employeeId}`, 6.5, WHITE, "regular", "center");
  if (card.placement) {
    const company = fitText(card.placement.company, inner, 10, 6, "bold"), store = fitText(card.placement.store, inner, 8.5, 6);
    page.text(mid, 80, company.text, company.size, INK, "bold", "center").text(mid, 68, store.text, store.size, INK, "regular", "center");
  }
  page.text(mid, 50, "Valid until", 6.5, GREY, "regular", "center").text(mid, 40, longDate(card.expiresOn), 8.5, INK, "bold", "center");
  page.text(mid, 14, "StudentHub", 13, BLUE, "bold", "center");
  return page;
}

function back(card: IdCardFace): PdfPage {
  const page = new PdfPage(CARD_WIDTH, CARD_HEIGHT), mid = CARD_WIDTH / 2;
  page.rect(0, 0, CARD_WIDTH, CARD_HEIGHT, WHITE);
  if (card.qr?.length) {
    const size = 92;
    page.modules(card.qr, mid - size / 2, CARD_HEIGHT - 22 - size, size, INK);
    page.text(mid, CARD_HEIGHT - 32 - size, "Scan to check this card", 6.5, GREY, "regular", "center");
  }
  page.text(mid, 104, "studenthub.co", 9, BLUE, "bold", "center");
  ["If you find this card, please", "return it to BAWES Computer", "Programming Company."].forEach((line, i) => page.text(mid, 80 - i * 9, line, 7, INK, "regular", "center"));
  page.text(mid, 46, "contact@bawes.net", 7, INK, "regular", "center").text(mid, 37, "+965 98009771", 7, INK, "regular", "center");
  page.rect(0, 0, CARD_WIDTH, 18, BLUE).text(mid, 6, "StudentHub", 8, WHITE, "bold", "center");
  return page;
}

/** One PDF with the front and back of each card, in order. */
export function idCardsPdf(cards: readonly IdCardFace[]): Buffer {
  if (!cards.length) throw new RangeError("no cards");
  return buildPdf(cards.flatMap(card => [front(card), back(card)]), cards.length === 1 ? "StudentHub ID card" : "StudentHub ID cards");
}
