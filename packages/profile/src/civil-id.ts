import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { kuwaitDate } from "./self-edit.js";

export type CivilIdCountry = "KW" | "BH";
export type CivilIdReason = "unsupported_country" | "invalid_number" | "invalid_expiry" | "expired" | "duplicate" | "stale_revision" | "nothing_to_save" | "number_required_for_country_change" | "submission_reused";
export type CivilIdValidation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: CivilIdReason };
export const CIVIL_ID_MESSAGES: Readonly<Record<CivilIdReason, string>> = Object.freeze({
  unsupported_country: "Choose Kuwait or Bahrain", invalid_number: "Enter a valid civil ID number",
  invalid_expiry: "Enter a valid expiry date", expired: "This civil ID has expired",
  duplicate: "Civil ID number already in use with other account!", stale_revision: "Your civil ID details changed. Review them and try again.",
  nothing_to_save: "Nothing to save", number_required_for_country_change: "Enter the civil ID number again when changing country",
  submission_reused: "This save was already submitted",
});

export function normalizeCivilIdNumber(value: string): string {
  return value.normalize("NFKC").replace(/[\u0660-\u0669\u06f0-\u06f9]/g, c => String(c.charCodeAt(0) % 16))
    .replace(/[\s\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\-\u058a\u05be\u1400\u1806\u2010-\u2015\u2e17\u2e1a\u2e3a-\u2e3b\u2e40\u301c\u3030\u30a0\ufe31-\ufe32\ufe58\ufe63\uff0d]/gu, "");
}

export function validateCivilId(input: { readonly country: string; readonly number: string }): CivilIdValidation<{ country: CivilIdCountry; number: string }> {
  if (input.country !== "KW" && input.country !== "BH") return { ok: false, reason: "unsupported_country" };
  const number = normalizeCivilIdNumber(input.number);
  if (!new RegExp(`^[0-9]{${input.country === "KW" ? 12 : 9}}$`).test(number)) return { ok: false, reason: "invalid_number" };
  return { ok: true, value: { country: input.country, number } };
}

function realDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function validateCivilExpiry(value: string, today: string): CivilIdValidation<string> {
  if (!realDate(value) || !realDate(today)) return { ok: false, reason: "invalid_expiry" };
  return value < today ? { ok: false, reason: "expired" } : { ok: true, value };
}
export function maskCivilId(country: CivilIdCountry, number: string): string {
  const last = number.slice(-4);
  return country === "KW" ? `•••• •••• ${last}` : `••••• ${last}`;
}

