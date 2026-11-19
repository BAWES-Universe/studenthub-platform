import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, IdCardsService, kuwaitDay, ID_CARD_BATCH_MAX } from "../src/index.js";
import type { IdCardAction, IdCardsStore, IdCardView } from "../src/index.js";

test("REPORTS_ID_CARDS three calendar months, clamped to the end of a shorter month", () => {
  assert.equal(addMonths("2026-11-19", 3), "2027-02-19");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2027-11-30", 3), "2028-02-29", "leap year");
  assert.equal(addMonths("2026-10-31", 3), "2027-01-31");
  assert.equal(addMonths("2026-12-31", 2), "2027-02-28");
  assert.throws(() => addMonths("19-11-2026", 3), /invalid day/);
});

test("REPORTS_ID_CARDS today is the Asia/Kuwait day", () => {
  assert.equal(kuwaitDay(new Date("2026-11-19T20:59:59Z")), "2026-11-19");
  assert.equal(kuwaitDay(new Date("2026-11-19T21:00:00Z")), "2026-11-20");
});

class Store implements IdCardsStore {
  writes: { action: IdCardAction; people: readonly string[]; today: string; expiresOn: string; actor: string }[] = [];
  lists: { view: IdCardView; today: string; name: string | null; offset: number; limit: number }[] = [];
  refuse: { personId: string; code: "not_assigned" }[] = [];
  async list(view: IdCardView, today: string, name: string | null, offset: number, limit: number) { this.lists.push({ view, today, name, offset, limit }); return { rows: [], total: 0 }; }
  async write(action: IdCardAction, people: readonly string[], today: string, expiresOn: string, actor: string) { this.writes.push({ action, people, today, expiresOn, actor }); return this.refuse; }
  async card(personId: string) { return personId === "holder" ? { name: "Alia Badr", arabicName: null, employeeId: null, cardNumber: 7, expiresOn: "2026-11-19", issuedAt: new Date(), placement: null } : undefined; }
  async counts() { return { needs: 0, expired: 0 }; }
}
const rig = (at = "2026-11-19T21:30:00Z") => {
  const store = new Store();
  return { store, service: new IdCardsService(store, { async isStaff(id: string) { return id === "staff"; } }, () => new Date(at)) };
};

test("REPORTS_ID_CARDS only staff list or write; anyone else gets not found and nothing is read or written", async () => {
  const { store, service } = rig();
  assert.equal(await service.list("person", "needs", null, 1), undefined);
  assert.deepEqual(await service.write("person", "issue", ["a"]), { status: "not_found" });
  assert.equal(store.lists.length + store.writes.length, 0);
});

test("REPORTS_ID_CARDS a batch is valid three months from the Kuwait day, written by the staff member", async () => {
  const { store, service } = rig();
  assert.deepEqual(await service.write("staff", "issue", ["a", "b"]), { status: "ok", count: 2, expiresOn: "2027-02-20" });
  assert.deepEqual(store.writes, [{ action: "issue", people: ["a", "b"], today: "2026-11-20", expiresOn: "2027-02-20", actor: "staff" }]);
  store.refuse = [{ personId: "b", code: "not_assigned" }];
  assert.deepEqual(await service.write("staff", "renew", ["a", "b"]), { status: "refused", refusals: [{ personId: "b", code: "not_assigned" }] });
});

test("REPORTS_ID_CARDS a batch is between 1 and the cap, each person once, with a known action", async () => {
  const { store, service } = rig();
  for (const [action, people] of [["issue", []], ["issue", ["a", "a"]], ["issue", ["bad id"]], ["revoke", ["a"]],
    ["issue", Array.from({ length: ID_CARD_BATCH_MAX + 1 }, (_, i) => `p${i}`)]] as const)
    assert.deepEqual(await service.write("staff", action as IdCardAction, people), { status: "invalid" }, JSON.stringify([action, people.length]));
  assert.equal(store.writes.length, 0);
  assert.deepEqual(await service.write("staff", "issue", ["alia@example.com", "sso:p+1"]), { status: "ok", count: 2, expiresOn: "2027-02-20" }, "any principal id the access layer accepts");
  assert.deepEqual(await service.write("staff", "issue", Array.from({ length: ID_CARD_BATCH_MAX }, (_, i) => `p${i}`)), { status: "ok", count: ID_CARD_BATCH_MAX, expiresOn: "2027-02-20" });
});

test("REPORTS_ID_CARDS lists page by fifty and trim the name search", async () => {
  const { store, service } = rig();
  assert.deepEqual(await service.list("staff", "expired", "  alia  ", 3), { rows: [], total: 0, today: "2026-11-20" });
  assert.deepEqual(store.lists, [{ view: "expired", today: "2026-11-20", name: "alia", offset: 100, limit: 50 }]);
  await service.list("staff", "needs", "   ", 1);
  assert.equal(store.lists[1]?.name, null);
  await assert.rejects(service.list("staff", "all" as IdCardView, null, 1), /invalid list/);
  await assert.rejects(service.list("staff", "needs", null, 0), /invalid list/);
});

test("REPORTS_ID_CARDS a card is valid through its expiry day, in Kuwait time", async () => {
  assert.equal((await rig("2026-11-19T20:59:00Z").service.own("holder"))?.valid, true);
  assert.equal((await rig("2026-11-19T21:00:00Z").service.own("holder"))?.valid, false);
  assert.equal(await rig().service.own("nobody"), undefined);
});
