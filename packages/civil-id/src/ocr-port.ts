/** Trusted worker supplies private bytes; never persist the image or provider text.
 * Production adapters must bound their request duration. No provider is wired here.
 */
export interface OcrPort {
  readCivilId(frontImage: Uint8Array): Promise<unknown>;
}
export interface CivilIdOcrRead {
  readonly countryCode: string;
  readonly civilIdNumber: string;
  readonly expiryDate: string;
}
