import pg from "pg";

/**
 * Runs `action` while another transaction holds an uncommitted change (a grant revocation, a soft delete), then
 * commits that change. A write that decides on rows read FOR SHARE waits for the change and sees it; a write that
 * checks outside its transaction finishes on the stale rows first. Deterministic: it waits until `action` is blocked
 * on the held transaction (or has already finished) before committing.
 */
export async function whileUncommitted<T>(pool: pg.Pool, sql: string, params: readonly unknown[], action: () => Promise<T>): Promise<T> {
  const held = await pool.connect();
  try {
    await held.query("BEGIN");
    await held.query(sql, [...params]);
    const pid = (await held.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    let settled = false;
    const pending = action().finally(() => { settled = true; });
    pending.catch(() => undefined);
    for (let i = 0; i < 500 && !settled; i++) {
      const blocked = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))", [pid])).rowCount;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await held.query("COMMIT");
    return await pending;
  } catch (error) {
    await held.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    held.release();
  }
}

/** Revokes every grant a principal holds, in a transaction left open while `action` runs. */
export const revokeDuring = <T>(pool: pg.Pool, principalId: string, action: () => Promise<T>) =>
  whileUncommitted(pool, "DELETE FROM grants WHERE principal_id = $1::text", [principalId], action);
