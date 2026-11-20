import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSFER_STATUS, LEGACY_TRANSFER_STATUS, TransferLifecycleService, paymentReceivedDate, transferTransition,
  type TransferStatus, type TransferAction, type TransferLifecycleStore, type TransferLifecycleTransaction,
  type LifecycleChange, type LifecycleTransfer,
} from "../src/transfer-lifecycle.js";

const actor = { principalId: "staff-synthetic", actingAs: false };
const clock = () => new Date("2026-11-18T21:30:00.000Z");
const actions: TransferAction[] = ["lock", "cancel", "payment_sent", "payment_received", "admin_revert", "admin_unlock", "complete", "reopen_after_unpaid", "delete"];
const legal: [TransferStatus, TransferAction, TransferStatus][] = [
  ["draft", "lock", "locked"], ["draft", "cancel", "cancelled"], ["locked", "payment_sent", "payment_sent"],
  ["locked", "payment_received", "distributing"], ["payment_sent", "payment_received", "distributing"],
  ["payment_sent", "admin_revert", "locked"], ["locked", "admin_unlock", "draft"],
  ["payment_sent", "admin_unlock", "draft"], ["distributing", "complete", "complete"],
  ["complete", "reopen_after_unpaid", "distributing"], ["cancelled", "delete", "cancelled"],
  ["draft", "delete", "draft"], ["locked", "delete", "locked"],
];

interface Data {
  transfer: LifecycleTransfer; childIds: string[]; invoiceIds: string[];
  invoicesPaid: boolean; cascaded: boolean; receivedOn?: string; history: LifecycleChange[];
}
/** Transaction contract double, NOT a PostgreSQL concurrency proof. */
class MemoryStore implements TransferLifecycleStore {
  data: Data; missing = false; allowed = true; unassigned: string[] = []; unpaid = false;
  failAt: "children" | "invoice" | "state" | "history" | "paid" | "cascade" | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(status: TransferStatus = "draft") {
    this.data = { transfer: { id: "transfer-1", companyId: "company-1", status, deleted: false }, childIds: [], invoiceIds: [], invoicesPaid: false, cascaded: false, history: [] };
  }
  async transaction<T>(work: (tx: TransferLifecycleTransaction) => Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await before;
    const d = structuredClone(this.data);
    const fail = (point: MemoryStore["failAt"]) => { if (this.failAt === point) throw new Error(`injected ${point}`); };
    const tx: TransferLifecycleTransaction = {
      lockTransfer: async () => this.missing ? undefined : d.transfer,
      authorize: async (_actor, _transfer, action) => this.allowed && (!action.startsWith("admin_") || _actor.principalId === "admin-synthetic"),
      unassignedPersonIds: async () => this.unassigned,
      hasUnpaidLines: async () => this.unpaid,
      ensureChildrenAndInvoices: async () => {
        if (!d.childIds.length) d.childIds.push("child-1"); fail("children");
        if (!d.invoiceIds.length) d.invoiceIds.push("invoice-1"); fail("invoice");
      },
      markInvoicesPaid: async () => { d.invoicesPaid = true; fail("paid"); },
      softDeleteGroup: async () => { d.transfer = { ...d.transfer, deleted: true }; d.cascaded = true; fail("cascade"); },
      setState: async (_id, status, receivedOn) => { d.transfer = { ...d.transfer, status }; if (receivedOn !== undefined) d.receivedOn = receivedOn; fail("state"); },
      appendHistory: async (change) => { d.history.push(change); fail("history"); },
    };
    try { const result = await work(tx); this.data = d; return result; }
    finally { release(); }
  }
}
const admin = { principalId: "admin-synthetic", actingAs: false };

for (const status of Object.values(TRANSFER_STATUS)) {
  for (const action of actions) {
    test(`matrix ${status} / ${action}`, async () => {
      const expected = legal.find(([from, command]) => from === status && command === action)?.[2];
      assert.equal(transferTransition(status, action), expected);
      const store = new MemoryStore(status); store.unpaid = action === "reopen_after_unpaid";
      const original = structuredClone(store.data);
      const result = await new TransferLifecycleService(store, clock).transition(admin, "transfer-1", action);
      if (expected === undefined) {
        assert.deepEqual(result, { kind: "refused", code: "invalid_transition" });
        assert.deepEqual(store.data, original);
      } else {
        assert.equal(result.kind, "changed"); assert.equal(store.data.transfer.status, expected);
        assert.equal(store.data.history.length, 1);
        assert.equal(store.data.transfer.deleted, action === "delete");
        assert.equal(store.data.cascaded, action === "delete");
        assert.equal(store.data.invoicesPaid, action === "payment_received");
        assert.equal(store.data.receivedOn, action === "payment_received" ? "2026-11-19" : undefined);
      }
    });
  }
}

