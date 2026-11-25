/**
 * New placements reach people's feeds from the email delivery job: each run first dispatches waiting
 * placement events (a `work.assigned` feed item each), then goes on with the rest of the run. A failed
 * dispatch never holds back the rest; the events stay waiting for the next run, and the failure is
 * raised once the rest has run.
 */
export const PLACEMENT_FEED_BATCH = 200;
export interface PlacementFeedPort { dispatch(limit: number, at: Date): Promise<number> }

export async function dispatchPlacementsThen(port: PlacementFeedPort, rest: () => Promise<number>, now: () => Date = () => new Date()): Promise<number> {
  let failure: unknown, failed = false;
  try { await port.dispatch(PLACEMENT_FEED_BATCH, now()); } catch (error) { failed = true; failure = error; }
  const sent = await rest();
  if (failed) throw failure;
  return sent;
}
