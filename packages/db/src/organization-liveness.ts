import pg from "pg";

export async function organizationLive(c: pg.Pool | pg.PoolClient, orgId: string, lock = false): Promise<boolean> {
  const organization = await c.query(`SELECT id FROM organizations WHERE id = $1${lock ? " FOR SHARE" : ""}`, [orgId]);
  if (!organization.rowCount) return false;
  // Keep this separate: under READ COMMITTED, a statement whose row lock waits
  // retains its old snapshot and could miss a deletion committed while waiting.
  const deletion = await c.query("SELECT 1 FROM organization_deletions WHERE org_id = $1", [orgId]);
  return !deletion.rowCount;
}
