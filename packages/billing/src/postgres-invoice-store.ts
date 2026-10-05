import type pg from "pg";
import { allocateInvoiceNumber, type InvoiceNumberRequest } from "./numbering.js";
import { canonicalInvoiceBody, captureInvoiceDocument, hashInvoiceBody,
  type InvoiceBodyStore, type InvoiceContent, type InvoiceDocument } from "./document.js";

/** Trusted internal persistence primitive, not an authorization boundary.
 * Caller supplies an authorized account and an active transaction; it must roll
 * back on ANY failure and publish the returned document only after commit. */
export async function issueInvoice(client: pg.PoolClient, bodies: InvoiceBodyStore,
  input: InvoiceNumberRequest & InvoiceContent): Promise<InvoiceDocument> {
  // Validate and copy mutable caller-owned fields before the first await.
  const captured = captureInvoiceDocument("pending", input);
  const request = { accountId: input.accountId, accountPrefix: input.accountPrefix, period: input.period };
  const invoiceNumber = await allocateInvoiceNumber(client, request);
  if (captured.creditOf !== undefined) {
    const original = await client.query(
      `SELECT 1 FROM invoice_document WHERE account_id = $1 AND invoice_number = $2
       AND group_id = $3 AND org_id IS NOT DISTINCT FROM $4 AND kind <> 'credit'`,
      [request.accountId, captured.creditOf, captured.groupId, captured.orgId],
    );
    if (original.rowCount !== 1) throw new Error("credit original not found in invoice scope");
  }
  const content = { ...captured, invoiceNumber };
  const bytes = canonicalInvoiceBody(content);
  const document = Object.freeze({ ...content, bodyHash: hashInvoiceBody(bytes) });
  const objectRef = await bodies.put(Uint8Array.from(bytes));
  if (typeof objectRef !== "string" || objectRef.length === 0) throw new Error("invalid invoice object reference");
  await client.query(
    `INSERT INTO invoice_document
     (account_id, invoice_number, group_id, org_id, kind, credit_of, document, body_hash, object_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [request.accountId, invoiceNumber, document.groupId, document.orgId, document.kind,
      document.creditOf ?? null, JSON.stringify(document), document.bodyHash, objectRef],
  );
  return document;
}

/** Reads only the issued snapshot and its body, never live org/store records.
 * Account scope is mandatory even though invoice numbers are globally unique. */
export async function resolveInvoice(client: pg.PoolClient, bodies: InvoiceBodyStore,
  accountId: string, invoiceNumber: string): Promise<Readonly<{ document: InvoiceDocument; body: Uint8Array }> | undefined> {
  const { rows } = await client.query<{ document: InvoiceDocument; body_hash: string; object_ref: string }>(
    "SELECT document, body_hash, object_ref FROM invoice_document WHERE account_id = $1 AND invoice_number = $2",
    [accountId, invoiceNumber],
  );
  const row = rows[0];
  if (!row) return undefined;
  const body = Uint8Array.from(await bodies.get(row.object_ref));
  if (hashInvoiceBody(body) !== row.body_hash || row.document.bodyHash !== row.body_hash
    || !Buffer.from(body).equals(canonicalInvoiceBody(row.document))) {
    throw new Error("invoice body integrity failure");
  }
  const document = Object.freeze({ ...row.document, capturedStoreNames: Object.freeze([...row.document.capturedStoreNames]) });
  return Object.freeze({ document, body });
}
