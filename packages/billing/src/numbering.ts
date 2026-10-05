import type pg from "pg";

export interface InvoiceNumberRequest {
  readonly accountId: string;
  readonly accountPrefix: string;
  readonly period: string;
}

/** A prefix is permanently bound to one account, across all periods. */
export function validateNumberRequest(input: InvoiceNumberRequest): void {
  if (typeof input.accountId !== "string" || input.accountId.trim() !== input.accountId || !/^[\w-]{1,128}$/.test(input.accountId)
    || typeof input.accountPrefix !== "string" || input.accountPrefix.trim() !== input.accountPrefix || !/^[A-Z][A-Z0-9-]{0,31}$/.test(input.accountPrefix)
    || /^LEGACY(?:-|$)/.test(input.accountPrefix)
    || typeof input.period !== "string" || input.period.trim() !== input.period || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new TypeError("invalid invoice numbering request");
  }
}

/** Caller owns BEGIN/COMMIT/ROLLBACK and must publish only after COMMIT.
 * Rolled-back allocations are not issued numbers. Successful allocations never
 * reset for a new period or a credit. SAVEPOINT rejects accidental autocommit. */
export async function allocateInvoiceNumber(client: pg.PoolClient, input: InvoiceNumberRequest): Promise<string> {
  validateNumberRequest(input);
  await client.query("SAVEPOINT invoice_number_transaction_guard");
  await client.query("RELEASE SAVEPOINT invoice_number_transaction_guard");
  type Counter = { account_prefix: string; last_sequence: string };
  const select = "SELECT account_prefix, last_sequence FROM billing_sequence WHERE account_id = $1 FOR UPDATE";
  let { rows } = await client.query<Counter>(select, [input.accountId]);
  if (rows.length === 0) {
    // Only first use needs INSERT. A concurrent creator can win; reread and
    // lock that committed row before allocating from it.
    await client.query(
      `INSERT INTO billing_sequence (account_id, account_prefix, last_sequence)
       VALUES ($1, $2, 0) ON CONFLICT (account_id) DO NOTHING`,
      [input.accountId, input.accountPrefix],
    );
    rows = (await client.query<Counter>(select, [input.accountId])).rows;
  }
  const row = rows[0];
  if (!row || row.account_prefix !== input.accountPrefix) throw new Error("account prefix is already bound");
  const sequence = BigInt(row.last_sequence) + 1n;
  await client.query("UPDATE billing_sequence SET last_sequence = $2 WHERE account_id = $1", [input.accountId, sequence.toString()]);
  return `${input.accountPrefix}-${input.period}-${sequence.toString().padStart(6, "0")}`;
}