export interface SealedCivilId { readonly ciphertext: Buffer; readonly hash: Buffer; readonly keyVersion: number }
export class CivilIdVault {
  readonly #encryption: Buffer; readonly #hash: Buffer; readonly keyVersion: number;
  constructor(key: Buffer, keyVersion = 1) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError("civil ID encryption key must be 32 bytes");
    this.#encryption = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "studenthub-civil-id-encryption-v1", 32));
    this.#hash = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "studenthub-civil-id-hash-v1", 32)); this.keyVersion = keyVersion;
  }
  hash(country: CivilIdCountry, number: string): Buffer { return createHmac("sha256", this.#hash).update(country).update("\0").update(number).digest(); }
  seal(principalId: string, country: CivilIdCountry, number: string): SealedCivilId {
    const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", this.#encryption, nonce);
    cipher.setAAD(Buffer.from(`${principalId}\0${country}`)); const encrypted = Buffer.concat([cipher.update(number, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([Buffer.from(number.slice(-4), "ascii"), nonce, cipher.getAuthTag(), encrypted]), hash: this.hash(country, number), keyVersion: this.keyVersion };
  }
  open(principalId: string, country: CivilIdCountry, ciphertext: Buffer): string {
    if (ciphertext.length < 33) throw new Error("invalid sealed civil ID");
    const decipher = createDecipheriv("aes-256-gcm", this.#encryption, ciphertext.subarray(4, 16));
    decipher.setAAD(Buffer.from(`${principalId}\0${country}`)); decipher.setAuthTag(ciphertext.subarray(16, 32));
    return Buffer.concat([decipher.update(ciphertext.subarray(32)), decipher.final()]).toString("utf8");
  }
}

export interface CivilIdRecord { readonly principalId: string; readonly country: CivilIdCountry | null; readonly maskedNumber: string | null; readonly expiry: string | null; readonly needsReview: boolean; readonly revision: number; readonly writtenAt: string; readonly updatedAt: string; readonly releasedAt: string | null }
export interface CivilIdWrite { readonly principalId: string; readonly submissionId: string; readonly revision: number; readonly country: CivilIdCountry | null; readonly sealed: SealedCivilId | null; readonly expiry: string | null; readonly changed: readonly ("country" | "number" | "expiry")[]; readonly occurredAt: string }
export type CivilIdStoreResult = { readonly ok: true; readonly record: CivilIdRecord } | { readonly ok: false; readonly reason: "duplicate" | "stale_revision" | "submission_reused" };
export interface CivilIdStore { read(principalId: string): Promise<CivilIdRecord | null>; submissionRecorded(principalId:string, submissionId:string):Promise<boolean>; numberAvailable(principalId: string, country: CivilIdCountry, hash: Buffer): Promise<boolean>; numberMatchesOwn(principalId: string, country: CivilIdCountry, hash: Buffer): Promise<boolean>; save(write: CivilIdWrite): Promise<CivilIdStoreResult>; release(principalId: string, occurredAt: string): Promise<void>; decryptNumber(principalId: string, vault: CivilIdVault): Promise<string | null> }

export class InMemoryCivilIdStore implements CivilIdStore {
  readonly rows = new Map<string, CivilIdRecord>(); readonly sealed = new Map<string, SealedCivilId>(); readonly events: CivilIdWrite[] = []; readonly submissions = new Set<string>();
  async read(id: string) { return this.rows.get(id) ?? null; }
  async submissionRecorded(id:string, submissionId:string){return this.submissions.has(`${id}:${submissionId}`);}
  async numberAvailable(id: string, country: CivilIdCountry, hash: Buffer) { return ![...this.rows.values()].some(r => r.principalId !== id && !r.releasedAt && r.country === country && this.sealed.get(r.principalId)?.hash.equals(hash)); }
  async numberMatchesOwn(id: string, country: CivilIdCountry, hash: Buffer) { const row=this.rows.get(id); return row?.country===country && !!this.sealed.get(id)?.hash.equals(hash); }
  async save(w: CivilIdWrite): Promise<CivilIdStoreResult> {
    const key = `${w.principalId}:${w.submissionId}`; if (this.submissions.has(key)) return { ok: false, reason: "submission_reused" };
    const old = this.rows.get(w.principalId); if ((old?.revision ?? 0) !== w.revision) return { ok: false, reason: "stale_revision" };
    if (w.sealed && w.country && [...this.rows.values()].some(r => r.principalId !== w.principalId && !r.releasedAt && r.country === w.country && this.sealed.get(r.principalId)?.hash.equals(w.sealed!.hash))) return { ok: false, reason: "duplicate" };
    if (w.sealed) this.sealed.set(w.principalId, w.sealed);
    this.submissions.add(key); const active = this.sealed.get(w.principalId); const record: CivilIdRecord = { principalId: w.principalId, country: w.country, maskedNumber: active && w.country ? maskCivilId(w.country, active.ciphertext.subarray(0,4).toString("ascii")) : null, expiry: w.expiry,
      needsReview: old?.needsReview || w.changed.includes("number") || w.changed.includes("expiry") || false, revision: w.revision + 1,
      writtenAt: old?.writtenAt ?? w.occurredAt, updatedAt: w.occurredAt, releasedAt: null };
    this.rows.set(w.principalId, record); this.events.push(w); return { ok: true, record };
  }
  async release(id: string, at: string) { const row = this.rows.get(id); if (row) this.rows.set(id, { ...row, releasedAt: at, updatedAt: at, revision: row.revision + 1 }); }
  async decryptNumber(id: string, vault: CivilIdVault) { const r = this.rows.get(id), sealed=this.sealed.get(id); return sealed && r?.country ? vault.open(id, r.country, sealed.ciphertext) : null; }
}

export function createCivilId(options: { readonly store: CivilIdStore; readonly vault: CivilIdVault; readonly clock?: { now(): Date } }) {
  const now = () => options.clock?.now() ?? new Date();
  return Object.freeze({
    async readOwn(principalId: string) { const r = await options.store.read(principalId); if (!r || r.releasedAt) return null; return { country: r.country, maskedNumber: r.maskedNumber, expiry: r.expiry, needsReview: r.needsReview, revision: r.revision, updatedAt: r.updatedAt }; },
    async save(input: { principalId: string; submissionId: string; revision: number; country?: string; number?: string; expiry?: string }) {
      const old = await options.store.read(input.principalId); const typed = input.number !== undefined && input.number !== "";
      if(await options.store.submissionRecorded(input.principalId,input.submissionId)) return {ok:false,reason:"submission_reused" as const};
      if (old?.country && input.country && input.country !== old.country && !typed) return { ok: false, reason: "number_required_for_country_change" as const };
      let country = old?.country ?? null; let sealed:SealedCivilId|null = null; const changed: ("country"|"number"|"expiry")[] = [];
      if (typed) { const valid = validateCivilId({ country: input.country ?? "", number: input.number! }); if (!valid.ok) return valid; country=valid.value.country; sealed = options.vault.seal(input.principalId, valid.value.country, valid.value.number); if (!await options.store.numberMatchesOwn(input.principalId, valid.value.country, sealed.hash)) changed.push("number"); if (old?.country !== valid.value.country) changed.push("country"); }
      if (country !== null && country !== "KW" && country !== "BH") return { ok: false, reason: "unsupported_country" as const };
      const expiry = input.expiry === undefined ? old?.expiry ?? null : input.expiry === "" ? null : input.expiry;
      if (expiry !== null) { const valid = validateCivilExpiry(expiry, kuwaitDate(now())); if (!valid.ok) return valid; }
      if (expiry !== (old?.expiry ?? null)) changed.push("expiry"); if (changed.length === 0) return { ok: false, reason: "nothing_to_save" as const };
      if (sealed && country && !await options.store.numberAvailable(input.principalId, country, sealed.hash)) return { ok: false, reason: "duplicate" as const };
      return options.store.save({ principalId: input.principalId, submissionId: input.submissionId, revision: input.revision, country, sealed, expiry, changed, occurredAt: now().toISOString() });
    },
    async release(principalId: string) { await options.store.release(principalId, now().toISOString()); },
  });
}
export type CivilIdService = ReturnType<typeof createCivilId>;
