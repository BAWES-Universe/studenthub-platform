import assert from "node:assert/strict";
import test from "node:test";
import { CONTRIBUTIONS, mergeContributions, type Contributions } from "../src/contributions/index.js";

test("PREP_NAV default area contributions preserve profile navigation", () => {
  assert.deepEqual(CONTRIBUTIONS.navigation.map(({ key, order, current }) => ({ key, order, ...(current ? { current } : {}) })), [
    { key: "profile", order: 100, current: true },
    { key: "background", order: 200 },
    { key: "workspaces", order: 300 },
  ]);
  assert.deepEqual(CONTRIBUTIONS.profileRows, []);
  assert.equal(CONTRIBUTIONS.navigation[2]!.visible({}), false);
  assert.equal(CONTRIBUTIONS.navigation[2]!.visible({ navigation: {} as never }), true);
});

test("PREP_NAV_MERGE sorts by order then key and refuses duplicate keys", () => {
  const contribution = (key: string, order: number): Contributions => ({
    navigation: [{ key, order, href: `/${key}`, labelKey: "nav.profile", visible: () => true }], profileRows: [],
  });
  assert.deepEqual(mergeContributions([contribution("z", 100), contribution("a", 100), contribution("middle", 50)]).navigation.map(item => item.key), ["middle", "a", "z"]);
  assert.throws(() => mergeContributions([contribution("same", 1), contribution("same", 2)]), /duplicate contribution key/);
});
