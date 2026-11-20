import { longDate } from "./id-card-pdf.js";
import { buildPdf, encodable, fitText, PdfPage, type Rgb } from "./pdf.js";

/**
 * The experience certificate as a one-page A4 landscape PDF, laid out after legacy's
 * "Certificate of Appreciation": a double border, the title, "Awarded to", the person's name,
 * "in recognition of working for" the company "at" the store, the dates, and the signature line
 * (legacy: Khalid Almutawa, CEO - StudentHub) with the StudentHub name.
 *
 * The standard PDF fonts have no Arabic, so the name prints in Latin letters; characters outside
 * them are left out, as on the ID card.
 */
export interface ExperienceCertificate {
  readonly name: string | null; readonly company: string; readonly store: string;
  /** YYYY-MM-DD. */
  readonly from: string; readonly to: string;
}

export const A4_LANDSCAPE = { width: 841.89, height: 595.28 } as const;
const NAVY: Rgb = [0x1f, 0x2a, 0x6b], GOLD: Rgb = [0xb8, 0x93, 0x3a], INK: Rgb = [0x1f, 0x23, 0x33], GREY: Rgb = [0x6b, 0x70, 0x80], WHITE: Rgb = [255, 255, 255];

const latin = (text: string) => encodable(text) ? text : [...text.normalize("NFC")].filter(ch => encodable(ch)).join("").replace(/\s+/g, " ").trim();

/** A frame of four bars of thickness `t`, inset `inset` from the page edge. */
function frame(page: PdfPage, inset: number, t: number, fill: Rgb): void {
  const { width: w, height: h } = A4_LANDSCAPE;
  page.rect(inset, inset, w - 2 * inset, t, fill).rect(inset, h - inset - t, w - 2 * inset, t, fill)
    .rect(inset, inset, t, h - 2 * inset, fill).rect(w - inset - t, inset, t, h - 2 * inset, fill);
}

export function experienceCertificatePdf(certificate: ExperienceCertificate): Buffer {
  const { width: w, height: h } = A4_LANDSCAPE, mid = w / 2, inner = w - 160;
  const page = new PdfPage(w, h);
  page.rect(0, 0, w, h, WHITE);
  frame(page, 18, 10, NAVY); frame(page, 36, 2, GOLD);
  page.circle(110, h - 110, 34, GOLD).circle(110, h - 110, 27, WHITE).circle(w - 110, h - 110, 34, GOLD).circle(w - 110, h - 110, 27, WHITE);
  page.text(mid, h - 118, "Certificate of Appreciation", 36, NAVY, "bold", "center");
  page.text(mid, h - 160, "Awarded to", 16, GREY, "regular", "center");
  const name = certificate.name ? latin(certificate.name) : "";
  if (name) { const fit = fitText(name, inner, 34, 16, "bold"); page.text(mid, h - 222, fit.text, fit.size, INK, "bold", "center"); }
  page.rect(mid - 200, h - 236, 400, 1, GOLD);
  page.text(mid, h - 272, "IN RECOGNITION OF WORKING FOR", 13, GREY, "regular", "center");
  const company = fitText(latin(certificate.company), inner, 24, 12, "bold"), store = fitText(latin(certificate.store), inner, 18, 10);
  page.text(mid, h - 308, company.text, company.size, NAVY, "bold", "center");
  page.text(mid, h - 336, "at", 13, GREY, "regular", "center");
  page.text(mid, h - 364, store.text, store.size, INK, "regular", "center");
  page.text(mid, h - 404, `From ${longDate(certificate.from)} to ${longDate(certificate.to)}`, 15, INK, "regular", "center");
  page.rect(110, 118, 200, 1, INK).text(110, 100, "Khalid Almutawa", 12, INK, "bold").text(110, 85, "CEO - StudentHub", 11, GREY);
  page.text(w - 110, 96, "StudentHub", 28, NAVY, "bold", "right");
  return buildPdf([page], "StudentHub experience certificate");
}
