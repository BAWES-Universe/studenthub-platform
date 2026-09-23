import fs from 'node:fs';

// The committed config.json is the v1 demonstration scope: dispatch_scope
// ["SHU-140"] and max_dispatch 1 — one fixture lane, one slot. It is therefore
// no longer a two-fixture world, and a two-fixture case that reads it as one is
// asserting about the wrong thing: validateTwoFixtureActivation refuses any
// config whose max_dispatch is not 2 (ACT_CAPACITY_DRIFT) and whose
// dispatch_scope is not exactly the reviewed pair (ACT_LANE_CROSS).
//
// So two-fixture cases state the two-fixture world here, explicitly. The lane
// definitions (fixture_lane, fixture_lanes) are still committed and still
// describe both lanes, so they are read from the committed file rather than
// duplicated — only scope and capacity, the two values v1 narrowed, are stated.
const committed = JSON.parse(fs.readFileSync(new URL('../../config.json', import.meta.url), 'utf8'));

export const TWO_FIXTURE_IDS = ['SHU-140', 'SHU-254'];

export function twoFixtureConfig(overrides = {}) {
  const config = { ...structuredClone(committed), max_dispatch: 2, dispatch_scope: { issue_ids: [...TWO_FIXTURE_IDS] }, ...overrides };
  // A two-fixture world needs both committed lanes; fail loudly rather than
  // hand a case a config that only looks like one.
  const lanes = [config.fixture_lane, ...(config.fixture_lanes ?? [])].map(lane => lane?.id);
  if (JSON.stringify(lanes) !== JSON.stringify(TWO_FIXTURE_IDS)) {
    throw new Error(`TWO_FIXTURE_CONFIG: committed lanes are ${JSON.stringify(lanes)}, expected ${JSON.stringify(TWO_FIXTURE_IDS)}`);
  }
  return config;
}
