import { createHash } from "node:crypto";
import { parseDecimalString, type DecimalString } from "./decimal-string.js";

export interface InvoiceDocument {
  readonly invoiceNumber: string;
  readonly groupId: string;
  readonly orgId: string | null;
  readonly kind: "consolidated" | "subtotal" | "credit";
  readonly issuedAt: string;
  readonly amount: DecimalString;
  readonly taxTotal: DecimalString;
  readonly capturedOrgName: string;
  readonly capturedStoreNames: readonly string[];
  readonly bodyHash: string;
  readonly creditOf?: string;
}

export interface InvoiceContent {
  readonly groupId: string;
  readonly orgId: string | null;
  readonly kind: InvoiceDocument["kind"];
  /** Canonical UTC ISO timestamp, supplied by the caller's clock. */
  readonly issuedAt: string;
  readonly amount: unknown;
  readonly scale: number;
  readonly taxTotal?: unknown;
  /** Tax defaults to three decimals independently of the amount scale. */
  readonly taxScale?: number;
  readonly capturedOrgName: string;
  readonly capturedStoreNames: readonly string[];
  readonly creditOf?: string;
}

/** Server-only port. Implementations must preserve bytes at each returned ref.
 * SQL rollback can orphan a body: retention/cleanup is the binding's responsibility. */
export interface InvoiceBodyStore {
  put(bytes: Uint8Array): Promise<string>;
  get(objectRef: string): Promise<Uint8Array>;
}

export function hashInvoiceBody(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Synthetic fixture only, not a durable production provider. */
export class FixtureInvoiceBodyStore implements InvoiceBodyStore {
  readonly #bodies = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const ref = `fixture:sha256:${hashInvoiceBody(bytes)}`;
    this.#bodies.set(ref, Uint8Array.from(bytes));
    return ref;
  }
  async get(objectRef: string): Promise<Uint8Array> {
    const bytes = this.#bodies.get(objectRef);
    if (!bytes) throw new Error("invoice body unavailable");
    return Uint8Array.from(bytes);
  }
}

/** Canonical v1 body: UTF-8 JSON, fixed field order, no whitespace, store order
 * preserved, no hash (avoids self-reference), no provider-specific object ref. */
export function canonicalInvoiceBody(document: Omit<InvoiceDocument, "bodyHash">): Uint8Array {
  return Buffer.from(JSON.stringify({
    invoiceNumber: document.invoiceNumber, groupId: document.groupId,
    orgId: document.orgId, kind: document.kind, issuedAt: document.issuedAt,
    amount: document.amount, taxTotal: document.taxTotal,
    capturedOrgName: document.capturedOrgName,
    capturedStoreNames: document.capturedStoreNames,
    ...(document.creditOf === undefined ? {} : { creditOf: document.creditOf }),
  }), "utf8");
}

export function captureInvoiceDocument(invoiceNumber: string, input: InvoiceContent): InvoiceDocument {
  const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!nonempty(invoiceNumber) || !nonempty(input.groupId)
    || !(input.orgId === null || nonempty(input.orgId))
    || !["consolidated", "subtotal", "credit"].includes(input.kind)
    || typeof input.issuedAt !== "string" || !Number.isFinite(Date.parse(input.issuedAt))
    || new Date(input.issuedAt).toISOString() !== input.issuedAt
    || !nonempty(input.capturedOrgName) || !Array.isArray(input.capturedStoreNames)
    || !Array.from(input.capturedStoreNames).every(nonempty)
    || (input.kind === "credit" ? !nonempty(input.creditOf) : input.creditOf !== undefined)
    || input.creditOf === invoiceNumber) throw new TypeError("invalid invoice content");
  const captured = {
    invoiceNumber, groupId: input.groupId, orgId: input.orgId, kind: input.kind,
    issuedAt: input.issuedAt, amount: parseDecimalString(input.amount, input.scale),
    taxTotal: input.taxTotal === undefined ? parseDecimalString("0.000", 3)
      : parseDecimalString(input.taxTotal, input.taxScale ?? 3),
    capturedOrgName: input.capturedOrgName,
    capturedStoreNames: Object.freeze([...input.capturedStoreNames]),
    ...(input.creditOf === undefined ? {} : { creditOf: input.creditOf }),
  };
  return Object.freeze({ ...captured, bodyHash: hashInvoiceBody(canonicalInvoiceBody(captured)) });
}