test("legacy numeric status mapping remains explicit", () => {
  assert.deepEqual(LEGACY_TRANSFER_STATUS, { draft: 10, locked: 5, payment_sent: 1, distributing: 3, complete: 4, cancelled: 0 });
});
test("Kuwait receipt date turns at 21:00Z", () => {
  assert.equal(paymentReceivedDate(new Date("2026-11-18T20:59:59Z")), "2026-11-18");
  assert.equal(paymentReceivedDate(new Date("2026-11-18T21:00:00Z")), "2026-11-19");
});
test("unassigned people refused before child or invoice effects; details unique and sorted", async () => {
  const store = new MemoryStore(); store.unassigned = ["p2", "p1", "p2"];
  const before = structuredClone(store.data);
  assert.deepEqual(await new TransferLifecycleService(store, clock).transition(actor, "transfer-1", "lock"), { kind: "refused", code: "unassigned_people", personIds: ["p1", "p2"] });
  assert.deepEqual(store.data, before);
});
test("complete requires all lines paid; reopen requires an actual unpaid line", async () => {
  for (const [status, action, unpaid, code] of [["distributing", "complete", true, "unpaid_lines"], ["complete", "reopen_after_unpaid", false, "no_unpaid_lines"]] as const) {
    const store = new MemoryStore(status); store.unpaid = unpaid; const before = structuredClone(store.data);
    assert.deepEqual(await new TransferLifecycleService(store, clock).transition(actor, "transfer-1", action), { kind: "refused", code });
    assert.deepEqual(store.data, before);
  }
});
test("permission denial and act-as expose no membership details and mutate nothing", async () => {
  for (const actingAs of [false, true]) {
    const store = new MemoryStore(); store.allowed = actingAs; store.unassigned = ["private-person"];
    const before = structuredClone(store.data);
    assert.deepEqual(await new TransferLifecycleService(store, clock).transition({ ...actor, actingAs }, "transfer-1", "lock"), { kind: "refused", code: actingAs ? "forbidden" : "not_found" });
    assert.deepEqual(store.data, before);
  }
});
test("admin revert/unlock must be authorized as separate capabilities", async () => {
  for (const action of ["admin_revert", "admin_unlock"] as const) {
    const store = new MemoryStore("payment_sent");
    assert.deepEqual(await new TransferLifecycleService(store, clock).transition(actor, "transfer-1", action), { kind: "refused", code: "not_found" });
    assert.equal(store.data.transfer.status, "payment_sent");
  }
});
test("missing and soft deleted transfers refuse", async () => {
  for (const missing of [true, false]) {
    const store = new MemoryStore(); store.missing = missing;
    if (!missing) store.data.transfer = { ...store.data.transfer, deleted: true };
    assert.deepEqual(await new TransferLifecycleService(store, clock).transition(actor, "transfer-1", "lock"), { kind: "refused", code: "not_found" });
  }
});
for (const point of ["children", "invoice", "state", "history"] as const) {
  test(`late lock failure at ${point} rolls back and retry succeeds`, async () => {
    const store = new MemoryStore(); store.failAt = point; const before = structuredClone(store.data);
    const service = new TransferLifecycleService(store, clock);
    await assert.rejects(service.transition(actor, "transfer-1", "lock"), /injected/);
    assert.deepEqual(store.data, before);
    store.failAt = null; assert.equal((await service.transition(actor, "transfer-1", "lock")).kind, "changed");
    assert.equal(store.data.childIds.length, 1); assert.equal(store.data.invoiceIds.length, 1);
  });
}
test("serialized double lock and unlock/relock reuse child and invoice identities", async () => {
  const store = new MemoryStore(); const service = new TransferLifecycleService(store, clock);
  const outcomes = await Promise.all([service.transition(actor, "transfer-1", "lock"), service.transition(actor, "transfer-1", "lock")]);
  assert.equal(outcomes.filter(x => x.kind === "changed").length, 1);
  assert.deepEqual(outcomes[1], { kind: "refused", code: "invalid_transition" });
  assert.equal(store.data.history.length, 1);
  await service.transition(admin, "transfer-1", "admin_unlock");
  await service.transition(actor, "transfer-1", "lock");
  assert.deepEqual(store.data.childIds, ["child-1"]); assert.deepEqual(store.data.invoiceIds, ["invoice-1"]);
});
test("receipt and delete rollback if transactional adapters fail", async () => {
  for (const [action, point] of [["payment_received", "paid"], ["delete", "cascade"], ["payment_received", "history"]] as const) {
    const store = new MemoryStore("locked"); store.failAt = point; const before = structuredClone(store.data);
    await assert.rejects(new TransferLifecycleService(store, clock).transition(actor, "transfer-1", action), /injected/);
    assert.deepEqual(store.data, before);
  }
});
test("unknown command and empty identifiers refuse without touching state", async () => {
  const store = new MemoryStore(); const service = new TransferLifecycleService(store, clock);
  for (const [id, action] of [["", "lock"], ["transfer-1", "toString"], ["transfer-1", "bogus"]]) {
    assert.deepEqual(await service.transition(actor, id!, action as TransferAction), { kind: "refused", code: "invalid_input" });
  }
  assert.equal(store.data.history.length, 0);
});

test("an authorized command retains its original identity while awaiting a transaction", async () => {
  const input = { ...actor };
  const backing = new MemoryStore("draft");
  const delayed: TransferLifecycleStore = {
    async transaction<T>(work: (tx: TransferLifecycleTransaction) => Promise<T>): Promise<T> {
      await Promise.resolve();
      return backing.transaction(work);
    },
  };
  const operation = new TransferLifecycleService(delayed, clock).transition(input, "transfer-1", "lock");
  input.principalId = "later-local-edit";
  const result = await operation;
  assert.equal(result.kind, "changed");
  assert.equal(backing.data.history[0]?.actorId, actor.principalId);
});
