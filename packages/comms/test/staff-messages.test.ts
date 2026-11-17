import assert from "node:assert/strict";
import { test } from "node:test";
import { StaffMessagesService, renderStaffMessage, validateStaffMessage, type StaffMessageDraft, type StaffMessageStore } from "../src/staff-messages.js";

const staff = { async isStaff(id: string) { return id === "staff-1"; } };
function memoryStore(): StaffMessageStore & { drafts: StaffMessageDraft[] } {
  const drafts: StaffMessageDraft[] = [];
  return {
    drafts,
    async send(draft) {
      const first = drafts.find(d => d.sendKey === draft.sendKey);
      if (!first) { drafts.push(draft); return { status: "sent", id: `m${drafts.length}` }; }
      return first.recipientPrincipalId === draft.recipientPrincipalId && first.kind === draft.kind && first.body === draft.body
        ? { status: "already_sent", id: `m${drafts.indexOf(first) + 1}` } : { status: "send_key_conflict" };
    },
  };
}

test("COMMS_STAFF_MSG_AUTH only staff can send, and nothing is stored for anyone else", async () => {
  const store = memoryStore();
  const service = new StaffMessagesService(store, staff);
  assert.deepEqual(await service.send("person-2", { recipientPrincipalId: "person-1", kind: "civil_id_request", sendKey: "k1" }), { status: "forbidden" });
  assert.equal(store.drafts.length, 0);
  assert.deepEqual(await service.send("staff-1", { recipientPrincipalId: "person-1", kind: "civil_id_request", sendKey: "k1" }), { status: "sent", id: "m1" });
  assert.equal(store.drafts[0]!.senderPrincipalId, "staff-1");
});

test("COMMS_STAFF_MSG_ONCE a repeat send key returns already_sent and stores one message", async () => {
  const store = memoryStore();
  const service = new StaffMessagesService(store, staff);
  const input = { recipientPrincipalId: "person-1", kind: "message", body: "  Please call the office.  ", sendKey: "key-1" };
  assert.deepEqual(await service.send("staff-1", input), { status: "sent", id: "m1" });
  assert.deepEqual(await service.send("staff-1", input), { status: "already_sent", id: "m1" });
  assert.equal(store.drafts.length, 1);
  assert.equal(store.drafts[0]!.body, "Please call the office.");
  assert.deepEqual(await service.send("staff-1", { ...input, recipientPrincipalId: "person-2" }), { status: "send_key_conflict" });
});

test("COMMS_STAFF_MSG_VALIDATE kinds, bodies, keys and recipients are closed", () => {
  const ok = { recipientPrincipalId: "person-1", sendKey: "k" };
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "chat" }), { field: "kind" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "message", body: "   " }), { field: "body" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "message" }), { field: "body" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "message", body: "x".repeat(2001) }), { field: "body" });
  assert.equal("field" in validateStaffMessage("s", { ...ok, kind: "message", body: "x".repeat(2000) }), false);
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "profile_photo_request", body: "extra" }), { field: "body" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "civil_id_request", sendKey: "" }), { field: "send_key" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "civil_id_request", sendKey: "a b" }), { field: "send_key" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "civil_id_request", recipientPrincipalId: "" }), { field: "recipient" });
  assert.deepEqual(validateStaffMessage("s", { ...ok, kind: "civil_id_request" }), { recipientPrincipalId: "person-1", senderPrincipalId: "s", kind: "civil_id_request", body: null, sendKey: "k" });
});

test("COMMS_STAFF_MSG_RENDER each kind points the person at the page that resolves it", () => {
  assert.deepEqual(renderStaffMessage("profile_photo_request", null), { text: "StudentHub asked you to add a profile photo.", href: "/profile" });
  assert.deepEqual(renderStaffMessage("civil_id_request", null), { text: "StudentHub asked you to add your civil ID.", href: "/profile/civil-id" });
  assert.deepEqual(renderStaffMessage("message", "Hello"), { text: "Message from StudentHub: Hello", href: "/notifications" });
});
